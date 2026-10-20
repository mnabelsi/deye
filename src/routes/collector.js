'use strict';

const express = require('express');
const db = require('../db');
const settings = require('../settings');
const auth = require('../auth');
const config = require('../config');
const collector = require('../collector');
const scheduler = require('../scheduler');

const router = express.Router();

const toTs = (dt) => (dt ? Math.floor(Date.parse(`${dt.replace(' ', 'T')}Z`) / 1000) : null);

router.get('/status', async (req, res) => {
  const s = await settings.loadAll(true);
  const cfg = await settings.getDeyeConfig();
  const lastPoll = await db.one("SELECT * FROM collector_runs WHERE kind = 'poll' AND status <> 'running' ORDER BY id DESC LIMIT 1");
  const queue = await db.query('SELECT status, COUNT(*) AS n FROM backfill_queue GROUP BY status');
  const counts = { pending: 0, running: 0, done: 0, error: 0 };
  for (const q of queue) counts[q.status] = q.n;
  const out = {
    configured: settings.isDeyeConfigured(cfg),
    schedulerEnabled: config.schedulerEnabled && scheduler.isRunning(),
    pollIntervalMinutes: parseInt(s.poll_interval_minutes, 10) || 5,
    lastPoll: lastPoll
      ? { status: lastPoll.status, finishedTs: toTs(lastPoll.finished_at), message: lastPoll.message, readingsAdded: lastPoll.readings_added }
      : null,
    backfillPending: counts.pending + counts.running,
  };
  if (req.query.brief) return res.json(out);

  const runs = await db.query('SELECT * FROM collector_runs ORDER BY id DESC LIMIT 40');
  const lastError = await db.one("SELECT message FROM backfill_queue WHERE status = 'error' ORDER BY updated_at DESC LIMIT 1");
  const [readings, textReadings, metrics, stations, devices, oldest, size] = await Promise.all([
    db.one('SELECT COUNT(*) AS n FROM readings'),
    db.one('SELECT COUNT(*) AS n FROM text_readings'),
    db.one('SELECT COUNT(*) AS n FROM metrics'),
    db.one('SELECT COUNT(*) AS n FROM stations'),
    db.one('SELECT COUNT(*) AS n FROM devices'),
    db.one('SELECT MIN(first_ts) AS ts FROM metrics'),
    db
      .one('SELECT ROUND(SUM(data_length + index_length) / 1048576, 1) AS mb FROM information_schema.tables WHERE table_schema = DATABASE()')
      .catch(() => ({ mb: null })),
  ]);
  const lastPollTs = parseInt(s.last_poll_ts, 10) || 0;
  res.json({
    ...out,
    nextRunTs: lastPollTs ? lastPollTs + out.pollIntervalMinutes * 60 : null,
    runs: runs.map((r) => {
      const st = toTs(r.started_at);
      const fin = r.finished_at ? Date.parse(`${r.finished_at.replace(' ', 'T')}Z`) : null;
      return {
        id: r.id,
        kind: r.kind,
        trigger: r.trigger_source,
        status: r.status,
        startedTs: st,
        durationMs: fin ? fin - Date.parse(`${r.started_at.replace(' ', 'T')}Z`) : null,
        readingsAdded: r.readings_added,
        message: r.message,
      };
    }),
    backfill: { ...counts, lastError: lastError ? lastError.message : null },
    db: {
      readings: readings.n,
      textReadings: textReadings.n,
      metrics: metrics.n,
      stations: stations.n,
      devices: devices.n,
      oldestTs: oldest.ts,
      sizeMb: size && size.mb !== null ? Number(size.mb) : null,
    },
  });
});

router.use(auth.requireAdmin);

router.post('/run', async (req, res) => {
  const r = await collector.tick({ trigger: 'manual', force: true, discover: Boolean(req.body && req.body.discover), backfill: false });
  if (r.status === 'busy') return res.status(409).json({ error: r.message });
  res.json(r);
});

router.post('/backfill', async (req, res) => {
  const { from, to } = req.body || {};
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) {
    return res.status(400).json({ error: 'Choose a valid date range' });
  }
  const stations = await db.one('SELECT COUNT(*) AS n FROM stations');
  if (!stations.n) return res.status(400).json({ error: 'No stations discovered yet. Save your DeyeCloud connection first.' });
  const r = await collector.enqueueRange(from, to);
  res.json({ ...r, message: `Queued ${r.days} day(s) (${r.items} download jobs). Import runs in the background.` });
});

router.post('/backfill/retry', async (req, res) => {
  await db.query("UPDATE backfill_queue SET status = 'pending', attempts = 0 WHERE status = 'error'");
  res.json({ ok: true });
});

router.post('/backfill/clear', async (req, res) => {
  await db.query("DELETE FROM backfill_queue WHERE status <> 'running'");
  res.json({ ok: true });
});

module.exports = router;
