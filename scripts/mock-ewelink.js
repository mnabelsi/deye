#!/usr/bin/env node
'use strict';

/**
 * Mock eWeLink (CoolKit Open API v2) server for trying Smart devices and Automations without real
 * devices. Serves the OAuth sign-in page, the device API, the dispatch service and the live
 * WebSocket, with a handful of simulated devices (a water heater with power metering, multi-channel
 * light switches, a lamp, sensors, an offline and a shared device).
 *
 *   npm run mock:ewelink        (http://localhost:4200, App ID "demo", App Secret "demo")
 *
 * In Settings → Smart devices (eWeLink) enter App ID demo, App Secret demo and, under Server,
 * "Custom URL" http://localhost:4200, save, then press Connect. Signatures, the 30-second code and
 * token refresh are checked like the real service, so the dashboard's handling of them is tested.
 * GET /mock/drop-live cuts the live connections, to see the dashboard reconnect.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.MOCK_EWELINK_PORT) || 4200;
const APP_ID = process.env.MOCK_EWELINK_APP_ID || 'demo';
const APP_SECRET = process.env.MOCK_EWELINK_APP_SECRET || 'demo';
const USER_APIKEY = 'mock-user-apikey-0001';
const OWNER_APIKEY_SHARED = 'mock-friend-apikey-0002';
const nowSec = () => Math.floor(Date.now() / 1000);
const sign = (msg) => crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(msg, 'utf8')).digest('base64');
const round2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

const ROOMS = [
  { id: 'room-living', name: 'Living room', index: 0 },
  { id: 'room-kitchen', name: 'Kitchen', index: 1 },
  { id: 'room-bedroom', name: 'Bedroom', index: 2 },
  { id: 'room-utility', name: 'Utility', index: 3 },
  { id: 'room-outside', name: 'Outside', index: 4 },
];

function dev(id, name, uiid, model, room, params, extra = {}) {
  return {
    itemType: extra.itemType || 1,
    online: extra.online !== false,
    data: {
      name,
      deviceid: id,
      apikey: extra.itemType === 2 ? OWNER_APIKEY_SHARED : USER_APIKEY,
      extra: { uiid, model: `${model}-FW`, ui: model, manufacturer: 'SONOFF', mac: `d0:27:00:${id.slice(-6, -4)}:${id.slice(-4, -2)}:${id.slice(-2)}`, modelInfo: model, brandId: 'sonoff' },
      brandName: 'SONOFF',
      productModel: model,
      family: { familyid: 'family-1', index: 0, roomid: room },
      tags: extra.tags || {},
      settings: { opsNotify: 0, opsHistory: 1, alarmNotify: 1 },
      sharedBy: extra.itemType === 2 ? { apikey: OWNER_APIKEY_SHARED, nickname: 'Rami', email: 'rami@example.com', permit: 15 } : undefined,
      devicekey: crypto.randomUUID(),
      params: { fwVersion: '3.7.0', rssi: -50 - Math.round(Math.random() * 25), sledOnline: 'on', timers: [], ...params },
    },
  };
}

const devices = [
  dev('10000a0001', 'Water heater', 32, 'POWR2', 'room-utility', { switch: 'off', startup: 'off', pulse: 'off', pulseWidth: 500, power: '0.00', voltage: '229.80', current: '0.00', alarmType: 'pcv' }),
  dev('10000a0002', 'Living room lights', 4, '4CHPROR3', 'room-living', {
    switches: [0, 1, 2, 3].map((outlet) => ({ switch: outlet === 0 ? 'on' : 'off', outlet })),
    configure: [0, 1, 2, 3].map((outlet) => ({ startup: 'off', outlet })),
    pulses: [0, 1, 2, 3].map((outlet) => ({ pulse: 'off', width: 1000, outlet })),
  }, { tags: { ck_channel_name: { 0: 'Ceiling', 1: 'Spots', 2: 'Wall lamp', 3: 'Balcony' } } }),
  dev('10000a0003', 'Kitchen lights', 7, 'T1EU2C', 'room-kitchen', {
    switches: [0, 1, 2, 3].map((outlet) => ({ switch: outlet === 1 ? 'on' : 'off', outlet })),
    configure: [0, 1].map((outlet) => ({ startup: 'stay', outlet })),
  }, { tags: { ck_channel_name: { 0: 'Main', 1: 'Counter' } } }),
  dev('10000a0004', 'Bedroom lamp', 103, 'B02-B-A60', 'room-bedroom', { switch: 'off', ltype: 'white', white: { br: 60, ct: 120 } }),
  dev('10000a0005', 'Water tank thermostat', 15, 'TH16', 'room-utility', {
    switch: 'off', startup: 'off', mainSwitch: 'off', deviceType: 'normal', sensorType: 'AM2301', currentTemperature: '41.5', currentHumidity: '38',
  }),
  dev('10000a0006', 'Front door', 102, 'DW2-Wi-Fi', 'room-living', { switch: 'off', battery: '2.95', type: 3, lastUpdateTime: new Date().toISOString() }),
  dev('10000a0007', 'Garage light', 1, 'BASICR2', 'room-outside', { switch: 'off', startup: 'off', pulse: 'off', pulseWidth: 500 }, { online: false }),
  dev('10000a0008', 'Bathroom heater', 1, 'MINIR2', 'room-bedroom', { switch: 'off', startup: 'stay', pulse: 'off', pulseWidth: 500 }, { itemType: 2 }),
  dev('10000a0009', 'Pool pump', 190, 'POWR316', 'room-outside', {
    switches: [{ switch: 'off', outlet: 0 }], configure: [{ startup: 'off', outlet: 0 }], pulses: [{ pulse: 'off', width: 1000, outlet: 0 }], power: 0, voltage: 23010, current: 0, dayKwh: 142, monthKwh: 4120,
  }),
  dev('10000a000a', 'Outdoor temperature', 1770, 'SNZB-02', 'room-outside', { temperature: '2558', humidity: '5211', battery: 96, trigTime: String(Date.now()) }),
];
const byId = new Map(devices.map((d) => [d.data.deviceid, d]));
const history = new Map(devices.map((d) => [d.data.deviceid, []]));
const uiActiveUntil = new Map();

// ---------- tokens ----------
const codes = new Map(); // code -> issued ms
const tokens = new Map(); // at -> expiry s
const refreshTokens = new Set();
let calls = 0;

function newTokens() {
  const at = crypto.randomBytes(20).toString('hex');
  const rt = crypto.randomBytes(20).toString('hex');
  tokens.set(at, nowSec() + 30 * 86400);
  refreshTokens.add(rt);
  return { at, rt };
}

// ---------- device behaviour ----------
const sockets = new Set();

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of sockets) if (ws.authed && ws.readyState === 1) ws.send(text);
}

function report(d, params) {
  broadcast({ action: 'update', deviceid: d.data.deviceid, apikey: d.data.apikey, userAgent: 'device', params });
}

function merge(cur, upd) {
  for (const [k, v] of Object.entries(upd)) {
    if (['switches', 'configure', 'pulses'].includes(k) && Array.isArray(v) && Array.isArray(cur[k])) {
      for (const item of v) {
        const i = cur[k].findIndex((x) => x.outlet === item.outlet);
        if (i >= 0) cur[k][i] = { ...cur[k][i], ...item };
        else cur[k].push(item);
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object') cur[k] = { ...cur[k], ...v };
    else cur[k] = v;
  }
}

/** Applies a command; returns an eWeLink error code (0 = ok). */
function control(id, params, by) {
  const d = byId.get(id);
  if (!d) return 405;
  if (!d.online) return 4002;
  if (params.uiActive !== undefined) {
    uiActiveUntil.set(id, Date.now() + Number(params.uiActive || 60) * 1000);
    return 0;
  }
  if (params.hundredDaysKwh === 'get') {
    let hex = '';
    for (let i = 0; i < 100; i++) {
      const v = i < 40 ? 3 + Math.random() * 9 : 0;
      const whole = Math.floor(v);
      const tenth = Math.floor((v - whole) * 10);
      const hund = Math.floor((v * 100) % 10);
      hex += [whole, tenth, hund].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    d.data.params.hundredDaysKwhData = hex;
    report(d, { hundredDaysKwhData: hex });
    return 0;
  }
  merge(d.data.params, params);
  const ops = [];
  if (params.switch) ops.push('switch');
  if (Array.isArray(params.switches)) ops.push(...params.switches.map((s) => `switch${s.outlet}`));
  history.get(id).unshift({ deviceid: id, userAgent: 'app', opsSwitchs: ops, request: JSON.stringify({ params }), opsAccount: by || 'demo@example.com', opsTime: Date.now() });
  setTimeout(() => {
    simulateDevice(d, true);
    report(d, params);
  }, 300);
  return 0;
}

function simulateDevice(d, quiet) {
  const p = d.data.params;
  const u = d.data.extra.uiid;
  if (u === 32) {
    const on = p.switch === 'on';
    const power = on ? 1950 + Math.random() * 120 : 0;
    const voltage = 226 + Math.random() * 6;
    Object.assign(p, { power: round2(power), voltage: round2(voltage), current: round2(power / voltage) });
  } else if (u === 190) {
    const on = p.switches[0].switch === 'on';
    const power = on ? 740 + Math.random() * 40 : 0;
    const voltage = 228 + Math.random() * 4;
    Object.assign(p, { power: Math.round(power * 100), voltage: Math.round(voltage * 100), current: Math.round((power / voltage) * 100) });
    if (on && !quiet) p.dayKwh += 1;
  }
  if (quiet) return;
  if ([32, 190].includes(u) && (uiActiveUntil.get(d.data.deviceid) || 0) > Date.now()) {
    report(d, { power: p.power, voltage: p.voltage, current: p.current, ...(u === 190 ? { dayKwh: p.dayKwh } : {}) });
  }
}

setInterval(() => {
  for (const d of devices) if (d.online) simulateDevice(d, false);
}, 10000);

// Slow changes: the thermostat warms while the heater runs, the door opens now and then.
setInterval(() => {
  const heater = byId.get('10000a0001').data.params;
  const tank = byId.get('10000a0005');
  const t = Number(tank.data.params.currentTemperature) + (heater.switch === 'on' ? 0.4 : -0.1);
  tank.data.params.currentTemperature = Math.min(75, Math.max(20, t)).toFixed(1);
  report(tank, { currentTemperature: tank.data.params.currentTemperature, currentHumidity: tank.data.params.currentHumidity });
  const outdoor = byId.get('10000a000a');
  outdoor.data.params.temperature = String(Math.round(2400 + Math.sin(Date.now() / 3.6e6) * 300 + Math.random() * 40));
  report(outdoor, { temperature: outdoor.data.params.temperature, humidity: outdoor.data.params.humidity, trigTime: String(Date.now()) });
  if (Math.random() < 0.15) {
    const door = byId.get('10000a0006');
    door.data.params.switch = door.data.params.switch === 'on' ? 'off' : 'on';
    history.get('10000a0006').unshift({ deviceid: '10000a0006', userAgent: 'device', request: JSON.stringify({ params: { switch: door.data.params.switch } }), opsTime: Date.now() });
    report(door, { switch: door.data.params.switch, lastUpdateTime: new Date().toISOString() });
  }
}, 60000);

// ---------- HTTP ----------
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
const ok = (res, data = {}) => json(res, 200, { error: 0, msg: '', data });
const fail = (res, error, msg) => json(res, 200, { error, msg, data: {} });

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return 401;
  const exp = tokens.get(m[1]);
  if (!exp) return 401;
  if (exp < nowSec()) return 402;
  return 0;
}

