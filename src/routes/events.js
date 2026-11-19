'use strict';

// Events page: what happened (grid and generator on/off, battery levels, custom events) and the
// patterns in it. Everyone signed in can look; admins choose the battery levels and custom events.
const express = require('express');
const auth = require('../auth');
const events = require('../events');
const automations = require('../automations');

const router = express.Router();

router.get('/', async (req, res) => {
  const data = await events.build({ stationId: req.query.station, from: parseInt(req.query.from, 10), to: parseInt(req.query.to, 10) });
  res.json({ ...data, powerNodes: automations.POWER_NODES.map((k) => ({ key: k, label: automations.NODE_LABELS[k] })), canEdit: Boolean(req.user.is_admin) });
});

router.use(auth.requireAdmin);

router.put('/levels', async (req, res) => {
  res.json({ levels: await events.setLevels(req.body && req.body.levels) });
});

router.post('/rules', async (req, res) => {
  res.json({ id: await events.saveRule(null, req.body || {}, req.user.username) });
});

router.put('/rules/:id', async (req, res) => {
  res.json({ id: await events.saveRule(parseInt(req.params.id, 10) || 0, req.body || {}) });
});

router.delete('/rules/:id', async (req, res) => {
  await events.deleteRule(parseInt(req.params.id, 10) || 0);
  res.json({ ok: true });
});

module.exports = router;
