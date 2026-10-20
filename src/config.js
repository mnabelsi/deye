'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

// Hostinger offers either DB_* variables or a single DATABASE_URL (mysql://user:pass@host:port/name).
function dbFromUrl(url) {
  if (!url) return {};
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : undefined,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    };
  } catch {
    console.error('[config] DATABASE_URL is not a valid URL; ignoring it');
    return {};
  }
}
const dbUrl = dbFromUrl(process.env.DATABASE_URL);

module.exports = {
  port: int('PORT', 3000),
  trustProxy: int('TRUST_PROXY', 1),
  db: {
    host: process.env.DB_HOST || dbUrl.host || 'localhost',
    port: int('DB_PORT', dbUrl.port || 3306),
    user: process.env.DB_USER || dbUrl.user || 'root',
    password: process.env.DB_PASSWORD || dbUrl.password || '',
    database: process.env.DB_NAME || dbUrl.database || 'deye',
    connectionLimit: int('DB_POOL_SIZE', 5),
  },
  // Optional: if not set, a random secret is generated once and stored in the database.
  sessionSecret: process.env.SESSION_SECRET || '',
  // Optional: secret for the HTTP cron endpoint. Generated and stored in the database if missing.
  cronKey: process.env.CRON_KEY || '',
  // Run the collector inside the web process (recommended). Disable if you only use cron.
  schedulerEnabled: !bool('DISABLE_SCHEDULER', false),
  // Optional DeyeCloud defaults; values saved from the Settings page take precedence.
  deye: {
    baseUrl: process.env.DEYE_BASE_URL || '',
    appId: process.env.DEYE_APP_ID || '',
    appSecret: process.env.DEYE_APP_SECRET || '',
    email: process.env.DEYE_EMAIL || '',
    username: process.env.DEYE_USERNAME || '',
    mobile: process.env.DEYE_MOBILE || '',
    countryCode: process.env.DEYE_COUNTRY_CODE || '',
    password: process.env.DEYE_PASSWORD || '',
    companyId: process.env.DEYE_COMPANY_ID || '',
  },
  defaultAdmin: {
    username: 'admin',
    password: '123456',
  },
};
