'use strict';

// Smart devices (eWeLink): everyone signed in can see devices and their history; only admins can
// connect the account, control devices and change settings.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const ewelink = require('../ewelink');
const devices = require('../ewelink/devices');

const router = express.Router();
const nowSec = () => Math.floor(Date.now() / 1000);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Where eWeLink sends the user back after signing in; must match the app's redirect URL exactly. */
async function redirectUrl(req) {
  const saved = await settings.get('ewelink_redirect_url');
  return saved || `${req.protocol}://${req.get('host')}/api/ewelink/callback`;
}

/**
 * eWeLink's redirect after sign-in (GET, top-level navigation, so the session cookie is sent).
 * Mounted before the API's sign-in check so an expired session gets a page, not JSON.
 */
async function callback(req, res) {
  const back = (q) => res.redirect(`/#/settings?${new URLSearchParams(q).toString()}`);
  try {
    const user = await auth.loadUser(req);
    if (!user || !user.is_admin) return back({ ewelink: 'error', message: 'Sign in as an admin, then press Connect again.' });
    const r = await ewelink.finishConnect({ code: req.query.code, region: req.query.region, state: req.query.state }, user);
    back({ ewelink: 'connected', devices: String(r.devices) });
  } catch (err) {
    back({ ewelink: 'error', message: err.message });
  }
}

async function device(req) {
  const dev = await ewelink.load(req.params.id);
  if (!dev) {
    const err = new Error('Device not found');
    err.status = 404;
    throw err;
  }
  return dev;
}

const actor = (req) => ({ source: 'user', userId: req.user.id, username: req.user.username });

router.get('/status', async (req, res) => {
  const s = await ewelink.status();
  if (req.user.is_admin) {
    const cfg = await settings.getEwelinkConfig();
    Object.assign(s, { appId: cfg.appId, appSecretSet: Boolean(cfg.appSecret), redirectUrl: await redirectUrl(req), redirectUrlSaved: Boolean(await settings.get('ewelink_redirect_url')) });
  }
  res.json(s);
});

router.get('/devices', async (req, res) => {
  const list = await ewelink.loadAll();
  res.json({ devices: list.map(devices.describe), canControl: Boolean(req.user.is_admin), status: await ewelink.status() });
});

router.get('/devices/:id', async (req, res) => {
  const dev = await device(req);
  const out = devices.describe(dev);
  out.params = dev.params;
  out.hundredDays = devices.hundredDays(dev);
  out.tags = (dev.raw && dev.raw.tags) || {};
  if (req.user.is_admin && dev.raw && dev.raw.sharedBy) out.sharedBy = dev.raw.sharedBy;
  res.json({ device: out, canControl: Boolean(req.user.is_admin) });
});

router.get('/devices/:id/history', async (req, res) => {
  const now = nowSec();
  let to = parseInt(req.query.to, 10);
  let from = parseInt(req.query.from, 10);
  if (!Number.isFinite(to)) to = now;
  if (!Number.isFinite(from)) from = to - 86400;
  if (from > to) [from, to] = [to, from];
  res.json(await ewelink.history(req.params.id, { from, to, cloud: req.query.cloud === '1' }));
});

router.get('/actions', async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const rows = await db.query(
    `SELECT a.*, d.name AS device_name, au.name AS automation_name
       FROM ewelink_actions a LEFT JOIN ewelink_devices d ON d.deviceid = a.deviceid LEFT JOIN automations au ON au.id = a.automation_id
      ORDER BY a.id DESC LIMIT ?`,
    [limit]
  );
  res.json({
    actions: rows.map((a) => ({
      id: a.id,
      ts: a.created_ts,
      deviceId: a.deviceid,
      device: a.device_name || a.deviceid,
      summary: a.summary,
      source: a.source,
      user: a.username,
      automation: a.automation_name || null,
      automationId: a.automation_id,
      status: a.status,
      message: a.message,
    })),
  });
});

// ---------- admin only ----------
router.use(auth.requireAdmin);

