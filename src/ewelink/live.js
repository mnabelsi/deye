'use strict';

// eWeLink's live connection (WebSocket). Devices' state changes arrive here the moment they happen,
// without using the monthly API quota, so the device list stays current between the rare full syncs.
// Only one process holds the connection: it keeps a MySQL named lock on a dedicated connection.
// eWeLink blocks IPs that sign in over and over, so reconnects back off from 30 s to 15 minutes.
// Power-metering plugs report power only while an app "has their page open" (uiActive), so with
// power reports on, that request is repeated every minute over this connection.

const WebSocket = require('ws');
const db = require('../db');
const settings = require('../settings');
const { EwelinkClient, nonce } = require('./client');
const devices = require('./devices');

const LOCK = 'deye_monitor_ewelink_ws';
const MIN_BACKOFF = 30 * 1000;
const MAX_BACKOFF = 15 * 60 * 1000;
const UI_ACTIVE_EVERY = 60 * 1000;

const st = {
  ws: null,
  lockConn: null,
  state: 'off', // off | connecting | connected | waiting | standby
  since: null,
  error: null,
  lastMessageTs: null,
  backoff: MIN_BACKOFF,
  reconnectTimer: null,
  hbTimer: null,
  uiTimer: null,
  connecting: false,
  apikey: '',
  messages: 0,
};

const nowSec = () => Math.floor(Date.now() / 1000);

function setState(state, error) {
  if (st.state !== state) st.since = nowSec();
  st.state = state;
  if (error !== undefined) st.error = error;
}

function clearTimers() {
  clearInterval(st.hbTimer);
  clearInterval(st.uiTimer);
  st.hbTimer = null;
  st.uiTimer = null;
}

function closeSocket() {
  clearTimers();
  if (st.ws) {
    const ws = st.ws;
    st.ws = null;
    ws.removeAllListeners();
    ws.on('error', () => {});
    try {
      ws.terminate();
    } catch {
      /* already closed */
    }
  }
}

async function releaseLock() {
  const conn = st.lockConn;
  st.lockConn = null;
  if (!conn) return;
  try {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]);
  } catch {
    /* connection gone: MySQL released it */
  }
  try {
    conn.release();
  } catch {
    /* ignore */
  }
}

/** Closes the connection and gives up the lock. */
function stop(reason) {
  clearTimeout(st.reconnectTimer);
  st.reconnectTimer = null;
  closeSocket();
  releaseLock();
  if (st.state !== 'off') setState('off', ['not connected', 'disabled', 'disconnected'].includes(reason) ? null : st.error);
}

// Holding the lock on a dedicated connection makes this process the one that connects.
async function holdLock() {
  if (st.lockConn) {
    try {
      const [rows] = await st.lockConn.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS mine', [LOCK]);
      if (rows[0] && rows[0].mine === 1) return true;
    } catch {
      /* lost the connection */
    }
    closeSocket();
    await releaseLock();
  }
  const conn = await db.getPool().getConnection();
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK]);
    if (rows[0] && rows[0].got === 1) {
      st.lockConn = conn;
      return true;
    }
  } catch {
    /* fall through */
  }
  conn.release();
  return false;
}

function scheduleReconnect() {
  clearTimeout(st.reconnectTimer);
  const wait = st.backoff;
  st.backoff = Math.min(MAX_BACKOFF, st.backoff * 2);
  setState('waiting');
  st.retryAt = nowSec() + Math.round(wait / 1000);
  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    connect().catch((err) => {
      setState('waiting', err.message);
      scheduleReconnect();
    });
  }, wait);
  if (st.reconnectTimer.unref) st.reconnectTimer.unref();
}

