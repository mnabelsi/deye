'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');

/** A short fingerprint of everything in a folder (names, sizes and contents). */
function assetVersion(dir) {
  const hash = crypto.createHash('sha1');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else hash.update(p.slice(dir.length)).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 10);
}

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(compression());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, db: 'up', time: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ ok: false, db: 'down', error: err.code || err.message });
    }
  });

  // Called by a hosting cron job; authenticated with a secret key, not a session.
  app.use('/api/cron', require('./routes/cron'));

  // eWeLink's redirect after sign-in: a page navigation, so it answers with a redirect, not JSON.
  app.get('/api/ewelink/callback', require('./routes/ewelink').callback);

  app.use('/api', auth.requireAjaxHeader);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api', auth.requireAuth);
  app.use('/api/users', require('./routes/users'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/collector', require('./routes/collector'));
  app.use('/api/inverter', require('./routes/inverter'));
  app.use('/api/ewelink', require('./routes/ewelink').router);
  app.use('/api/automations', require('./routes/automations'));
  app.use('/api/event-log', require('./routes/events'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api', require('./routes/data'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The package "main" points inside dist/; look for the folder that holds the minified bundle.
  const echartsMain = path.dirname(require.resolve('echarts'));
  const echartsDist = [echartsMain, path.join(echartsMain, 'dist'), path.join(echartsMain, '..', 'dist')].find((d) =>
    fs.existsSync(path.join(d, 'echarts.min.js'))
  );
  app.use('/vendor/echarts', express.static(echartsDist || echartsMain, { maxAge: '7d', fallthrough: false }));

  const publicDir = path.join(__dirname, '..', 'public');
  // Scripts and styles are loaded from /v/<version>/…, where the version changes whenever a file
  // in public/ does. Some hosts serve public/ themselves with no caching headers, so browsers kept
  // running old scripts after an update; a new address per version can't be stale, and the scripts'
  // relative imports follow it. The page itself is always revalidated.
  const version = assetVersion(publicDir);
  const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replace(/(href|src)="\/(css|js)\//g, `$1="/v/${version}/$2/`);
  app.use('/v/:version', (req, res, next) => {
    const current = req.params.version === version;
    express.static(publicDir, {
      index: false,
      fallthrough: false,
      setHeaders: (r) => r.setHeader('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'no-cache'),
    })(req, res, next);
  });
  app.use(express.static(publicDir, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.get('/{*any}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[http]', req.method, req.originalUrl, err);
    res.status(status).json({ error: status >= 500 ? err.publicMessage || err.message || 'Server error' : err.message });
  });

  return app;
}

module.exports = { createApp };
