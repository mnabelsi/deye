'use strict';

// eWeLink (CoolKit) Open API v2 client, for apps from the eWeLink developer center
// (https://dev.ewelink.cc). A free App ID signs users in with OAuth 2.0 and may make 50,000 calls a
// month per region, at least 500 ms apart and at most 300 per 5 minutes from one IP, so calls are
// paced, counted per month in the settings table, and paused once eWeLink says the quota is used up.

const crypto = require('crypto');
const db = require('../db');
const settings = require('../settings');

const API = {
  cn: 'https://cn-apia.coolkit.cn',
  as: 'https://as-apia.coolkit.cc',
  us: 'https://us-apia.coolkit.cc',
  eu: 'https://eu-apia.coolkit.cc',
};
const DISPATCH = {
  cn: 'https://cn-dispa.coolkit.cn',
  as: 'https://as-dispa.coolkit.cc',
  us: 'https://us-dispa.coolkit.cc',
  eu: 'https://eu-dispa.coolkit.cc',
};
const OAUTH_PAGE = 'https://c2ccdn.coolkit.cc/oauth/index.html';
const REGIONS = Object.keys(API);
const MONTHLY_QUOTA = 50000;
const MIN_INTERVAL_MS = 600;
const REFRESH_LOCK = 'deye_monitor_ewelink_refresh';
// Refresh the access token (valid 30 days) this long before it expires; the refresh token is valid 60.
const REFRESH_AHEAD = 5 * 86400;

class EwelinkError extends Error {
  constructor(message, { status, code, auth, quota, network, data } = {}) {
    super(message);
    this.name = 'EwelinkError';
    this.status = status;
    this.code = code;
    this.auth = Boolean(auth);
    this.quota = Boolean(quota);
    this.network = Boolean(network);
    this.data = data;
  }
}

