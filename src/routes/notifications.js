'use strict';

// Notifications page: the WAHA (WhatsApp) server, who gets messages, quiet hours, the rules and
// what was sent. Admins only, since it holds phone numbers and the WAHA API key.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const waha = require('../waha');
const notifications = require('../notifications');
const automations = require('../automations');

const router = express.Router();
router.use(auth.requireAdmin);
const nowSec = () => Math.floor(Date.now() / 1000);

async function find(id) {
  const row = await db.one('SELECT * FROM notification_rules WHERE id = ?', [parseInt(id, 10) || 0]);
  if (!row) {
    const err = new Error('Notification not found');
    err.status = 404;
    throw err;
  }
  return row;
}

async function wahaView() {
  const c = await settings.getWahaConfig();
  return { url: c.url, apiKeySet: Boolean(c.apiKey), session: c.session, configured: Boolean(c.url) };
}

/** The form's values merged with what is saved: an empty API key keeps the saved one. */
async function mergeWaha(input) {
  const cur = await settings.getWahaConfig();
  const d = input || {};
  const url = d.url === undefined ? cur.url : String(d.url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
    const err = new Error('The WAHA address must start with http:// or https://');
    err.status = 400;
    throw err;
  }
  return {
    url,
    apiKey: d.clearApiKey ? '' : d.apiKey ? String(d.apiKey).trim() : cur.apiKey,
    session: String(d.session === undefined ? cur.session : d.session || '').trim().slice(0, 64) || 'default',
  };
}

function logRow(r) {
  let to = [];
  try {
    to = JSON.parse(r.recipients || '[]');
  } catch {
    to = [];
  }
  return { id: r.id, ruleId: r.rule_id, ruleName: r.rule_name, kind: r.kind, ts: r.ts, to: to.map((x) => x.name), text: r.text, status: r.status, message: r.message, sentTs: r.sent_ts };
}

router.get('/', async (req, res) => {
  const rows = await db.query('SELECT * FROM notification_rules ORDER BY sort_index, id');
  const log = await db.query('SELECT * FROM notification_log ORDER BY id DESC LIMIT ?', [Math.min(500, Math.max(10, parseInt(req.query.log, 10) || 150))]);
  const autos = await db.query('SELECT id, name FROM automations ORDER BY sort_index, id');
  const tz = await automations.timeZone();
  res.json({
    waha: await wahaView(),
    options: await notifications.options(),
    recipients: await notifications.recipients(),
    rules: rows.map(notifications.toApi),
    log: log.map(logRow),
    automations: autos,
    placeholders: notifications.PLACEHOLDERS,
    timeZone: tz.timeZone,
    powerNodes: automations.POWER_NODES.map((k) => ({ key: k, label: automations.NODE_LABELS[k] })),
  });
});

router.put('/waha', async (req, res) => {
  const c = await mergeWaha(req.body);
  await settings.set({ waha_url: c.url, waha_api_key: c.apiKey, waha_session: c.session });
  res.json({ waha: await wahaView() });
});

// Checks the server and the session with the values in the form (saved or not).
router.post('/waha/test', async (req, res) => {
  const c = await mergeWaha(req.body);
  try {
    const session = await waha.sessionStatus(c);
    const version = await waha.version(c);
    res.json({ ok: session.status === 'WORKING', session, version: version && (version.version || null), engine: (version && version.engine) || session.engine });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/waha/groups', async (req, res) => {
  try {
    res.json({ groups: await waha.groups(await settings.getWahaConfig()) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/waha/check', async (req, res) => {
  try {
    res.json(await waha.checkNumber(await settings.getWahaConfig(), req.body && req.body.number));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/options', async (req, res) => {
  res.json({ options: await notifications.saveOptions(req.body) });
});

router.put('/recipients', async (req, res) => {
  res.json({ recipients: await notifications.saveRecipients(req.body && req.body.recipients) });
});

// A plain test message, to check that messages arrive.
router.post('/test', async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim() || '✅ Test from your Deye Solar Monitor. WhatsApp notifications work.';
  try {
    res.json(await notifications.sendTest({ text, recipientIds: Array.isArray(b.recipientIds) ? b.recipientIds.map(String) : null }));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// What a rule (saved or a draft in the editor) would send right now. Never sends.
router.post('/preview', async (req, res) => {
  res.json(await notifications.preview(req.body || {}));
});

router.post('/rules', async (req, res) => {
  const r = notifications.cleanRule(req.body);
  const now = nowSec();
  const max = await db.one('SELECT COALESCE(MAX(sort_index), 0) AS n FROM notification_rules');
  const ins = await db.query(
    'INSERT INTO notification_rules (name, enabled, rule, sort_index, created_by, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [r.name, r.enabled ? 1 : 0, JSON.stringify(r.rule), Number(max.n) + 1, req.user.username, now, now]
  );
  res.json({ rule: notifications.toApi(await find(ins.insertId)) });
});

// Saving a changed rule starts it afresh: it notes what it sees now and reports changes from there.
router.put('/rules/:id', async (req, res) => {
  const row = await find(req.params.id);
  const r = notifications.cleanRule(req.body);
  await db.query('UPDATE notification_rules SET name = ?, enabled = ?, rule = ?, state = NULL, last_note = NULL, updated_ts = ? WHERE id = ?', [r.name, r.enabled ? 1 : 0, JSON.stringify(r.rule), nowSec(), row.id]);
  res.json({ rule: notifications.toApi(await find(row.id)) });
});

router.post('/rules/:id/enabled', async (req, res) => {
  const row = await find(req.params.id);
  await db.query('UPDATE notification_rules SET enabled = ?, state = NULL, last_note = NULL, updated_ts = ? WHERE id = ?', [req.body && req.body.enabled ? 1 : 0, nowSec(), row.id]);
  res.json({ rule: notifications.toApi(await find(row.id)) });
});

router.post('/rules/:id/test', async (req, res) => {
  const row = await find(req.params.id);
  try {
    res.json(await notifications.testRule(row.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/rules/:id', async (req, res) => {
  const row = await find(req.params.id);
  await db.query('DELETE FROM notification_rules WHERE id = ?', [row.id]);
  res.json({ ok: true });
});

router.delete('/log', async (req, res) => {
  await db.query("DELETE FROM notification_log WHERE status NOT IN ('pending', 'held')");
  res.json({ ok: true });
});

module.exports = router;
