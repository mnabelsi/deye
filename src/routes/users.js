'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();
router.use(auth.requireAdmin);

router.get('/', async (req, res) => {
  const rows = await db.query(
    'SELECT id, username, is_admin, created_at, last_login_at FROM users ORDER BY username'
  );
  res.json({
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      isAdmin: Boolean(r.is_admin),
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    })),
  });
});

router.post('/', async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const isAdmin = req.body && req.body.isAdmin ? 1 : 0;
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-64 characters (letters, digits, _ . @ -)' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const exists = await db.one('SELECT id FROM users WHERE username = ?', [username]);
  if (exists) return res.status(409).json({ error: 'Username already exists' });
  await db.query('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)', [
    username,
    await auth.hashPassword(password),
    isAdmin,
  ]);
  res.json({ ok: true });
});

router.post('/:id/password', async (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const result = await db.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [
    await auth.hashPassword(password),
    Number(req.params.id),
  ]);
  if (!result.affectedRows) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const admins = await db.one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id <> ?', [id]);
  if (!admins.n) return res.status(400).json({ error: 'At least one admin must remain' });
  await db.query('DELETE FROM users WHERE id = ?', [id]);
  res.json({ ok: true });
});

module.exports = router;
