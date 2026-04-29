import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { query } from '../config/database.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();

// Initialize Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper to generate JWT
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if user exists
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query(
      'INSERT INTO users (email, password_hash, name, phone, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, phone, role',
      [email.toLowerCase(), passwordHash, name, phone || null, 'customer']
    );

    const user = result.rows[0];
    const token = generateToken(user.id);

    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const result = await query(
      'SELECT id, email, password_hash, name, phone, role FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Check if user signed up with Google (no password)
    if (!user.password_hash) {
      return res.status(401).json({ 
        error: 'This account uses Google Sign-In. Please sign in with Google.' 
      });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user.id);
    delete user.password_hash;

    res.json({ user, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Google OAuth
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    // Verify Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;

    // Check if user exists
    let result = await query(
      'SELECT id, email, name, phone, role, google_id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    let user;

    if (result.rows.length > 0) {
      user = result.rows[0];
      
      // Update Google ID if not set
      if (!user.google_id) {
        await query(
          'UPDATE users SET google_id = $1, avatar_url = $2 WHERE id = $3',
          [googleId, picture, user.id]
        );
      }
    } else {
      // Create new user
      result = await query(
        'INSERT INTO users (email, name, google_id, avatar_url, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, phone, role',
        [email.toLowerCase(), name, googleId, picture, 'customer']
      );
      user = result.rows[0];
    }

    const token = generateToken(user.id);
    delete user.google_id;

    res.json({ user, token });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Failed to authenticate with Google' });
  }
});

// Admin login
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find admin user
    const result = await query(
      'SELECT id, email, password_hash, name, phone, role FROM users WHERE email = $1 AND role = $2',
      [email.toLowerCase(), 'admin']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials or not an admin' });
    }

    const user = result.rows[0];

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user.id);
    delete user.password_hash;

    res.json({ user, token });
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
