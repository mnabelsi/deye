'use strict';

const crypto = require('crypto');
const express = require('express');
const settings = require('../settings');
const auth = require('../auth');
const config = require('../config');
const collector = require('../collector');

const router = express.Router();
router.use(auth.requireAdmin);

function intIn(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

async function cronUrl(req) {
  const key = await settings.getOrCreateSecret('cron_key', config.cronKey);
  return `${req.protocol}://${req.get('host')}/api/cron/collect?key=${key}`;
}

async function view(req) {
  const s = await settings.loadAll(true);
  const cfg = await settings.getDeyeConfig();
  return {
    deye: {
      baseUrl: cfg.baseUrl,
      appId: cfg.appId,
      appSecretSet: Boolean(cfg.appSecret),
      loginType: cfg.loginType,
      email: cfg.email,
      username: cfg.username,
      mobile: cfg.mobile,
      countryCode: cfg.countryCode,
      passwordSet: Boolean(cfg.passwordSha256),
      companyId: cfg.companyId,
      configured: settings.isDeyeConfigured(cfg),
    },
    collection: {
      pollIntervalMinutes: parseInt(s.poll_interval_minutes, 10),
      stationRefreshMinutes: parseInt(s.station_refresh_minutes, 10),
      dailyRefreshMinutes: parseInt(s.daily_refresh_minutes, 10),
      retentionDays: parseInt(s.retention_days, 10),
      backfillPerTick: parseInt(s.backfill_per_tick, 10),
      autoGapFill: s.auto_gap_fill === '1',
    },
    cronUrl: await cronUrl(req),
    schedulerEnabled: config.schedulerEnabled,
  };
}

// Merges submitted form values with what is stored; empty secret fields keep the saved value.
async function mergeDeye(input) {
  const cur = await settings.getDeyeConfig();
  const d = input || {};
  const str = (v) => (v === undefined || v === null ? undefined : String(v).trim());
  const baseUrl = str(d.baseUrl) || cur.baseUrl;
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    const err = new Error('Base URL must start with http:// or https://');
    err.status = 400;
    throw err;
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    appId: str(d.appId) !== undefined ? str(d.appId) : cur.appId,
    appSecret: d.appSecret ? String(d.appSecret).trim() : cur.appSecret,
    loginType: ['email', 'username', 'mobile'].includes(d.loginType) ? d.loginType : cur.loginType,
    email: str(d.email) !== undefined ? str(d.email) : cur.email,
    username: str(d.username) !== undefined ? str(d.username) : cur.username,
    mobile: str(d.mobile) !== undefined ? str(d.mobile) : cur.mobile,
    countryCode: str(d.countryCode) !== undefined ? str(d.countryCode) : cur.countryCode,
    passwordSha256: d.password ? settings.sha256(d.password) : cur.passwordSha256,
    companyId: str(d.companyId) !== undefined ? str(d.companyId) : cur.companyId,
  };
}

router.get('/', async (req, res) => {
  res.json(await view(req));
});

router.put('/', async (req, res) => {
  const body = req.body || {};
  const updates = {};
  if (body.deye) {
    const c = await mergeDeye(body.deye);
    Object.assign(updates, {
      deye_base_url: c.baseUrl,
      deye_app_id: c.appId,
      deye_app_secret: c.appSecret,
      deye_login_type: c.loginType,
      deye_email: c.email,
      deye_username: c.username,
      deye_mobile: c.mobile,
      deye_country_code: c.countryCode,
      deye_password_sha256: c.passwordSha256,
      deye_company_id: c.companyId,
      // Force a fresh token and station discovery with the new credentials.
      deye_token: '',
      deye_token_expires: '0',
      last_discover_ts: '0',
    });
  }
  if (body.collection) {
    const c = body.collection;
    Object.assign(updates, {
      poll_interval_minutes: intIn(c.pollIntervalMinutes, 1, 60, 5),
      station_refresh_minutes: intIn(c.stationRefreshMinutes, 10, 1440, 60),
      daily_refresh_minutes: intIn(c.dailyRefreshMinutes, 10, 1440, 60),
      retention_days: intIn(c.retentionDays, 0, 36500, 0),
      backfill_per_tick: intIn(c.backfillPerTick, 1, 50, 6),
      auto_gap_fill: c.autoGapFill ? '1' : '0',
    });
  }
  await settings.set(updates);
  res.json(await view(req));
});

router.post('/test', async (req, res) => {
  const cfg = await mergeDeye((req.body && req.body.deye) || {});
  if (!settings.isDeyeConfigured(cfg)) {
    return res.status(400).json({ error: 'Fill in App ID, App Secret, login and password first' });
  }
  try {
    res.json(await collector.testConnection(cfg));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/rotate-cron-key', async (req, res) => {
  if (config.cronKey) return res.status(400).json({ error: 'CRON_KEY is set in the environment; change it there' });
  await settings.set({ cron_key: crypto.randomBytes(24).toString('hex') });
  res.json(await view(req));
});

module.exports = router;