function signPage(q) {
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>eWeLink sign-in (mock)</title>
  <style>body{font-family:system-ui,sans-serif;background:#f3f5f8;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#fff;padding:28px;border-radius:14px;box-shadow:0 6px 30px #0002;width:min(360px,90vw);display:grid;gap:12px}
  h1{font-size:18px;margin:0}input{padding:10px;border:1px solid #ccd;border-radius:8px;font-size:14px}button{padding:11px;border:0;border-radius:8px;background:#1677ff;color:#fff;font-weight:600;font-size:15px;cursor:pointer}p{color:#667;font-size:13px;margin:0}</style></head>
  <body><form method="get" action="/oauth/authorize"><h1>Sign in to eWeLink</h1><p>Mock server: any email and password work. The real page is hosted by eWeLink.</p>
  <input name="email" value="demo@example.com"><input name="password" type="password" value="demo1234">
  ${['clientId', 'seq', 'authorization', 'redirectUrl', 'state', 'nonce', 'grantType'].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k))}">`).join('')}
  <button type="submit">Sign in and allow access</button></form></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const q = url.searchParams;
  const raw = req.method === 'GET' || req.method === 'DELETE' ? '' : await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return fail(res, 400, 'bad json');
  }
  if (path.startsWith('/v2/') || path === '/dispatch/app') {
    calls += 1;
    console.log(`[mock-ewelink] ${req.method} ${path}${url.search} (#${calls})`);
  }

  // Testing aid: drops every live connection, as a network cut would.
  if (path === '/mock/drop-live') {
    for (const ws of sockets) ws.terminate();
    return json(res, 200, { dropped: true });
  }

  // OAuth sign-in page and its form.
  if (path === '/oauth/index.html' || path === '/oauth/authorize') {
    if (q.get('clientId') !== APP_ID) return json(res, 400, { error: 'unknown clientId' });
    if (q.get('authorization') !== sign(`${q.get('clientId')}_${q.get('seq')}`)) return json(res, 400, { error: 'bad authorization signature' });
    if (!q.get('redirectUrl') || !q.get('state') || q.get('grantType') !== 'authorization_code') return json(res, 400, { error: 'missing parameters' });
    if (path === '/oauth/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(signPage(q));
    }
    const code = crypto.randomUUID();
    codes.set(code, Date.now());
    const back = new URL(q.get('redirectUrl'));
    back.searchParams.set('code', code);
    back.searchParams.set('region', 'eu');
    back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (path === '/v2/user/oauth/token' && req.method === 'POST') {
    if (req.headers['x-ck-appid'] !== APP_ID) return fail(res, 407, 'appid error');
    if (req.headers.authorization !== `Sign ${sign(raw)}`) return fail(res, 401, 'sign error');
    const at = codes.get(body.code);
    codes.delete(body.code);
    if (!at || Date.now() - at > 30000) return fail(res, 405, 'invalid code');
    const t = newTokens();
    return ok(res, { accessToken: t.at, atExpiredTime: Date.now() + 30 * 86400000, refreshToken: t.rt, rtExpiredTime: Date.now() + 60 * 86400000 });
  }

  if (path === '/v2/user/refresh' && req.method === 'POST') {
    const signed = req.headers.authorization === `Sign ${sign(raw)}`;
    if (!signed && bearer(req) === 401) return fail(res, 401, 'token error');
    if (!refreshTokens.has(body.rt)) return fail(res, 401, 'rt error');
    refreshTokens.delete(body.rt);
    const t = newTokens();
    return ok(res, { at: t.at, rt: t.rt });
  }

  if (path === '/dispatch/app') {
    if (bearer(req)) return json(res, 200, { error: 401, reason: 'token' });
    return json(res, 200, { error: 0, reason: 'ok', IP: '127.0.0.1', port: PORT, domain: 'localhost' });
  }

  if (path.startsWith('/v2/')) {
    const auth = bearer(req);
    if (auth) return fail(res, auth, auth === 402 ? 'token expired' : 'token error');
  }

  if (path === '/v2/family' && req.method === 'GET') {
    return ok(res, { familyList: [{ id: 'family-1', apikey: USER_APIKEY, name: 'Home', index: 0, roomList: ROOMS }], currentFamilyId: 'family-1' });
  }

  if (path === '/v2/device/thing' && req.method === 'GET') {
    const things = devices.map((d, i) => ({ itemType: d.itemType, index: i, itemData: { ...d.data, online: d.online } }));
    things.push({ itemType: 3, index: things.length, itemData: { id: 'group-1', name: 'All lights', mainDeviceId: '10000a0002', uiid: 4, params: {} } });
    const begin = Number(q.get('beginIndex') || -9999999);
    const num = Number(q.get('num') || 30) || things.length;
    const list = things.filter((t) => t.index >= begin).slice(0, num);
    return ok(res, { thingList: list, total: things.length });
  }

  if (path === '/v2/device/thing' && req.method === 'POST') {
    const list = (body.thingList || []).map((t) => byId.get(t.id)).filter(Boolean).map((d) => ({ itemType: d.itemType, index: devices.indexOf(d), itemData: { ...d.data, online: d.online } }));
    return ok(res, { thingList: list });
  }

  if (path === '/v2/device/thing/status' && req.method === 'GET') {
    const d = byId.get(q.get('id'));
    if (!d) return fail(res, 405, 'device not found');
    const keys = q.get('params') ? q.get('params').split('|') : null;
    const params = keys ? Object.fromEntries(keys.filter((k) => k in d.data.params).map((k) => [k, d.data.params[k]])) : d.data.params;
    return ok(res, { params });
  }

  if (path === '/v2/device/thing/status' && req.method === 'POST') {
    const code = control(String(body.id), body.params || {});
    return code ? fail(res, code, code === 4002 ? 'device offline' : 'error') : ok(res, {});
  }

  if (path === '/v2/device/thing/batch-status' && req.method === 'POST') {
    const respList = (body.thingList || []).map((t) => ({ type: 1, id: t.id, error: control(String(t.id), t.params || {}) === 0 ? 0 : 30022 }));
    return ok(res, { respList });
  }

  if (path === '/v2/device/history' && req.method === 'GET') {
    const list = history.get(q.get('deviceid'));
    if (!list) return fail(res, 405, 'device not found');
    const from = Number(q.get('from')) || Date.now();
    const num = Math.min(30, Number(q.get('num')) || 30);
    return ok(res, { histories: list.filter((h) => h.opsTime <= from).slice(0, num) });
  }

  json(res, 404, { error: 403, msg: 'api not found', data: {} });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (ws) => {
  sockets.add(ws);
  console.log('[mock-ewelink] live connection opened');
  ws.on('close', () => sockets.delete(ws));
  ws.on('message', (data) => {
    const text = String(data);
    if (text === 'ping') return ws.send('pong');
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.action === 'userOnline') {
      const valid = tokens.has(msg.at) && msg.appid === APP_ID && msg.apikey === USER_APIKEY;
      ws.authed = valid;
      ws.send(JSON.stringify(valid ? { error: 0, apikey: USER_APIKEY, config: { hb: 1, hbInterval: 145 }, sequence: msg.sequence } : { error: 406, sequence: msg.sequence }));
      if (!valid) ws.close();
      return;
    }
    if (!ws.authed) return;
    if (msg.action === 'update' && msg.deviceid) {
      const code = control(String(msg.deviceid), msg.params || {}, 'live');
      ws.send(JSON.stringify({ error: code ? 504 : 0, deviceid: msg.deviceid, apikey: msg.apikey, sequence: msg.sequence }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[mock-ewelink] listening on http://localhost:${PORT} (App ID "${APP_ID}", App Secret "${APP_SECRET}")`);
});
