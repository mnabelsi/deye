'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

router.post('/login', auth.loginRateLimit, async (req, res) => {
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const user = await db.one('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
  if (!user || !(await auth.verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  auth.resetRateLimit(req);
  await db.query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  await auth.issueSession(req, res, user, Boolean(remember));
  res.json({ user: auth.publicUser(user) });
});

router.post('/logout', (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});

// Answers 200 with user: null when signed out, so the login page loads without console errors.
router.get('/me', async (req, res) => {
  const user = await auth.loadUser(req);
  res.json({ user: user ? auth.publicUser(user) : null });
});

router.post('/password', auth.requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await auth.verifyPassword(currentPassword, req.user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const hash = await auth.hashPassword(newPassword);
  await db.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, req.user.id]);
  const user = await db.one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  await auth.issueSession(req, res, user, true);
  res.json({ ok: true });
});

module.exports = router;