function send(obj) {
  if (st.ws && st.ws.readyState === WebSocket.OPEN) st.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

// Asks power-metering plugs to keep reporting power, voltage and current.
async function keepPowerReporting() {
  if ((await settings.get('ewelink_power_reports')) !== '1') return;
  const rows = await db.query('SELECT deviceid, uiid, apikey, item_type, params FROM ewelink_devices WHERE online = 1 AND hidden = 0');
  for (const r of rows) {
    let params = {};
    try {
      params = JSON.parse(r.params || '{}');
    } catch {
      params = {};
    }
    const kind = devices.kindOf(Number(r.uiid), params);
    if (kind !== 'meter') continue;
    const msg = { action: 'update', deviceid: r.deviceid, apikey: r.apikey || st.apikey, userAgent: 'app', sequence: String(Date.now()), params: { uiActive: 60 } };
    if (Number(r.item_type) === 2) msg.selfApikey = st.apikey;
    send(msg);
  }
}

async function onMessage(text) {
  st.lastMessageTs = nowSec();
  st.messages += 1;
  if (text === 'pong') return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const service = require('./index');
  // Handshake answer.
  if (msg.config !== undefined || (st.state === 'connecting' && msg.error !== undefined && !msg.deviceid)) {
    if (Number(msg.error)) {
      setState('waiting', `eWeLink refused the live connection (error ${msg.error})`);
      closeSocket();
      if ([401, 402, 406].includes(Number(msg.error))) {
        const c = new EwelinkClient(await settings.getEwelinkConfig());
        await c.refresh(true).catch(() => {});
      }
      scheduleReconnect();
      return;
    }
    setState('connected', null);
    const hb = (msg.config && Number(msg.config.hbInterval)) || 90;
    clearTimers();
    st.hbTimer = setInterval(() => send('ping'), Math.max(15, Math.floor(hb * 0.8)) * 1000);
    st.uiTimer = setInterval(() => keepPowerReporting().catch(() => {}), UI_ACTIVE_EVERY);
    for (const t of [st.hbTimer, st.uiTimer]) if (t.unref) t.unref();
    keepPowerReporting().catch(() => {});
    await settings.set({ ewelink_ws_alive_ts: nowSec() });
    return;
  }
  if (msg.action === 'update' && msg.deviceid && msg.params && typeof msg.params === 'object') {
    await service.applyParams(String(msg.deviceid), msg.params).catch((err) => console.error('[ewelink] update:', err.message));
    return;
  }
  if (msg.action === 'sysmsg' && msg.deviceid && msg.params && msg.params.online !== undefined) {
    await service.setOnline(String(msg.deviceid), Boolean(msg.params.online)).catch(() => {});
  }
}

async function connect() {
  if (st.connecting) return;
  st.connecting = true;
  try {
    closeSocket();
    const cfg = await settings.getEwelinkConfig();
    if (!settings.isEwelinkConnected(cfg)) return stop('not connected');
    const c = new EwelinkClient(cfg);
    let apikey = cfg.apikey;
    if (!apikey) {
      const fam = await c.family();
      apikey = ((fam.familyList || []).find((f) => f.apikey) || {}).apikey || '';
      if (apikey) await settings.set({ ewelink_apikey: apikey });
    }
    if (!apikey) throw new Error('eWeLink did not tell the account key needed for the live connection');
    st.apikey = apikey;
    const d = await c.dispatch();
    const host = d.domain || d.IP;
    if (!host || !d.port) throw new Error('eWeLink did not give a live connection address');
    const scheme = cfg.server && cfg.server.startsWith('http://') ? 'ws' : 'wss';
    setState('connecting');
    const ws = new WebSocket(`${scheme}://${host}:${d.port}/api/ws`, { handshakeTimeout: 15000 });
    st.ws = ws;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({ action: 'userOnline', version: 8, ts: nowSec(), at: c.cfg.at, userAgent: 'app', apikey, appid: cfg.appId, nonce: nonce(), sequence: String(Date.now()) })
      );
    });
    ws.on('message', (data) => onMessage(String(data)).catch((err) => console.error('[ewelink] message:', err.message)));
    ws.on('error', (err) => {
      st.error = err.message;
    });
    ws.on('close', () => {
      if (st.ws !== ws) return;
      st.ws = null;
      clearTimers();
      // A connection that lasted a while starts the back-off again.
      if (st.state === 'connected' && st.since && nowSec() - st.since > 600) st.backoff = MIN_BACKOFF;
      scheduleReconnect();
    });
  } finally {
    st.connecting = false;
  }
}

/** Called every minute: opens the connection if this process may, checks it is still alive. */
async function ensure() {
  const s = await settings.loadAll(true);
  const cfg = await settings.getEwelinkConfig();
  if (!settings.isEwelinkConnected(cfg)) return stop('not connected');
  if (s.ewelink_live !== '1') return stop('disabled');
  if (!(await holdLock())) {
    setState('standby'); // another process holds the connection
    return;
  }
  if (st.ws && st.state === 'connected') {
    // No message (not even a pong) for 5 minutes: the connection is dead.
    if (st.lastMessageTs && nowSec() - st.lastMessageTs > 300) {
      closeSocket();
      scheduleReconnect();
      return;
    }
    await settings.set({ ewelink_ws_alive_ts: nowSec() });
    return;
  }
  if (st.ws || st.connecting || st.reconnectTimer) return;
  await connect().catch((err) => {
    setState('waiting', err.message);
    scheduleReconnect();
  });
}

function status() {
  return { state: st.state, since: st.since, error: st.error, lastMessageTs: st.lastMessageTs, retryAt: st.state === 'waiting' ? st.retryAt || null : null, messages: st.messages };
}

module.exports = { ensure, stop, status };
