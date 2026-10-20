'use strict';

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

// Key/value settings stored in MySQL with a short in-memory cache. The cache is short
// because hosting platforms may run several worker processes side by side.
const CACHE_MS = 10 * 1000;
let cache = null;
let cacheAt = 0;

const DEFAULTS = {
  deye_base_url: 'https://eu1-developer.deyecloud.com/v1.0',
  deye_app_id: '',
  deye_app_secret: '',
  deye_login_type: 'email',
  deye_email: '',
  deye_username: '',
  deye_mobile: '',
  deye_country_code: '',
  deye_password_sha256: '',
  deye_company_id: '',
  poll_interval_minutes: '5',
  station_refresh_minutes: '60',
  daily_refresh_minutes: '60',
  auto_gap_fill: '1',
  retention_days: '0',
  backfill_per_tick: '6',
};

async function loadAll(force) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const rows = await db.query('SELECT name, value FROM settings');
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.name] = r.value;
  cache = out;
  cacheAt = Date.now();
  return out;
}

async function get(name) {
  const all = await loadAll();
  return all[name];
}

async function set(values) {
  const entries = Object.entries(values);
  if (!entries.length) return;
  await db.query(
    'INSERT INTO settings (name, value) VALUES ? ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [entries.map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])]
  );
  cache = null;
}

async function getOrCreateSecret(name, envValue) {
  if (envValue) return envValue;
  let value = await get(name);
  if (!value) {
    value = crypto.randomBytes(32).toString('hex');
    // INSERT IGNORE so concurrent workers converge on the same value.
    await db.query('INSERT IGNORE INTO settings (name, value) VALUES (?, ?)', [name, value]);
    cache = null;
    value = await get(name);
  }
  return value;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// DeyeCloud credentials: values saved in the UI win, environment variables are the fallback.
async function getDeyeConfig() {
  const s = await loadAll();
  const env = config.deye;
  const loginType = s.deye_login_type || (env.username ? 'username' : env.mobile ? 'mobile' : 'email');
  return {
    baseUrl: (s.deye_base_url || env.baseUrl || DEFAULTS.deye_base_url).replace(/\/+$/, ''),
    appId: s.deye_app_id || env.appId,
    appSecret: s.deye_app_secret || env.appSecret,
    loginType,
    email: s.deye_email || env.email,
    username: s.deye_username || env.username,
    mobile: s.deye_mobile || env.mobile,
    countryCode: s.deye_country_code || env.countryCode,
    passwordSha256: s.deye_password_sha256 || (env.password ? sha256(env.password) : ''),
    companyId: s.deye_company_id || env.companyId,
  };
}

function isDeyeConfigured(c) {
  const login = c.loginType === 'username' ? c.username : c.loginType === 'mobile' ? c.mobile : c.email;
  return Boolean(c.baseUrl && c.appId && c.appSecret && login && c.passwordSha256);
}

module.exports = {
  DEFAULTS,
  loadAll,
  get,
  set,
  getOrCreateSecret,
  getDeyeConfig,
  isDeyeConfigured,
  sha256,
  invalidate: () => { cache = null; },
};
