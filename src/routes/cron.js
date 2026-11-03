'use strict';

const crypto = require('crypto');
const express = require('express');
const settings = require('../settings');
const config = require('../config');
const collector = require('../collector');
const ewelink = require('../ewelink');
const automations = require('../automations');

const router = express.Router();

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// GET or POST /api/cron/collect?key=SECRET — for hosting cron jobs (wget/curl).
router.all('/collect', async (req, res) => {
  const expected = await settings.getOrCreateSecret('cron_key', config.cronKey);
  const given = req.query.key || req.get('X-Cron-Key');
  if (!safeEqual(given, expected)) return res.status(403).json({ error: 'Invalid cron key' });
  const r = await collector.tick({ trigger: 'cron', force: req.query.force === '1' });
  // Smart devices and automations ride along, so they keep working when the host idles the app.
  r.ewelink = await ewelink.tick({ trigger: 'cron' }).catch((err) => ({ status: 'error', message: err.message }));
  r.automations = await automations.tick().catch((err) => ({ status: 'error', message: err.message }));
  res.json(r);
});

module.exports = router;