router.put('/config', async (req, res) => {
  const b = req.body || {};
  const updates = {};
  const str = (v) => (v === undefined || v === null ? undefined : String(v).trim());
  const cur = await settings.getEwelinkConfig();
  if (str(b.appId) !== undefined) updates.ewelink_app_id = str(b.appId);
  if (b.appSecret) updates.ewelink_app_secret = String(b.appSecret).trim();
  if (str(b.server) !== undefined) {
    const server = str(b.server).replace(/\/+$/, '');
    if (server && !/^https?:\/\/[^\s]+$/i.test(server)) throw badRequest('The custom server must start with http:// or https://');
    updates.ewelink_server = server;
  }
  if (str(b.redirectUrl) !== undefined) {
    const url = str(b.redirectUrl);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw badRequest('The redirect URL must start with http:// or https://');
    updates.ewelink_redirect_url = url;
  }
  if (b.pollMinutes !== undefined) {
    const n = parseInt(b.pollMinutes, 10);
    updates.ewelink_poll_minutes = Number.isFinite(n) ? Math.min(60, Math.max(2, n)) : 5;
  }
  if (b.live !== undefined) updates.ewelink_live = b.live ? '1' : '0';
  if (b.powerReports !== undefined) updates.ewelink_power_reports = b.powerReports ? '1' : '0';
  // A different app or server needs a new sign-in.
  const changedApp = (updates.ewelink_app_id !== undefined && updates.ewelink_app_id !== cur.appId) || (updates.ewelink_server !== undefined && updates.ewelink_server !== cur.server);
  await settings.set(updates);
  if (changedApp && cur.rt) await ewelink.disconnect();
  res.json(await ewelink.status());
});

router.post('/connect', async (req, res) => {
  res.json({ url: await ewelink.connectUrl(await redirectUrl(req), req.user) });
});

router.post('/disconnect', async (req, res) => {
  await ewelink.disconnect();
  res.json(await ewelink.status());
});

router.post('/sync', async (req, res) => {
  const c = await ewelink.client();
  try {
    const r = await ewelink.sync(c);
    res.json({ ...r, message: `Found ${r.devices} device(s)` });
  } catch (err) {
    await settings.set({ ewelink_last_error: err.message.slice(0, 500) });
    throw Object.assign(err, { status: err.status && err.status < 500 ? err.status : 502 });
  }
});

router.put('/devices/:id', async (req, res) => {
  const dev = await device(req);
  if (req.body && req.body.hidden !== undefined) await db.query('UPDATE ewelink_devices SET hidden = ? WHERE deviceid = ?', [req.body.hidden ? 1 : 0, dev.deviceid]);
  res.json({ device: devices.describe(await ewelink.load(dev.deviceid)) });
});

// Turns a channel (or every channel when channel is null) on, off, or the other way round.
router.post('/devices/:id/switch', async (req, res) => {
  const dev = await device(req);
  const { channel = null, state } = req.body || {};
  const chs = devices.channels(dev);
  if (!chs.length) throw badRequest('This device has nothing to switch');
  if (channel !== null && !chs.some((c) => c.index === Number(channel))) throw badRequest('No such channel');
  let target = state;
  if (state === 'toggle') {
    const cur = channel === null ? chs : chs.filter((c) => c.index === Number(channel));
    target = cur.some((c) => c.state === 'on') ? 'off' : 'on';
  }
  if (!['on', 'off'].includes(target)) throw badRequest('state must be on, off or toggle');
  res.json(await ewelink.command(dev.deviceid, devices.switchParams(dev, channel, target), actor(req)));
});

router.post('/devices/:id/setting', async (req, res) => {
  const dev = await device(req);
  const { setting, value, channel } = req.body || {};
  const params = devices.settingParams(dev, setting, value, channel);
  if (!params) throw badRequest("This device doesn't have that setting, or the value is not allowed");
  res.json(await ewelink.command(dev.deviceid, params, actor(req)));
});

// Advanced: sends params exactly as given (for features this page has no control for).
router.post('/devices/:id/params', async (req, res) => {
  const dev = await device(req);
  const params = req.body && req.body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length) throw badRequest('params must be a JSON object');
  if (JSON.stringify(params).length > 8000) throw badRequest('params are too long');
  res.json(await ewelink.command(dev.deviceid, params, actor(req)));
});

// POW plugs keep their last 100 days of energy and send it when asked.
router.post('/devices/:id/hundred-days', async (req, res) => {
  const dev = await device(req);
  if (!devices.canAskHundredDays(dev)) throw badRequest("This device doesn't keep daily energy");
  const r = await ewelink.command(dev.deviceid, { hundredDaysKwh: 'get' }, actor(req));
  if (!r.ok) return res.json({ ok: false, message: r.message, days: devices.hundredDays(dev) });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const c = await ewelink.client();
  const st = await c.getStatus(dev.deviceid, ['hundredDaysKwhData']).catch(() => null);
  if (st && st.params && st.params.hundredDaysKwhData) {
    await db.query('UPDATE ewelink_devices SET params = ? WHERE deviceid = ?', [JSON.stringify({ ...dev.params, hundredDaysKwhData: st.params.hundredDaysKwhData }), dev.deviceid]);
  }
  const fresh = await ewelink.load(dev.deviceid);
  res.json({ ok: true, days: devices.hundredDays(fresh) });
});

module.exports = { router, callback };
