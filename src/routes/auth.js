import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { query } from '../config/database.js';
import { authenticate, signToken } from '../middlewares/auth.js';
import { createRateLimiter } from '../middlewares/rate-limit.js';

const router = Router();

// Initialize Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const BCRYPT_COST = 12;
const ADMIN_SESSION = process.env.ADMIN_JWT_EXPIRES_IN || '12h';

// Compared against when an email isn't registered, so the response time doesn't
// reveal which emails have accounts
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s\-()]{7,20}$/;

const asString = (value) => (typeof value === 'string' ? value : '');
const normalizeEmail = (value) => asString(value).trim().toLowerCase();

const publicUser = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  phone: row.phone ?? null,
  role: row.role,
});

/* ------------------------------- rate limiting ------------------------------ */

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const accountKey = (req) => `${req.ip}|${normalizeEmail(req.body?.email)}`;

// Customer sign-in: generous per address, strict per address + email
const loginByIp = createRateLimiter({
  windowMs: FIFTEEN_MINUTES,
  max: 30,
  message: 'Too many sign-in attempts.',
});
const loginByAccount = createRateLimiter({
  windowMs: FIFTEEN_MINUTES,
  max: 8,
  key: accountKey,
  message: 'Too many failed sign-in attempts for this account.',
});

// Admin sign-in is stricter still
const adminLoginByIp = createRateLimiter({
  windowMs: FIFTEEN_MINUTES,
  max: 15,
  message: 'Too many sign-in attempts.',
});
const adminLoginByAccount = createRateLimiter({
  windowMs: FIFTEEN_MINUTES,
  max: 5,
  key: accountKey,
  message: 'Too many failed sign-in attempts for this account.',
});

const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many sign-up attempts.',
});

/* ---------------------------------- routes ---------------------------------- */

// Register
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = asString(req.body?.password);
    const name = asString(req.body?.name).trim();
    const phone = asString(req.body?.phone).trim();

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    // bcrypt only uses the first 72 bytes, so longer passwords would be silently cut
    if (Buffer.byteLength(password) > 72) {
      return res.status(400).json({ error: 'Password is too long (72 characters at most)' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'Name is too long' });
    }
    if (phone && !PHONE_RE.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number' });
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const result = await query(
      `INSERT INTO users (email, password_hash, name, phone, role)
       VALUES ($1, $2, $3, $4, 'customer')
       RETURNING id, email, name, phone, role`,
      [email, passwordHash, name, phone || null]
    );

    const user = result.rows[0];
    res.status(201).json({ user: publicUser(user), token: signToken(user.id) });
  } catch (error) {
    // Two sign-ups with the same email at the same moment
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already registered' });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login
router.post('/login', loginByIp, loginByAccount, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = asString(req.body?.password);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await query(
      'SELECT id, email, password_hash, name, phone, role FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];

    // Account created with Google: there's no password to check
    if (user && !user.password_hash) {
      return res.status(401).json({
        error: 'This account uses Google Sign-In. Please sign in with Google.',
      });
    }

    // Always run a comparison, even for unknown emails, so timing doesn't leak
    const validPassword = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    loginByAccount.reset(req);
    res.json({ user: publicUser(user), token: signToken(user.id) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Google OAuth
router.post('/google', loginByIp, async (req, res) => {
  try {
    const credential = asString(req.body?.credential);
    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Invalid Google credential' });
    }

    // An unverified Google email must never be matched to an existing account
    if (!payload?.email || payload.email_verified !== true) {
      return res.status(401).json({ error: 'Your Google email address is not verified' });
    }

    const { name, picture, sub: googleId } = payload;
    const email = payload.email.toLowerCase();

    const existing = await query(
      'SELECT id, email, name, phone, role, google_id FROM users WHERE email = $1',
      [email]
    );

    let user;

    if (existing.rows.length > 0) {
      user = existing.rows[0];

      if (user.google_id && user.google_id !== googleId) {
        return res
          .status(401)
          .json({ error: 'This account is linked to a different Google account' });
      }

      if (!user.google_id) {
        // Admin accounts sign in with their password; never link them automatically
        if (user.role === 'admin') {
          return res.status(403).json({
            error: 'Admin accounts must sign in with email and password',
          });
        }
        await query('UPDATE users SET google_id = $1, avatar_url = $2 WHERE id = $3', [
          googleId,
          picture ?? null,
          user.id,
        ]);
      }
    } else {
      const created = await query(
        `INSERT INTO users (email, name, google_id, avatar_url, role)
         VALUES ($1, $2, $3, $4, 'customer')
         RETURNING id, email, name, phone, role`,
        [email, name || email, googleId, picture ?? null]
      );
      user = created.rows[0];
    }

    res.json({ user: publicUser(user), token: signToken(user.id) });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Failed to authenticate with Google' });
  }
});

// Admin login: shorter sessions, stricter limits, and one generic error for every failure
router.post('/admin/login', adminLoginByIp, adminLoginByAccount, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = asString(req.body?.password);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await query(
      `SELECT id, email, password_hash, name, phone, role
       FROM users WHERE email = $1 AND role = 'admin'`,
      [email]
    );
    const user = result.rows[0];

    // Unknown email, non-admin, or an admin without a password all look the same
    const validPassword = await bcrypt.compare(
      password,
      user?.password_hash ?? DUMMY_HASH
    );
    if (!user || !user.password_hash || !validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    adminLoginByAccount.reset(req);

    const token = signToken(user.id, ADMIN_SESSION);
    const { exp } = jwt.decode(token);

    res.json({
      user: publicUser(user),
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Get current user
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

export default router;
