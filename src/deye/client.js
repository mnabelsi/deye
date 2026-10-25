'use strict';

const crypto = require('crypto');
const settings = require('../settings');

class DeyeError extends Error {
  constructor(message, { status, code, body, auth } = {}) {
    super(message);
    this.name = 'DeyeError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.auth = Boolean(auth);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DeyeCloud answers with { code: '1000000', success: true, msg: 'success', ... } on success.
function isSuccess(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.success === false) return false;
  if (data.code !== undefined && data.code !== null && String(data.code) !== '1000000' && data.success !== true) return false;
  return true;
}

function looksLikeAuthError(status, data) {
  if (status === 401 || status === 403) return true;
  const text = `${(data && (data.msg || data.message)) || ''} ${(data && data.code) || ''}`.toLowerCase();
  return /token|unauthori[sz]ed|auth.*(fail|invalid|expire)|login.*expire/.test(text);
}

function credentialFingerprint(cfg) {
  return crypto
    .createHash('sha256')
    .update([cfg.baseUrl, cfg.appId, cfg.appSecret, cfg.loginType, cfg.email, cfg.username, cfg.mobile, cfg.countryCode, cfg.passwordSha256, cfg.companyId].join('|'))
    .digest('hex');
}

class DeyeClient {
  /**
   * @param {object} cfg from settings.getDeyeConfig()
   * @param {object} [opts] { persistToken: true, minIntervalMs: 250 }
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.persistToken = opts.persistToken !== false;
    this.minIntervalMs = opts.minIntervalMs !== undefined ? opts.minIntervalMs : 250;
    this.token = null;
    this.lastRequestAt = 0;
    this.requests = 0;
  }

  async pace() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async rawRequest(method, path, body, headers) {
    await this.pace();
    this.requests += 1;
    let res;
    try {
      res = await fetch(this.cfg.baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new DeyeError(`Cannot reach DeyeCloud (${err.cause ? err.cause.code || err.cause.message : err.message})`, { code: 'NETWORK' });
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new DeyeError(`DeyeCloud returned a non-JSON response (HTTP ${res.status})`, { status: res.status, body: text.slice(0, 300) });
    }
    return { status: res.status, ok: res.ok, data };
  }

  async obtainToken() {
    const c = this.cfg;
    const body = { appSecret: c.appSecret, password: c.passwordSha256 };
    if (c.loginType === 'username') body.username = c.username;
    else if (c.loginType === 'mobile') {
      body.mobile = c.mobile;
      body.countryCode = c.countryCode;
    } else body.email = c.email;
    if (c.companyId) body.companyId = c.companyId;

    const { status, ok, data } = await this.rawRequest('POST', `/account/token?appId=${encodeURIComponent(c.appId)}`, body);
    if (!ok || !isSuccess(data) || !data.accessToken) {
      throw new DeyeError(`DeyeCloud sign-in failed: ${(data && data.msg) || `HTTP ${status}`}`, { status, code: data && data.code, body: data, auth: true });
    }
    const expiresIn = parseInt(data.expiresIn, 10);
    const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 30 * 86400;
    this.token = data.accessToken;
    if (this.persistToken) {
      await settings.set({
        deye_token: data.accessToken,
        deye_token_expires: Math.floor(Date.now() / 1000) + ttl,
        deye_token_fp: credentialFingerprint(c),
      });
    }
    return this.token;
  }

  async getToken() {
    if (this.token) return this.token;
    if (this.persistToken) {
      const s = await settings.loadAll(true);
      const fresh = Number(s.deye_token_expires || 0) > Math.floor(Date.now() / 1000) + 3600;
      if (s.deye_token && fresh && s.deye_token_fp === credentialFingerprint(this.cfg)) {
        this.token = s.deye_token;
        return this.token;
      }
    }
    return this.obtainToken();
  }

  async invalidateToken() {
    this.token = null;
    if (this.persistToken) await settings.set({ deye_token: '', deye_token_expires: '0' });
  }

  /** Authenticated call with one re-login on auth errors and backoff on rate limiting. */
  async call(path, body, { method = 'POST', retries = 2 } = {}) {
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const { status, ok, data } = await this.rawRequest(method, path, body, { Authorization: `bearer ${token}` });
      if (ok && isSuccess(data)) return data;

      if (!reauthed && looksLikeAuthError(status, data)) {
        reauthed = true;
        await this.invalidateToken();
        continue;
      }
      const msg = (data && (data.msg || data.message)) || `HTTP ${status}`;
      const rateLimited = status === 429 || /frequen|too many|limit/i.test(msg);
      if ((rateLimited || status >= 500) && attempt < retries) {
        await sleep(rateLimited ? 5000 * (attempt + 1) : 2000 * (attempt + 1));
        continue;
      }
      throw new DeyeError(`${path}: ${msg}`, { status, code: data && data.code, body: data });
    }
  }

  // ---- Endpoints ----
  accountInfo() {
    return this.call('/account/info', {});
  }

  stationList(page = 1, size = 100) {
    return this.call('/station/list', { page, size });
  }

  stationListWithDevice(page = 1, size = 100) {
    return this.call('/station/listWithDevice', { page, size });
  }

  stationLatest(stationId) {
    return this.call('/station/latest', { stationId: Number(stationId) });
  }

  stationDevices(stationIds, page = 1, size = 100) {
    return this.call('/station/device', { page, size, stationIds: stationIds.map(Number) });
  }

  stationHistory(stationId, granularity, startAt, endAt) {
    const body = { stationId: Number(stationId), granularity, startAt };
    if (endAt) body.endAt = endAt;
    return this.call('/station/history', body);
  }

  deviceList(page = 1, size = 100) {
    return this.call('/device/list', { page, size });
  }

  deviceLatest(deviceSns) {
    return this.call('/device/latest', { deviceList: deviceSns });
  }

  deviceMeasurePoints(deviceSn) {
    return this.call('/device/measurePoints', { deviceSn });
  }

  // Read-only views of the inverter's settings (the app never writes settings).
  configBattery(deviceSn) {
    return this.call('/config/battery', { deviceSn });
  }

  configSystem(deviceSn) {
    return this.call('/config/system', { deviceSn });
  }

  configTou(deviceSn) {
    return this.call('/config/tou', { deviceSn });
  }

  deviceHistory(deviceSn, granularity, startAt, endAt, measurePoints) {
    const body = { deviceSn, granularity, startAt };
    if (endAt) body.endAt = endAt;
    if (measurePoints) body.measurePoints = measurePoints;
    return this.call('/device/history', body);
  }
}

module.exports = { DeyeClient, DeyeError, isSuccess, credentialFingerprint };
