import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, name: user.name },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

// Long-lived tokens are deliberate: a student who is offline for a week must
// not be logged out and forced through a network round-trip to read the
// lectures already sitting on their device.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'authentication required' });

  try {
    req.auth = jwt.verify(token, env.jwtSecret);
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({ error: expired ? 'token expired' : 'invalid token' });
  }
}

// Media auth.
//
// An <img>, <video> or <audio> tag cannot send an Authorization header, so
// media requests carry the token as a query parameter instead. This is the
// same token and the same verification: only where it is carried differs.
//
// The header is still preferred when present, which is what the download
// manager uses, since a token in a URL can end up in proxy and server logs.
export function requireMediaAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.t;
  if (!token) return res.status(401).json({ error: 'authentication required' });

  try {
    req.auth = jwt.verify(String(token), env.jwtSecret);
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({ error: expired ? 'token expired' : 'invalid token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'authentication required' });
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ error: `requires role: ${roles.join(' or ')}` });
    }
    return next();
  };
}

// Loads the full user document for handlers that need more than the token claims.
export async function loadUser(req, res, next) {
  try {
    const user = await User.findById(req.auth.sub);
    if (!user) return res.status(401).json({ error: 'user no longer exists' });
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

export default { signToken, requireAuth, requireMediaAuth, requireRole, loadUser };
