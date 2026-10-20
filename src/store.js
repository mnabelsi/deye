'use strict';

const db = require('./db');

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const EMPTY = new Set(['', '-', '--', 'null', 'undefined', 'n/a', 'na', 'nan']);
const CHUNK = 2000;

// Normalises a raw value from DeyeCloud into { kind, value } or null when it is empty.
function parseValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? { kind: 'number', value: raw } : null;
  if (typeof raw === 'boolean') return { kind: 'number', value: raw ? 1 : 0 };
  if (typeof raw === 'object') return { kind: 'text', value: JSON.stringify(raw).slice(0, 255) };
  const s = String(raw).trim();
  if (EMPTY.has(s.toLowerCase())) return null;
  if (NUMERIC.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return { kind: 'number', value: n };
  }
  return { kind: 'text', value: s.slice(0, 255) };
}

// DeyeCloud mixes epoch seconds, milliseconds and date strings; normalise to seconds.
function toEpochSeconds(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

async function chunked(rows, fn) {
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) total += await fn(rows.slice(i, i + CHUNK));
  return total;
}

/**
 * Stores samples for one source.
 * samples: [{ ts, key, value, unit?, name? }]
 * Returns the number of new numeric readings written.
 */
async function storeSamples(sourceType, sourceId, samples) {
  sourceId = String(sourceId);
  const byKey = new Map();
  for (const s of samples) {
    if (!s || !s.key || !s.ts) continue;
    const parsed = parseValue(s.value);
    if (!parsed) continue;
    const key = String(s.key).slice(0, 128);
    let g = byKey.get(key);
    if (!g) {
      g = { key, unit: null, name: null, points: [], numeric: 0, text: 0 };
      byKey.set(key, g);
    }
    if (s.unit) g.unit = String(s.unit).slice(0, 32);
    if (s.name) g.name = String(s.name).slice(0, 191);
    g.points.push({ ts: s.ts, ...parsed });
    if (parsed.kind === 'number') g.numeric += 1;
    else g.text += 1;
  }
  if (!byKey.size) return 0;

  const keys = [...byKey.keys()];
  const existing = new Map();
  for (const r of await db.query(
    'SELECT id, mkey, last_ts, last_value_text FROM metrics WHERE source_type = ? AND source_id = ? AND mkey IN (?)',
    [sourceType, sourceId, keys]
  )) {
    existing.set(r.mkey, r);
  }

  const metricRows = [];
  for (const g of byKey.values()) {
    g.points.sort((a, b) => a.ts - b.ts);
    // A key is numeric if most of its samples are; stray text values are then dropped.
    g.kind = g.numeric >= g.text ? 'number' : 'text';
    g.points = g.points.filter((p) => p.kind === g.kind);
    if (!g.points.length) continue;
    const first = g.points[0];
    const last = g.points[g.points.length - 1];
    metricRows.push([
      sourceType,
      sourceId,
      g.key,
      g.name,
      g.unit,
      g.kind,
      first.ts,
      last.ts,
      g.kind === 'number' ? last.value : null,
      g.kind === 'text' ? last.value : null,
    ]);
  }
  if (!metricRows.length) return 0;

  // Assignment order matters: last_ts must be updated after the columns that compare against it.
  await db.query(
    `INSERT INTO metrics (source_type, source_id, mkey, name, unit, value_kind, first_ts, last_ts, last_value_num, last_value_text)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       name = COALESCE(VALUES(name), name),
       unit = COALESCE(VALUES(unit), unit),
       value_kind = VALUES(value_kind),
       first_ts = LEAST(COALESCE(first_ts, VALUES(first_ts)), VALUES(first_ts)),
       last_value_num = IF(VALUES(last_ts) >= COALESCE(last_ts, 0), VALUES(last_value_num), last_value_num),
       last_value_text = IF(VALUES(last_ts) >= COALESCE(last_ts, 0), VALUES(last_value_text), last_value_text),
       last_ts = GREATEST(COALESCE(last_ts, 0), VALUES(last_ts))`,
    [metricRows]
  );

  const ids = new Map();
  for (const r of await db.query('SELECT id, mkey FROM metrics WHERE source_type = ? AND source_id = ? AND mkey IN (?)', [
    sourceType,
    sourceId,
    keys,
  ])) {
    ids.set(r.mkey, r.id);
  }

  const numRows = [];
  const textRows = [];
  for (const g of byKey.values()) {
    const id = ids.get(g.key);
    if (!id || !g.points.length) continue;
    if (g.kind === 'number') {
      for (const p of g.points) numRows.push([id, p.ts, p.value]);
    } else {
      // Only record text values when they change.
      const ex = existing.get(g.key);
      let prev = ex && ex.last_ts && g.points[0].ts > ex.last_ts ? ex.last_value_text : null;
      for (const p of g.points) {
        if (p.value !== prev) textRows.push([id, p.ts, p.value]);
        prev = p.value;
      }
    }
  }

  const added = await chunked(numRows, async (rows) => {
    const r = await db.query('INSERT IGNORE INTO readings (metric_id, ts, value) VALUES ?', [rows]);
    return r.affectedRows || 0;
  });
  await chunked(textRows, async (rows) => {
    const r = await db.query('INSERT IGNORE INTO text_readings (metric_id, ts, value) VALUES ?', [rows]);
    return r.affectedRows || 0;
  });
  return added;
}

async function upsertDailyEnergy(stationId, rows) {
  // rows: [{ day: 'YYYY-MM-DD', key, value }]
  const values = [];
  for (const r of rows) {
    const p = parseValue(r.value);
    if (!p || p.kind !== 'number') continue;
    values.push([String(stationId), r.day, String(r.key).slice(0, 64), p.value]);
  }
  if (!values.length) return 0;
  await db.query(
    'INSERT INTO daily_energy (station_id, day, mkey, value) VALUES ? ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [values]
  );
  return values.length;
}

module.exports = { storeSamples, upsertDailyEnergy, parseValue, toEpochSeconds };
