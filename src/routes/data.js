'use strict';

const express = require('express');
const db = require('../db');
const catalog = require('../metrics-catalog');

const router = express.Router();

const NICE_BUCKETS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 604800];
const MAX_POINTS = 2000;

function toMetric(r) {
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    key: r.mkey,
    label: catalog.label(r.mkey, r.name, r.source_type),
    unit: r.unit || '',
    kind: r.value_kind,
    category: catalog.categorize(r.mkey, r.unit, r.source_type),
    quantity: catalog.quantity(r.unit),
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    lastValue: r.value_kind === 'number' ? r.last_value_num : r.last_value_text,
  };
}

function parseIds(value) {
  return String(value || '')
    .split(',')
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(0, 40);
}

function parseRange(q) {
  const now = Math.floor(Date.now() / 1000);
  let to = parseInt(q.to, 10);
  let from = parseInt(q.from, 10);
  if (!Number.isFinite(to)) to = now;
  if (!Number.isFinite(from)) from = to - 86400;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function chooseBucket(requested, span) {
  if (requested === 'raw' || requested === '0') return 0;
  const n = parseInt(requested, 10);
  if (Number.isFinite(n) && n > 0) return n;
  const ideal = span / MAX_POINTS;
  if (ideal <= 60) return 0;
  return NICE_BUCKETS.find((b) => b >= ideal) || NICE_BUCKETS[NICE_BUCKETS.length - 1];
}

router.get('/sources', async (req, res) => {
  const stations = await db.query('SELECT * FROM stations ORDER BY name');
  const devices = await db.query('SELECT * FROM devices ORDER BY device_type, sn');
  const out = stations.map((s) => ({
    id: String(s.id),
    name: s.name || `Station ${s.id}`,
    address: s.address,
    timezone: s.timezone,
    installedCapacity: s.installed_capacity,
    connectionStatus: s.connection_status,
    enabled: Boolean(s.enabled),
    lastTs: s.last_ts,
    devices: [],
  }));
  const byId = new Map(out.map((s) => [s.id, s]));
  const orphans = [];
  for (const d of devices) {
    const dev = {
      sn: d.sn,
      type: d.device_type,
      productId: d.product_id,
      connectStatus: d.connect_status,
      enabled: Boolean(d.enabled),
      lastTs: d.last_ts,
      stationId: d.station_id ? String(d.station_id) : null,
    };
    const st = dev.stationId && byId.get(dev.stationId);
    if (st) st.devices.push(dev);
    else orphans.push(dev);
  }
  res.json({ stations: out, unassignedDevices: orphans });
});

router.get('/metrics', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.sourceType) {
    where.push('source_type = ?');
    params.push(String(req.query.sourceType));
  }
  if (req.query.sourceId) {
    where.push('source_id = ?');
    params.push(String(req.query.sourceId));
  }
  const rows = await db.query(
    `SELECT * FROM metrics ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY source_type, source_id, mkey`,
    params
  );
  res.json({ metrics: rows.map(toMetric) });
});

async function loadSeries(q) {
  const ids = parseIds(q.metrics);
  const { from, to } = parseRange(q);
  const bucket = chooseBucket(q.bucket || 'auto', to - from);
  const agg = { min: 'MIN', max: 'MAX' }[q.agg] || 'AVG';
  // Client time-zone offset (minutes, as returned by Date#getTimezoneOffset) so that
  // daily buckets line up with local midnight.
  const tzOffset = (parseInt(q.tz, 10) || 0) * 60;

  if (!ids.length) return { from, to, bucket, metrics: [], series: [] };
  const metrics = await db.query('SELECT * FROM metrics WHERE id IN (?)', [ids]);

  let rows;
  if (bucket === 0) {
    rows = await db.query(
      'SELECT metric_id, ts AS t, value AS v FROM readings WHERE metric_id IN (?) AND ts BETWEEN ? AND ? ORDER BY metric_id, ts',
      [ids, from, to]
    );
  } else {
    const shift = bucket >= 86400 ? -tzOffset : 0;
    rows = await db.query(
      `SELECT metric_id, FLOOR((ts + ?) / ?) * ? - ? AS t, ${agg}(value) AS v
         FROM readings
        WHERE metric_id IN (?) AND ts BETWEEN ? AND ?
        GROUP BY metric_id, t
        ORDER BY metric_id, t`,
      [shift, bucket, bucket, shift, ids, from, to]
    );
  }

  const byMetric = new Map(ids.map((id) => [id, []]));
  for (const r of rows) {
    const list = byMetric.get(r.metric_id);
    if (list) list.push([Number(r.t) * 1000, Math.round(Number(r.v) * 1000) / 1000]);
  }
  const metricMap = new Map(metrics.map((m) => [m.id, toMetric(m)]));
  return {
    from,
    to,
    bucket,
    agg: agg.toLowerCase(),
    series: ids.filter((id) => metricMap.has(id)).map((id) => ({ metric: metricMap.get(id), points: byMetric.get(id) })),
  };
}

router.get('/series', async (req, res) => {
  res.json(await loadSeries(req.query));
});

