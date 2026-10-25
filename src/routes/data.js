'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const catalog = require('../metrics-catalog');
const { localDayFormatter } = require('../collector');

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
  const all = await settings.loadAll();
  const out = stations.map((s) => {
    const id = String(s.id);
    let flowMap = {};
    try {
      flowMap = JSON.parse(all[`flow_map:${id}`] || '{}');
    } catch {
      flowMap = {};
    }
    const values = {};
    const metricIds = {};
    const stationMetrics = [];
    for (const m of metrics) {
      if (m.source_type === 'station' && m.source_id === id) {
        values[m.mkey] = m.value_kind === 'number' ? m.last_value_num : m.last_value_text;
        metricIds[m.mkey] = m.id;
        stationMetrics.push(toMetric(m));
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
      lat: s.lat,
      lng: s.lng,
      installedCapacity: s.installed_capacity,
      lastTs: s.last_ts,
      values,
      metricIds,
      metrics: stationMetrics,
      energy,
      energyDay,
      flowMap,
      devices: devs,
    };
  });
  res.json({ stations: out, serverTime: Math.floor(Date.now() / 1000) });
});

// Which reading feeds each power-flow node, and the display names of the grid and generator
// (e.g. "Kadisha", "Eshtirak"). Missing roles fall back to auto-detection in the UI.
const FLOW_ROLES = ['solar', 'load', 'grid', 'generator', 'battery', 'soc', 'gridVoltage', 'generatorVoltage', 'loadVoltage'];
const NAMED_SOURCES = ['grid', 'generator'];
router.put('/flowmap/:stationId', auth.requireAdmin, async (req, res) => {
  const stationId = String(req.params.stationId);
  const station = await db.one('SELECT id FROM stations WHERE id = ?', [stationId]);
  if (!station) return res.status(404).json({ error: 'Station not found' });
  const input = (req.body && req.body.map) || {};
  const map = {};
  for (const role of FLOW_ROLES) {
    const r = input[role];
    if (!r) continue;
    if (r.hidden) {
      map[role] = { hidden: true };
      continue;
    }
    const metricId = parseInt(r.metricId, 10);
    if (!Number.isFinite(metricId)) continue;
    map[role] = { metricId, invert: Boolean(r.invert) };
  }
  const names = {};
  for (const role of NAMED_SOURCES) {
    const n = String((req.body && req.body.names && req.body.names[role]) || '').trim().slice(0, 40);
    if (n) names[role] = n;
  }
  if (Object.keys(names).length) map.names = names;
  await settings.set({ [`flow_map:${stationId}`]: JSON.stringify(map) });
  res.json({ map });
});

// Generator energy per local day (kWh) from its stored power readings: each hour's average
// power counts as that hour's energy. `parts` are { id, scale } as resolved by the UI (scale
// turns the reading into watts, e.g. 1000 for kW).
async function generatorDaily(parts, fromDay, toDay, timeZone) {
  const from = Date.parse(`${fromDay}T00:00:00Z`) / 1000 - 86400;
  const to = Date.parse(`${toDay}T00:00:00Z`) / 1000 + 2 * 86400;
  const rows = await db.query(
    `SELECT metric_id, FLOOR(ts / 3600) AS h, AVG(value) AS v
       FROM readings
      WHERE metric_id IN (?) AND ts BETWEEN ? AND ?
      GROUP BY metric_id, h`,
    [parts.map((p) => p.id), from, to]
  );
  const scale = new Map(parts.map((p) => [p.id, p.scale]));
  const hours = new Map();
  for (const r of rows) hours.set(Number(r.h), (hours.get(Number(r.h)) || 0) + Number(r.v) * scale.get(r.metric_id));
  // Days with readings count even when the generator was off, so they show 0 rather than "no data".
  const dayOf = localDayFormatter(timeZone);
  const days = new Map();
  for (const [h, w] of hours) {
    const day = dayOf(h * 3600);
    if (day < fromDay || day > toDay) continue;
    days.set(day, (days.get(day) || 0) + Math.max(0, w) / 1000);
  }
  return days;
}

function parseParts(value) {
  return String(value || '')
    .split(',')
    .map((p) => {
      const [id, scale] = p.split(':');
      return { id: parseInt(id, 10), scale: scale === undefined ? 1 : Number(scale) };
    })
    .filter((p) => Number.isFinite(p.id) && p.id > 0 && Number.isFinite(p.scale))
    .slice(0, 12);
}

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

  // DeyeCloud's daily statistics have no generator total, so it is computed from the readings.
  const genParts = parseParts(req.query.gen);
  if (genParts.length) {
    const station = stationId ? await db.one('SELECT timezone FROM stations WHERE id = ?', [stationId]) : null;
    const tz = (station && station.timezone) || String(req.query.tz || '') || null;
    const days = await generatorDaily(genParts, from === '1970-01-01' ? '2000-01-01' : from, to === '2999-12-31' ? localDayFormatter(tz)(Date.now() / 1000) : to, tz);
    const len = { day: 10, month: 7, year: 4 }[group];
    const sums = new Map();
    for (const [day, kwh] of days) sums.set(day.slice(0, len), (sums.get(day.slice(0, len)) || 0) + kwh);
    for (const [period, kwh] of sums) {
      if (!periods.has(period)) periods.set(period, { period });
      periods.get(period).generatorValue = Math.round(kwh * 100) / 100;
    }
    keys.add('generatorValue');
  }
  res.json({
    group,
    keys: [...keys].map((k) => ({ key: k, label: k === 'generatorValue' ? 'Generator (day)' : catalog.label(k, null, 'station') })),
    rows: [...periods.values()].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0)),
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