// Messages for eWeLink's error codes (API Center v2 → error codes).
const ERRORS = {
  400: 'invalid request',
  401: 'the eWeLink sign-in is no longer valid (signed in elsewhere?)',
  402: 'the eWeLink sign-in has expired',
  403: 'endpoint not found',
  405: 'not found',
  406: 'not allowed for this account',
  407: 'this App ID is not allowed to do that',
  412: 'this App ID has used up its monthly eWeLink API calls',
  500: 'eWeLink server error',
  4002: 'the device did not accept the command (offline or unsupported)',
  30022: 'the device is offline',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const monthKey = (d = new Date()) => `ewelink_calls:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (const b of crypto.randomBytes(8)) out += chars[b % chars.length];
  return out;
}

function sign(secret, message) {
  return crypto.createHmac('sha256', secret).update(Buffer.from(message, 'utf8')).digest('base64');
}

// One pace for every client in this process: the limits are per IP, not per client.
let lastCallAt = 0;
async function pace() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  lastCallAt = Math.max(Date.now(), lastCallAt + MIN_INTERVAL_MS);
  if (wait > 0) await sleep(wait);
}

async function countCall() {
  await db
    .query('INSERT INTO settings (name, value) VALUES (?, 1) ON DUPLICATE KEY UPDATE value = CAST(value AS UNSIGNED) + 1', [monthKey()])
    .catch(() => {});
}

/** Calls made this month (UTC) and the free App ID's monthly limit. */
async function usage() {
  const row = await db.one('SELECT value FROM settings WHERE name = ?', [monthKey()]);
  const paused = Number(await settings.get('ewelink_quota_paused_until')) || 0;
  return { calls: row ? Number(row.value) || 0 : 0, quota: MONTHLY_QUOTA, pausedUntil: paused > nowSec() ? paused : null };
}

function startOfNextMonth() {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

/** Base URLs for an account's region, or for a custom server (the mock) that serves all of them. */
function urls(cfg, region) {
  const r = REGIONS.includes(region) ? region : 'eu';
  if (cfg.server) {
    return { api: cfg.server, dispatch: `${cfg.server}/dispatch/app`, oauth: `${cfg.server}/oauth/index.html` };
  }
  return { api: API[r], dispatch: `${DISPATCH[r]}/dispatch/app`, oauth: OAUTH_PAGE };
}

/** The eWeLink sign-in page that sends the user back to redirectUrl with ?code=&region=&state=. */
function authorizeUrl(cfg, { redirectUrl, state }) {
  const seq = String(Date.now());
  const q = new URLSearchParams({
    clientId: cfg.appId,
    seq,
    authorization: sign(cfg.appSecret, `${cfg.appId}_${seq}`),
    redirectUrl,
    grantType: 'authorization_code',
    state,
    nonce: nonce(),
    showQRCode: 'false',
  });
  return `${urls(cfg).oauth}?${q.toString()}`;
}

async function saveTokens({ at, rt, atExpires, rtExpires, region }) {
  const values = { ewelink_at: at, ewelink_rt: rt, ewelink_at_expires: atExpires, ewelink_rt_expires: rtExpires, ewelink_rt_invalid: '' };
  if (region) values.ewelink_region = region;
  await settings.set(values);
}

class EwelinkClient {
  /** @param {object} cfg from settings.getEwelinkConfig() */
  constructor(cfg) {
    this.cfg = { ...cfg };
    this.calls = 0;
  }

  get base() {
    return urls(this.cfg, this.cfg.region);
  }

  /**
   * One HTTP call. auth: 'bearer' (access token), 'sign' (HMAC of the body or query with the app
   * secret) or 'none'. Returns the response's data object; throws EwelinkError on errors.
   */
  async raw(method, url, { query, body, auth = 'bearer' } = {}) {
    const paused = Number(await settings.get('ewelink_quota_paused_until')) || 0;
    if (paused > nowSec()) {
      throw new EwelinkError(`eWeLink API calls are paused until ${new Date(paused * 1000).toISOString().slice(0, 10)}: ${ERRORS[412]}`, { quota: true });
    }
    let qs = '';
    if (query) {
      const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '');
      qs = entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : '';
    }
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Accept: 'application/json', 'X-CK-Appid': this.cfg.appId, 'X-CK-Nonce': nonce() };
    if (text !== undefined) headers['Content-Type'] = 'application/json';
    if (auth === 'bearer') headers.Authorization = `Bearer ${this.cfg.at}`;
    else if (auth === 'sign') {
      // POST: the exact body sent; GET: the query parameters sorted by name.
      const message = text !== undefined ? text : [...new URLSearchParams(qs.slice(1)).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
      headers.Authorization = `Sign ${sign(this.cfg.appSecret, message)}`;
    }

    await pace();
    this.calls += 1;
    await countCall();
    let res;
    try {
      res = await fetch(url + qs, { method, headers, body: text, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new EwelinkError(`Cannot reach eWeLink (${err.cause ? err.cause.code || err.cause.message : err.message})`, { network: true });
    }
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = null;
    }
    // The monthly quota answers HTTP 403 (not JSON) or error 412.
    if ((res.status === 403 && !data) || (data && Number(data.error) === 412)) {
      await settings.set({ ewelink_quota_paused_until: startOfNextMonth() });
      throw new EwelinkError(`eWeLink: ${ERRORS[412]}. Calls resume next month.`, { status: res.status, code: 412, quota: true });
    }
    if (!data) throw new EwelinkError(`eWeLink returned a non-JSON response (HTTP ${res.status})`, { status: res.status });
    const code = Number(data.error);
    if (code) {
      const msg = ERRORS[code] || (data.msg && !/^(ok|success)$/i.test(data.msg) ? `${data.msg} (error ${code})` : `error ${code}`);
      throw new EwelinkError(`eWeLink: ${msg}`, { status: res.status, code, auth: code === 401 || code === 402, data: data.data });
    }
    if (!res.ok) throw new EwelinkError(`eWeLink: HTTP ${res.status}`, { status: res.status });
    return data.data || {};
  }

  // ---------- tokens ----------

  /** Exchanges the code from the sign-in page for tokens (valid 30 s, so call straight away). */
  async exchangeCode(code, redirectUrl, region) {
    this.cfg.region = REGIONS.includes(region) ? region : 'eu';
    const d = await this.raw('POST', `${this.base.api}/v2/user/oauth/token`, {
      body: { code, redirectUrl, grantType: 'authorization_code' },
      auth: 'sign',
    });
    if (!d.accessToken || !d.refreshToken) throw new EwelinkError('eWeLink did not return tokens');
    const tokens = {
      at: d.accessToken,
      rt: d.refreshToken,
      atExpires: Math.floor(Number(d.atExpiredTime) / 1000) || nowSec() + 30 * 86400,
      rtExpires: Math.floor(Number(d.rtExpiredTime) / 1000) || nowSec() + 60 * 86400,
      region: this.cfg.region,
    };
    Object.assign(this.cfg, tokens);
    await saveTokens(tokens);
    return tokens;
  }

  /**
   * Gets a new access token with the refresh token. Several processes may try at once and the
   * refresh token changes each time, so this holds a database lock and re-reads the stored tokens:
   * if another process already refreshed, its tokens are used.
   */
  async refresh(force) {
    const r = await db.withLock(REFRESH_LOCK, async () => {
      const cur = await settings.getEwelinkConfig();
      settings.invalidate();
      const fresh = await settings.getEwelinkConfig();
      Object.assign(this.cfg, { at: fresh.at, rt: fresh.rt, atExpires: fresh.atExpires, rtExpires: fresh.rtExpires, region: fresh.region || cur.region });
      if (!force && this.cfg.atExpires > nowSec() + REFRESH_AHEAD) return;
      if (!this.cfg.rt) throw new EwelinkError('Not connected to eWeLink', { auth: true });
      // eWeLink accepts the access token or the app signature here; a token that expired or was just
      // rejected can't vouch for itself, so the signature is used first then, and the other as a fallback.
      const first = force || this.cfg.atExpires <= nowSec() ? 'sign' : 'bearer';
      const url = `${this.base.api}/v2/user/refresh`;
      let d;
      try {
        d = await this.raw('POST', url, { body: { rt: this.cfg.rt }, auth: first });
      } catch (err) {
        if (!err.auth) throw err;
        try {
          d = await this.raw('POST', url, { body: { rt: this.cfg.rt }, auth: first === 'sign' ? 'bearer' : 'sign' });
        } catch (err2) {
          // The refresh token itself is no longer accepted: only signing in again helps.
          if (err2.auth) await settings.set({ ewelink_rt_invalid: '1' });
          throw err2;
        }
      }
      if (!d.at || !d.rt) throw new EwelinkError('eWeLink did not return new tokens', { auth: true });
      const tokens = { at: d.at, rt: d.rt, atExpires: nowSec() + 30 * 86400, rtExpires: nowSec() + 60 * 86400 };
      Object.assign(this.cfg, tokens);
      await saveTokens(tokens);
    });
    if (!r.locked) {
      // Another process is refreshing; wait for it and use its tokens.
      await sleep(3000);
      settings.invalidate();
      const fresh = await settings.getEwelinkConfig();
      Object.assign(this.cfg, { at: fresh.at, rt: fresh.rt, atExpires: fresh.atExpires, rtExpires: fresh.rtExpires });
    }
  }

  /** Authenticated call: refreshes the token when it is about to expire or is rejected. */
  async call(method, path, opts = {}) {
    if (!this.cfg.rt || !this.cfg.region) throw new EwelinkError('Not connected to eWeLink. Connect your account in Settings.', { auth: true });
    if (this.cfg.atExpires <= nowSec() + REFRESH_AHEAD) await this.refresh();
    try {
      return await this.raw(method, this.base.api + path, opts);
    } catch (err) {
      if (!err.auth) throw err;
      await this.refresh(true);
      return this.raw(method, this.base.api + path, opts);
    }
  }

  // ---------- endpoints (those open to OAuth apps) ----------

  family() {
    return this.call('GET', '/v2/family', { query: { lang: 'en' } });
  }

  /** Every device and group, 30 per page (eWeLink times out on bigger pages). */
  async things() {
    const out = [];
    let total = null;
    for (let begin = -9999999, page = 0; page < 20; page++) {
      const d = await this.call('GET', '/v2/device/thing', { query: { lang: 'en', num: 30, beginIndex: begin } });
      const list = Array.isArray(d.thingList) ? d.thingList : [];
      out.push(...list);
      total = Number(d.total) || out.length;
      if (list.length < 30 || out.length >= total) break;
      const last = list[list.length - 1];
      if (last.index === undefined || last.index === null) break;
      begin = Number(last.index) + 1;
    }
    return { thingList: out, total };
  }

  /** Up to 10 devices at once ([{ itemType, id }]). */
  thingsById(list) {
    return this.call('POST', '/v2/device/thing', { body: { thingList: list.slice(0, 10) } });
  }

  getStatus(deviceid, params) {
    return this.call('GET', '/v2/device/thing/status', { query: { type: 1, id: deviceid, params: params && params.length ? params.join('|') : undefined } });
  }

  /** Sends a command; eWeLink answers an error when the device is offline or rejects it. */
  setStatus(deviceid, params) {
    return this.call('POST', '/v2/device/thing/status', { body: { type: 1, id: deviceid, params } });
  }

  /** Up to 10 commands in one call ([{ id, params }]); waits up to timeout ms for the devices. */
  batchStatus(list, timeout = 5000) {
    return this.call('POST', '/v2/device/thing/batch-status', {
      body: { thingList: list.slice(0, 10).map((x) => ({ type: 1, id: x.id, params: x.params })), timeout },
    });
  }

  /** eWeLink's own operation log for a device (may not be open to free App IDs). */
  history(deviceid, fromMs, num = 30) {
    return this.call('GET', '/v2/device/history', { query: { deviceid, from: fromMs, num } });
  }

  /** Where to open the live (WebSocket) connection. */
  async dispatch() {
    if (this.cfg.atExpires <= nowSec() + REFRESH_AHEAD) await this.refresh();
    const d = await this.rawDispatch();
    return d;
  }

  async rawDispatch() {
    await pace();
    await countCall();
    let res;
    try {
      res = await fetch(this.base.dispatch, { headers: { Authorization: `Bearer ${this.cfg.at}`, 'X-CK-Appid': this.cfg.appId }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw new EwelinkError(`Cannot reach eWeLink (${err.cause ? err.cause.code || err.cause.message : err.message})`, { network: true });
    }
    const data = await res.json().catch(() => null);
    if (!data || Number(data.error)) throw new EwelinkError(`eWeLink dispatch failed (${(data && (data.reason || data.error)) || `HTTP ${res.status}`})`);
    return data;
  }
}

module.exports = { EwelinkClient, EwelinkError, authorizeUrl, urls, usage, sign, nonce, REGIONS, MONTHLY_QUOTA };
