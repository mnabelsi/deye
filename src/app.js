'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');

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

  app.use('/api', auth.requireAjaxHeader);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api', auth.requireAuth);
  app.use('/api/users', require('./routes/users'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/collector', require('./routes/collector'));
  app.use('/api/inverter', require('./routes/inverter'));
  app.use('/api', require('./routes/data'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The package "main" points inside dist/; look for the folder that holds the minified bundle.
  const echartsMain = path.dirname(require.resolve('echarts'));
  const echartsDist = [echartsMain, path.join(echartsMain, 'dist'), path.join(echartsMain, '..', 'dist')].find((d) =>
    fs.existsSync(path.join(d, 'echarts.min.js'))
  );
  app.use('/vendor/echarts', express.static(echartsDist || echartsMain, { maxAge: '7d', fallthrough: false }));

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(
    express.static(publicDir, {
      maxAge: '1h',
      setHeaders(res, file) {
        if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
  app.get('/{*any}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
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
