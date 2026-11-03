'use strict';

// Automations page: everyone signed in can see the rules and what they did; admins create, change,
// check and run them.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const automations = require('../automations');

const router = express.Router();
const nowSec = () => Math.floor(Date.now() / 1000);

async function find(id) {
  const row = await db.one('SELECT * FROM automations WHERE id = ?', [parseInt(id, 10) || 0]);
  if (!row) {
    const err = new Error('Automation not found');
    err.status = 404;
    throw err;
  }
  return row;
}

router.get('/', async (req, res) => {
  const rows = await db.query('SELECT * FROM automations ORDER BY sort_index, id');
  const runs = await db.query(
    `SELECT r.*, a.name FROM automation_runs r LEFT JOIN automations a ON a.id = r.automation_id ORDER BY r.id DESC LIMIT ?`,
    [Math.min(500, Math.max(10, parseInt(req.query.runs, 10) || 100))]
  );
  res.json({
    automations: rows.map(automations.toApi),
    runs: runs.map((r) => ({ id: r.id, automationId: r.automation_id, name: r.name || `#${r.automation_id}`, ts: r.ts, branch: r.branch, status: r.status, reason: r.reason, message: r.message })),
    paused: (await settings.get('automations_enabled')) === '0',
    powerNodes: automations.POWER_NODES.map((k) => ({ key: k, label: automations.NODE_LABELS[k] })),
    canEdit: Boolean(req.user.is_admin),
  });
});

router.use(auth.requireAdmin);

// What each condition sees right now (for a saved rule or a draft in the editor). Never acts.
router.post('/check', async (req, res) => {
  res.json(await automations.check(req.body || {}));
});

router.post('/', async (req, res) => {
  const r = automations.cleanRule(req.body);
  const now = nowSec();
  const max = await db.one('SELECT COALESCE(MAX(sort_index), 0) AS n FROM automations');
  const ins = await db.query(
    'INSERT INTO automations (name, enabled, rule, sort_index, created_by, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [r.name, r.enabled ? 1 : 0, JSON.stringify(r.rule), Number(max.n) + 1, req.user.username, now, now]
  );
  res.json({ automation: automations.toApi(await find(ins.insertId)) });
});

// Saving a changed rule starts it afresh: it acts on the conditions as they are now.
router.put('/:id', async (req, res) => {
  const row = await find(req.params.id);
  const r = automations.cleanRule(req.body);
  await db.query(
    'UPDATE automations SET name = ?, enabled = ?, rule = ?, matching = NULL, matching_since = NULL, fired = NULL, fired_ts = NULL, last_note = NULL, updated_ts = ? WHERE id = ?',
    [r.name, r.enabled ? 1 : 0, JSON.stringify(r.rule), nowSec(), row.id]
  );
  res.json({ automation: automations.toApi(await find(row.id)) });
});

router.post('/:id/enabled', async (req, res) => {
  const row = await find(req.params.id);
  const on = Boolean(req.body && req.body.enabled);
  await db.query('UPDATE automations SET enabled = ?, matching = NULL, matching_since = NULL, fired = NULL, fired_ts = NULL, last_note = NULL, updated_ts = ? WHERE id = ?', [
    on ? 1 : 0,
    nowSec(),
    row.id,
  ]);
  res.json({ automation: automations.toApi(await find(row.id)) });
});

router.post('/:id/run', async (req, res) => {
  const row = await find(req.params.id);
  res.json(await automations.runNow(row.id, req.body && req.body.branch === 'else' ? 'else' : 'then'));
});

router.delete('/:id', async (req, res) => {
  const row = await find(req.params.id);
  await db.query('DELETE FROM automations WHERE id = ?', [row.id]);
  await db.query('DELETE FROM automation_runs WHERE automation_id = ?', [row.id]);
  res.json({ ok: true });
});

// Pauses or resumes every automation at once.
router.post('/paused', async (req, res) => {
  await settings.set({ automations_enabled: req.body && req.body.paused ? '0' : '1' });
  res.json({ paused: Boolean(req.body && req.body.paused) });
});

module.exports = router;