router.get('/export.csv', async (req, res) => {
  const data = await loadSeries(req.query);
  const times = new Set();
  const maps = data.series.map((s) => {
    const m = new Map();
    for (const [t, v] of s.points) {
      m.set(t, v);
      times.add(t);
    }
    return m;
  });
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const header = ['timestamp_utc', ...data.series.map((s) => `${s.metric.sourceId} ${s.metric.label}${s.metric.unit ? ` (${s.metric.unit})` : ''}`)];
  const lines = [header.map(esc).join(',')];
  for (const t of [...times].sort((a, b) => a - b)) {
    lines.push([new Date(t).toISOString(), ...maps.map((m) => (m.has(t) ? m.get(t) : ''))].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="deye-export-${data.from}-${data.to}.csv"`);
  res.send(lines.join('\n'));
});

// Text/state history (e.g. running state, battery status) for the event log.
router.get('/events', async (req, res) => {
  const { from, to } = parseRange({ ...req.query, from: req.query.from || Math.floor(Date.now() / 1000) - 7 * 86400 });
  const params = [from, to];
  let filter = '';
  if (req.query.sourceId) {
    filter = 'AND m.source_id = ?';
    params.push(String(req.query.sourceId));
  }
  const rows = await db.query(
    `SELECT t.ts, t.value, m.id, m.source_type, m.source_id, m.mkey, m.name, m.unit
       FROM text_readings t JOIN metrics m ON m.id = t.metric_id
      WHERE t.ts BETWEEN ? AND ? ${filter}
      ORDER BY t.ts DESC LIMIT 500`,
    params
  );
  res.json({
    events: rows.map((r) => ({
      ts: r.ts,
      value: r.value,
      metricId: r.id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      key: r.mkey,
      label: catalog.label(r.mkey, r.name, r.source_type),
    })),
  });
});

// Latest snapshot per station for the overview page.
router.get('/live', async (req, res) => {
  const stations = await db.query('SELECT * FROM stations WHERE enabled = 1 ORDER BY name');
  const metrics = await db.query(
    "SELECT * FROM metrics WHERE source_type = 'station' OR source_id IN (SELECT sn FROM devices WHERE enabled = 1)"
  );
  const devices = await db.query('SELECT sn, station_id, device_type, connect_status, last_ts FROM devices WHERE enabled = 1');
  const today = await db.query(
    `SELECT station_id, mkey, value, day FROM daily_energy
      WHERE day = (SELECT MAX(day) FROM daily_energy d2 WHERE d2.station_id = daily_energy.station_id)`
  );
  const out = stations.map((s) => {
    const id = String(s.id);
    const values = {};
    const metricIds = {};
    for (const m of metrics) {
      if (m.source_type === 'station' && m.source_id === id) {
        values[m.mkey] = m.value_kind === 'number' ? m.last_value_num : m.last_value_text;
        metricIds[m.mkey] = m.id;
      }
    }
    const energy = {};
    let energyDay = null;
    for (const e of today) {
      if (String(e.station_id) === id) {
        energy[e.mkey] = e.value;
        energyDay = e.day;
      }
    }
    const devs = devices
      .filter((d) => String(d.station_id) === id)
      .map((d) => {
        const dm = metrics.filter((m) => m.source_type === 'device' && m.source_id === d.sn);
        return {
          sn: d.sn,
          type: d.device_type,
          connectStatus: d.connect_status,
          lastTs: d.last_ts,
          metrics: dm.map(toMetric),
        };
      });
    return {
      id,
      name: s.name || `Station ${id}`,
      timezone: s.timezone,
      installedCapacity: s.installed_capacity,
      lastTs: s.last_ts,
      values,
      metricIds,
      energy,
      energyDay,
      devices: devs,
    };
  });
  res.json({ stations: out, serverTime: Math.floor(Date.now() / 1000) });
});

router.get('/energy', async (req, res) => {
  const stationId = String(req.query.stationId || '');
  const group = ['day', 'month', 'year'].includes(req.query.group) ? req.query.group : 'day';
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '1970-01-01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '2999-12-31';
  const period = { day: "DATE_FORMAT(day, '%Y-%m-%d')", month: "DATE_FORMAT(day, '%Y-%m')", year: "DATE_FORMAT(day, '%Y')" }[group];
  const params = [from, to];
  let filter = '';
  if (stationId) {
    filter = 'AND station_id = ?';
    params.push(stationId);
  }
  const rows = await db.query(
    `SELECT ${period} AS period, mkey, SUM(value) AS value
       FROM daily_energy
      WHERE day BETWEEN ? AND ? ${filter}
      GROUP BY period, mkey
      ORDER BY period`,
    params
  );
  const periods = new Map();
  const keys = new Set();
  for (const r of rows) {
    if (!periods.has(r.period)) periods.set(r.period, { period: r.period });
    periods.get(r.period)[r.mkey] = r.value === null ? null : Math.round(Number(r.value) * 100) / 100;
    keys.add(r.mkey);
  }
  res.json({
    group,
    keys: [...keys].map((k) => ({ key: k, label: catalog.label(k, null, 'station') })),
    rows: [...periods.values()],
  });
});

// Per-user preferences (saved chart views, dashboard layout, theme).
router.get('/prefs', async (req, res) => {
  const row = await db.one('SELECT prefs FROM users WHERE id = ?', [req.user.id]);
  let prefs = {};
  try {
    prefs = row && row.prefs ? JSON.parse(row.prefs) : {};
  } catch {
    prefs = {};
  }
  res.json({ prefs });
});

router.put('/prefs', async (req, res) => {
  const prefs = req.body && typeof req.body.prefs === 'object' ? req.body.prefs : {};
  const json = JSON.stringify(prefs);
  if (json.length > 500000) return res.status(413).json({ error: 'Preferences too large' });
  await db.query('UPDATE users SET prefs = ? WHERE id = ?', [json, req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
