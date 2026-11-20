import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';

// Pinning the algorithm means a token can never be accepted under a weaker one
const ALGORITHM = 'HS256';

/** Signs a login token for a user. Admin sessions pass a shorter expiry. */
export const signToken = (userId, expiresIn = process.env.JWT_EXPIRES_IN || '7d') =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { algorithm: ALGORITHM, expiresIn });

const bearerToken = (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
};

// Reads the token and loads the user fresh from the database, so a changed
// role or a deleted account takes effect immediately.
async function loadUser(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [ALGORITHM] });
  if (typeof decoded.userId !== 'string') {
    const error = new Error('Malformed token');
    error.name = 'JsonWebTokenError';
    throw error;
  }

  const result = await query(
    'SELECT id, email, name, phone, role FROM users WHERE id = $1',
    [decoded.userId]
  );
  return result.rows[0] ?? null;
}

export const authenticate = async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const user = await loadUser(token);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (error.name === 'JsonWebTokenError' || error.name === 'NotBeforeError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    console.error('Authentication error:', error.message);
    return res.status(500).json({ error: 'Authentication error' });
  }
};

// Attaches req.user when a valid token is sent; carries on as a guest otherwise
export const optionalAuth = async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (token) {
      const user = await loadUser(token);
      if (user) req.user = user;
    }
  } catch {
    // A bad or expired token just means "not logged in" here
  }
  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
