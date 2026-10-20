'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const settings = require('./settings');
const config = require('./config');

const COOKIE = 'deye_session';
const SHORT_TTL = 12 * 3600;
const LONG_TTL = 30 * 24 * 3600;

let secretPromise = null;
function getSecret() {
  if (!secretPromise) {
    secretPromise = settings.getOrCreateSecret('session_secret', config.sessionSecret).catch((err) => {
      secretPromise = null;
      throw err;
    });
  }
  return secretPromise;
}

// A fingerprint of the password hash is embedded in the token, so changing the
// password signs out every existing session for that user.
function passwordFingerprint(hash) {
  return crypto.createHash('sha256').update(hash).digest('base64url').slice(0, 12);
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function cookieString(req, value, maxAge) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

async function issueSession(req, res, user, remember) {
  const ttl = remember ? LONG_TTL : SHORT_TTL;
  const secret = await getSecret();
  const token = sign(
    { uid: user.id, pf: passwordFingerprint(user.password_hash), exp: Math.floor(Date.now() / 1000) + ttl },
    secret
  );
  res.setHeader('Set-Cookie', cookieString(req, token, remember ? ttl : undefined));
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', cookieString(req, '', 0));
}

async function loadUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const payload = verify(token, await getSecret());
  if (!payload) return null;
  const user = await db.one(
    'SELECT id, username, password_hash, is_admin, must_change_password FROM users WHERE id = ?',
    [payload.uid]
  );
  if (!user || passwordFingerprint(user.password_hash) !== payload.pf) return null;
  return user;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    isAdmin: Boolean(u.is_admin),
    mustChangePassword: Boolean(u.must_change_password),
  };
}

function requireAuth(req, res, next) {
  loadUser(req)
    .then((user) => {
      if (!user) return res.status(401).json({ error: 'Not signed in' });
      req.user = user;
      next();
    })
    .catch(next);
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// Cross-site requests cannot set custom headers without a CORS preflight, which
// this server never approves; together with SameSite=Lax cookies this blocks CSRF.
function requireAjaxHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'DeyeMonitor') {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  next();
}

// Simple in-memory brute-force protection for the login endpoint.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  let entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    entry = { count: 0, reset: now + WINDOW_MS };
    attempts.set(key, entry);
  }
  if (entry.count >= MAX_ATTEMPTS) {
    const wait = Math.ceil((entry.reset - now) / 60000);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${wait} minute(s).` });
  }
  entry.count += 1;
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  }
  next();
}

function resetRateLimit(req) {
  attempts.delete(req.ip || 'unknown');
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(String(plain || ''), hash);
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

module.exports = {
  issueSession,
  clearSession,
  loadUser,
  publicUser,
  requireAuth,
  requireAdmin,
  requireAjaxHeader,
  loginRateLimit,
  resetRateLimit,
  verifyPassword,
  hashPassword,
};
