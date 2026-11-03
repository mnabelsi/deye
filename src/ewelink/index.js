'use strict';

// Smart devices from eWeLink: connecting the account (OAuth), keeping the device list and states in
// MySQL, recording their readings and on/off changes as history, sending commands and logging them.
// States arrive live over eWeLink's WebSocket (see live.js) and from a periodic full sync, which runs
// often while the live connection is down and rarely while it is up, to stay inside the free App
// ID's 50,000 calls a month.

const crypto = require('crypto');
const db = require('../db');
const settings = require('../settings');
const { storeSamples } = require('../store');
const { EwelinkClient, EwelinkError, authorizeUrl, usage } = require('./client');
const devices = require('./devices');

const SYNC_LOCK = 'deye_monitor_ewelink_sync';
const LIVE_SYNC_MINUTES = 30; // full sync interval while the live connection is up
const FAMILY_REFRESH = 12 * 3600;
const STATE_TTL = 15 * 60; // how long a sign-in link stays valid
// Command keys that ask the device for something rather than set a state.
const ASK_KEYS = new Set(['hundredDaysKwh', 'uiActive', 'oneKwh', 'getHoursKwh']);

const nowSec = () => Math.floor(Date.now() / 1000);
const parse = (v, def) => {
  try {
    return v ? JSON.parse(v) : def;
  } catch {
    return def;
  }
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function rowToDevice(r) {
  if (!r) return null;
  return { ...r, uiid: r.uiid === null ? null : Number(r.uiid), params: parse(r.params, {}), raw: parse(r.raw, {}), online: r.online === null ? null : Boolean(r.online) };
}

async function load(deviceid) {
  return rowToDevice(await db.one('SELECT * FROM ewelink_devices WHERE deviceid = ?', [String(deviceid)]));
}

async function loadAll({ includeHidden = true } = {}) {
  const rows = await db.query(`SELECT * FROM ewelink_devices ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY sort_index, name`);
  return rows.map(rowToDevice);
}

async function client() {
  const cfg = await settings.getEwelinkConfig();
  if (!settings.isEwelinkConfigured(cfg)) throw httpError(400, 'Enter your eWeLink App ID and App Secret in Settings first');
  if (!settings.isEwelinkConnected(cfg)) throw httpError(400, 'Your eWeLink account is not connected. Connect it in Settings.');
  return new EwelinkClient(cfg);
}

// ---------- connecting the account ----------

/** The eWeLink sign-in link; the state ties the answer to this request. */
async function connectUrl(redirectUrl, user) {
  const cfg = await settings.getEwelinkConfig();
  if (!settings.isEwelinkConfigured(cfg)) throw httpError(400, 'Enter your eWeLink App ID and App Secret first');
  const state = crypto.randomBytes(12).toString('hex');
  await settings.set({ ewelink_oauth_state: JSON.stringify({ state, exp: nowSec() + STATE_TTL, uid: user.id, redirectUrl }) });
  return authorizeUrl(cfg, { redirectUrl, state });
}

/** Handles eWeLink's redirect back: exchanges the code, then loads homes, rooms and devices. */
async function finishConnect({ code, region, state }, user) {
  const saved = parse(await settings.get('ewelink_oauth_state'), null);
  if (!saved || saved.state !== state || saved.exp < nowSec()) throw httpError(400, 'This eWeLink sign-in link has expired. Press Connect again.');
  if (saved.uid !== user.id) throw httpError(403, 'Finish connecting with the same account that started it');
  if (!code) throw httpError(400, 'eWeLink did not send an authorization code');
  await settings.set({ ewelink_oauth_state: '' });
  const cfg = await settings.getEwelinkConfig();
  const c = new EwelinkClient(cfg);
  await c.exchangeCode(String(code), saved.redirectUrl, String(region || ''));
  await settings.set({
    ewelink_connected_by: user.username,
    ewelink_connected_ts: nowSec(),
    ewelink_quota_paused_until: '',
    ewelink_last_error: '',
    ewelink_last_sync_ts: '0',
    ewelink_family_ts: '0',
  });
  const r = await sync(c, { family: true });
  return r;
}

async function disconnect() {
  const live = require('./live');
  live.stop('disconnected');
  await settings.set({ ewelink_at: '', ewelink_rt: '', ewelink_at_expires: '0', ewelink_rt_expires: '0', ewelink_apikey: '', ewelink_region: '', ewelink_last_error: '' });
}

// ---------- device list and states ----------

/** Homes and rooms (room names for the device list) and the account's apikey for the live connection. */
async function loadFamily(c) {
  const d = await c.family();
  const rooms = {};
  let apikey = '';
  for (const f of d.familyList || []) {
    if (!apikey && f.apikey) apikey = f.apikey;
    for (const r of f.roomList || []) rooms[r.id] = r.name;
  }
  await settings.set({ ewelink_rooms: JSON.stringify(rooms), ewelink_family_ts: nowSec(), ...(apikey ? { ewelink_apikey: apikey } : {}) });
  return rooms;
}

/** Fetches every device from eWeLink and stores their names, states and readings. */
async function sync(c, { family = false } = {}) {
  const started = Date.now();
  const s = await settings.loadAll(true);
  let rooms = parse(s.ewelink_rooms, {});
  if (family || nowSec() - (Number(s.ewelink_family_ts) || 0) > FAMILY_REFRESH || !s.ewelink_apikey) {
    rooms = await loadFamily(c).catch(() => rooms);
  }
  const res = await c.things();
  const now = nowSec();
  let count = 0;
  const groups = res.thingList.filter((t) => t.itemType === 3).length;
  for (const t of res.thingList) {
    if (t.itemType !== 1 && t.itemType !== 2) continue; // 3 = groups
    const d = t.itemData || {};
    if (!d.deviceid) continue;
    const extra = d.extra || {};
    const roomId = (d.family && d.family.roomid) || null;
    const dev = {
      deviceid: String(d.deviceid),
      name: d.name || null,
      uiid: Number(extra.uiid) || null,
      model: d.productModel || extra.model || null,
      brand: d.brandName || extra.manufacturer || null,
      item_type: t.itemType,
      apikey: d.apikey || null,
      family_id: (d.family && d.family.familyid) || null,
      room_id: roomId,
      room_name: roomId ? rooms[roomId] || null : null,
      online: d.online === undefined ? null : Boolean(d.online),
      params: d.params || {},
      raw: { extra, tags: d.tags || {}, settings: d.settings || {}, devConfig: d.devConfig ? '…' : undefined, sharedBy: d.sharedBy ? { nickname: d.sharedBy.nickname, email: d.sharedBy.email } : undefined },
    };
    await db.query(
      `INSERT INTO ewelink_devices (deviceid, name, uiid, model, brand, item_type, apikey, family_id, room_id, room_name, online, params, raw, sort_index, seen_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), uiid = VALUES(uiid), model = VALUES(model), brand = VALUES(brand), item_type = VALUES(item_type),
         apikey = VALUES(apikey), family_id = VALUES(family_id), room_id = VALUES(room_id), room_name = VALUES(room_name), online = VALUES(online),
         params = VALUES(params), raw = VALUES(raw), sort_index = VALUES(sort_index), seen_ts = VALUES(seen_ts), updated_ts = VALUES(updated_ts)`,
      [dev.deviceid, dev.name, dev.uiid, dev.model, dev.brand, dev.item_type, dev.apikey, dev.family_id, dev.room_id, dev.room_name,
        dev.online === null ? null : dev.online ? 1 : 0, JSON.stringify(dev.params), JSON.stringify(dev.raw), Number(t.index) || 0, now, now]
    );
    await storeSamples('ewelink', dev.deviceid, devices.samples(dev, now));
    count += 1;
  }
  // Devices removed from the eWeLink account disappear after a week (their history stays).
  await db.query('DELETE FROM ewelink_devices WHERE seen_ts < ?', [now - 7 * 86400]);
  // eWeLink's total counts groups too, and devices of brands it doesn't open to this App ID.
  const total = Math.max(count, (Number(res.total) || 0) - groups);
  await settings.set({ ewelink_last_sync_ts: now, ewelink_last_error: '', ewelink_device_total: total });
  return { devices: count, total, durationMs: Date.now() - started };
}

// Readings each reported param feeds (so an update stores only what it actually reported).
function touchedKeys(params) {
  const keys = new Set();
  for (const k of Object.keys(params || {})) {
    keys.add(k);
    if (k === 'currentTemperature') keys.add('temperature');
    if (k === 'currentHumidity') keys.add('humidity');
    const m = /^(actPow|voltage|current)_0(\d)$/.exec(k);
    if (m) keys.add(`${m[1] === 'actPow' ? 'power' : m[1]}_${Number(m[2]) + 1}`);
    if (k === 'lock' || k === 'switch') keys.add('door');
  }
  return keys;
}

/**
 * Applies params a device reported (live update) or that a command set: merges them into its
 * state and stores the readings and switch states they change.
 */
async function applyParams(deviceid, params, { ts = nowSec() } = {}) {
  const before = await load(deviceid);
  if (!before || !params || typeof params !== 'object') return null;
  const clean = Object.fromEntries(Object.entries(params).filter(([k]) => !ASK_KEYS.has(k)));
  if (!Object.keys(clean).length) return before;
  const after = { ...before, params: devices.mergeParams(before.params, clean) };
  if (before.online === false) after.online = true; // a device that reports is online
  await db.query('UPDATE ewelink_devices SET params = ?, online = ?, updated_ts = ? WHERE deviceid = ?', [
    JSON.stringify(after.params),
    after.online === null ? null : after.online ? 1 : 0,
    ts,
    before.deviceid,
  ]);
  const old = new Map(devices.samples(before, ts).map((x) => [x.key, x.value]));
  const touched = touchedKeys(clean);
  const changed = devices.samples(after, ts).filter((x) => old.get(x.key) !== x.value || touched.has(x.key) || /^switch/.test(x.key) || (x.key === 'online' && before.online !== after.online));
  await storeSamples('ewelink', before.deviceid, changed);
  return after;
}

async function setOnline(deviceid, online, ts = nowSec()) {
  const dev = await load(deviceid);
  if (!dev) return;
  await db.query('UPDATE ewelink_devices SET online = ?, updated_ts = ? WHERE deviceid = ?', [online ? 1 : 0, ts, dev.deviceid]);
  await storeSamples('ewelink', dev.deviceid, [{ ts, key: 'online', value: online ? 'online' : 'offline', name: 'Connection' }]);
}

// ---------- commands ----------

async function logAction(dev, params, actor, status, message) {
  await db.query(
    `INSERT INTO ewelink_actions (deviceid, params, summary, source, user_id, username, automation_id, status, message, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dev.deviceid,
      JSON.stringify(params).slice(0, 60000),
      devices.summarize(dev, params).slice(0, 255),
      actor.source || 'user',
      actor.userId || null,
      actor.username ? String(actor.username).slice(0, 64) : null,
      actor.automationId || null,
      status,
      message ? String(message).slice(0, 512) : null,
      nowSec(),
    ]
  );
}

/**
 * Sends params to one device and logs it. actor: { source: 'user'|'automation', userId, username,
 * automationId }. Resolves { ok, message, device }; a refused command is logged, not thrown.
 */
async function command(deviceid, params, actor, c) {
  const dev = await load(deviceid);
  if (!dev) throw httpError(404, 'Device not found');
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length) throw httpError(400, 'Nothing to send');
  let ok = true;
  let message = null;
  try {
    await (c || (await client())).setStatus(dev.deviceid, params);
  } catch (err) {
    if (err.status && !(err instanceof EwelinkError)) throw err;
    ok = false;
    message = err.message;
  }
  await logAction(dev, params, actor, ok ? 'ok' : 'failed', message);
  const after = ok ? await applyParams(dev.deviceid, params) : dev;
  return { ok, message, summary: devices.summarize(dev, params), device: devices.describe(after || dev) };
}

/**
 * Sends several commands ([{ deviceid, params }]) in as few calls as possible (10 per call) and
 * logs each. Resolves [{ deviceid, ok, message, summary }].
 */
async function commandMany(list, actor) {
  const c = await client();
  const out = [];
  const items = [];
  for (const x of list) {
    const dev = await load(x.deviceid);
    if (!dev) out.push({ deviceid: x.deviceid, ok: false, message: 'Device not found', summary: '' });
    else items.push({ dev, params: x.params });
  }
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    let results = null;
    if (batch.length > 1) {
      try {
        const r = await c.batchStatus(batch.map((b) => ({ id: b.dev.deviceid, params: b.params })), 6000);
        results = new Map((r.respList || []).map((x) => [String(x.id), Number(x.error) || 0]));
      } catch (err) {
        if (err.quota || err.network) {
          for (const b of batch) {
            await logAction(b.dev, b.params, actor, 'failed', err.message);
            out.push({ deviceid: b.dev.deviceid, ok: false, message: err.message, summary: devices.summarize(b.dev, b.params) });
          }
          continue;
        }
        results = null; // batch not allowed for this App ID: send one by one
      }
    }
    for (const b of batch) {
      if (results) {
        const code = results.has(b.dev.deviceid) ? results.get(b.dev.deviceid) : 0;
        const ok = code === 0;
        const message = ok ? null : code === 30022 || code === 504 ? 'the device is offline' : `eWeLink error ${code}`;
        await logAction(b.dev, b.params, actor, ok ? 'ok' : 'failed', message);
        if (ok) await applyParams(b.dev.deviceid, b.params);
        out.push({ deviceid: b.dev.deviceid, ok, message, summary: devices.summarize(b.dev, b.params) });
      } else {
        const r = await command(b.dev.deviceid, b.params, actor, c);
        out.push({ deviceid: b.dev.deviceid, ok: r.ok, message: r.message, summary: r.summary });
      }
    }
  }
  return out;
}

// ---------- history ----------

const cloudCache = new Map();

// The channel states a command set, by metric key ({ switch_2: 'on' }), to tell who switched what.
function switchStates(dev, params) {
  const out = {};
  if (typeof params.switch === 'string') out[devices.channelKey(dev, 0)] = params.switch;
  if (Array.isArray(params.switches)) for (const x of params.switches) out[devices.channelKey(dev, Number(x.outlet))] = x.switch;
  return out;
}

/**
 * A device's history between from and to (epoch s): state changes recorded here (on/off per
 * channel, online, door/motion), the commands sent from this dashboard, and, when asked, eWeLink's
 * own operation log (one API call, cached for a minute).
 */
async function history(deviceid, { from, to, cloud = false }) {
  const dev = await load(deviceid);
  if (!dev) throw httpError(404, 'Device not found');
  const metrics = await db.query("SELECT * FROM metrics WHERE source_type = 'ewelink' AND source_id = ?", [dev.deviceid]);
  const textIds = metrics.filter((m) => m.value_kind === 'text').map((m) => m.id);
  let events = [];
  const initial = [];
  if (textIds.length) {
    events = await db.query('SELECT metric_id, ts, value FROM text_readings WHERE metric_id IN (?) AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000', [textIds, from, to]);
    // Each state's value when the period starts, so on-time can be counted from the first minute.
    for (const id of textIds) {
      const r = await db.one('SELECT metric_id, ts, value FROM text_readings WHERE metric_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1', [id, from]);
      if (r) initial.push(r);
    }
  }
  const actions = await db.query('SELECT * FROM ewelink_actions WHERE deviceid = ? AND created_ts BETWEEN ? AND ? ORDER BY id DESC LIMIT 500', [dev.deviceid, from, to]);
  const automationNames = new Map((await db.query('SELECT id, name FROM automations')).map((a) => [a.id, a.name]));
  const out = {
    metrics: metrics.map((m) => ({ id: m.id, key: m.mkey, label: m.name || m.mkey, unit: m.unit || '', kind: m.value_kind, lastValue: m.value_kind === 'number' ? m.last_value_num : m.last_value_text, lastTs: m.last_ts })),
    events: events.map((e) => ({ metricId: e.metric_id, ts: e.ts, value: e.value })),
    initial: initial.map((e) => ({ metricId: e.metric_id, ts: e.ts, value: e.value })),
    actions: actions.map((a) => ({
      id: a.id,
      ts: a.created_ts,
      sets: switchStates(dev, parse(a.params, {})),
      summary: a.summary,
      source: a.source,
      user: a.username,
      automation: a.automation_id ? automationNames.get(a.automation_id) || `Automation ${a.automation_id}` : null,
      automationId: a.automation_id,
      status: a.status,
      message: a.message,
    })),
    cloud: null,
  };
  if (cloud) {
    const key = `${dev.deviceid}:${to}`;
    const hit = cloudCache.get(key);
    if (hit && hit.at > Date.now() - 60000) out.cloud = hit.value;
    else {
      try {
        const d = await (await client()).history(dev.deviceid, to * 1000, 30);
        out.cloud = {
          items: (d.histories || []).map((h) => {
            let request = h.request;
            try {
              request = typeof request === 'string' ? JSON.parse(request) : request;
            } catch {
              /* keep the text */
            }
            const params = request && request.params ? request.params : request;
            return {
              ts: Math.floor(Number(h.opsTime) / 1000),
              by: h.userAgent === 'device' ? 'device' : h.opsAccount || h.userAgent || 'app',
              channels: h.opsSwitchs || null,
              summary: params && typeof params === 'object' ? devices.summarize(dev, params) : String(request || '').slice(0, 200),
            };
          }),
        };
      } catch (err) {
        out.cloud = { items: [], error: err.code === 407 || err.code === 403 ? "eWeLink doesn't open its own device history to this App ID; the history recorded here is shown instead." : err.message };
      }
      cloudCache.set(key, { at: Date.now(), value: out.cloud });
      if (cloudCache.size > 200) cloudCache.clear();
    }
  }
  return out;
}

// ---------- status and scheduling ----------

// The sign-in expired (60 days without a renewal) or eWeLink stopped accepting it.
const needsReconnect = (cfg, s) => settings.isEwelinkConnected(cfg) && ((cfg.rtExpires > 0 && cfg.rtExpires < nowSec()) || s.ewelink_rt_invalid === '1');

async function status() {
  const s = await settings.loadAll(true);
  const cfg = await settings.getEwelinkConfig();
  const live = require('./live');
  const count = await db.one('SELECT COUNT(*) AS n, SUM(online = 1) AS online FROM ewelink_devices');
  const wsAlive = Number(s.ewelink_ws_alive_ts) || 0;
  return {
    configured: settings.isEwelinkConfigured(cfg),
    connected: settings.isEwelinkConnected(cfg),
    reconnectNeeded: needsReconnect(cfg, s),
    region: cfg.region || null,
    server: cfg.server || '',
    connectedBy: s.ewelink_connected_by || null,
    connectedTs: Number(s.ewelink_connected_ts) || null,
    tokenExpiresTs: cfg.atExpires || null,
    refreshExpiresTs: cfg.rtExpires || null,
    lastSyncTs: Number(s.ewelink_last_sync_ts) || null,
    lastError: s.ewelink_last_error || null,
    devices: count ? Number(count.n) || 0 : 0,
    onlineDevices: count ? Number(count.online) || 0 : 0,
    totalOnAccount: Number(s.ewelink_device_total) || null,
    pollMinutes: Number(s.ewelink_poll_minutes) || 5,
    liveSyncMinutes: LIVE_SYNC_MINUTES,
    liveEnabled: s.ewelink_live === '1',
    powerReports: s.ewelink_power_reports === '1',
    live: { ...live.status(), aliveTs: wsAlive || null, up: live.status().state === 'connected' || wsAlive > nowSec() - 150 },
    usage: await usage(),
  };
}

/**
 * Called every minute by the scheduler (and by the cron URL): keeps the token fresh, syncs the
 * device list when due and, when allowed, keeps the live connection open.
 */
async function tick({ trigger = 'scheduler', force = false } = {}) {
  const live = require('./live');
  const cfg = await settings.getEwelinkConfig();
  if (!settings.isEwelinkConnected(cfg)) {
    live.stop('not connected');
    return { status: 'skipped' };
  }
  const s = await settings.loadAll(true);
  if (needsReconnect(cfg, s)) {
    live.stop('not connected');
    return { status: 'error', message: 'The eWeLink sign-in has expired. Reconnect the account in Settings.' };
  }
  const now = nowSec();
  const liveUp = live.status().state === 'connected' || (Number(s.ewelink_ws_alive_ts) || 0) > now - 150;
  const every = (liveUp ? LIVE_SYNC_MINUTES : Math.max(1, Number(s.ewelink_poll_minutes) || 5)) * 60;
  let result = { status: 'ok', synced: false };
  if (force || now - (Number(s.ewelink_last_sync_ts) || 0) >= every - 15) {
    const r = await db.withLock(SYNC_LOCK, async () => {
      const c = new EwelinkClient(cfg);
      try {
        const x = await sync(c);
        return { status: 'ok', synced: true, ...x };
      } catch (err) {
        // Remember the attempt so a failing account isn't retried every minute.
        await settings.set({ ewelink_last_sync_ts: now, ewelink_last_error: err.message.slice(0, 500) });
        return { status: 'error', message: err.message };
      }
    });
    if (r.locked) result = r.result;
  }
  if (trigger === 'scheduler') await live.ensure().catch((err) => console.error('[ewelink] live connection:', err.message));
  return result;
}

module.exports = {
  load,
  loadAll,
  client,
  connectUrl,
  finishConnect,
  disconnect,
  sync,
  applyParams,
  setOnline,
  command,
  commandMany,
  history,
  status,
  tick,
  describe: devices.describe,
};
