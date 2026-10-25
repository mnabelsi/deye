'use strict';

const db = require('./db');
const settings = require('./settings');
const { DeyeClient } = require('./deye/client');
const { storeSamples, upsertDailyEnergy, toEpochSeconds } = require('./store');
const { STATION_UNITS } = require('./metrics-catalog');
const inverter = require('./inverter');

const LOCK = 'deye_monitor_collector';
const META_KEYS = new Set(['code', 'msg', 'success', 'requestId', 'lastUpdateTime', 'collectionTime', 'stationId', 'id', 'timeStamp']);
const DAILY_META = new Set(['year', 'month', 'day', 'timeStamp', 'date', 'stationId']);
const TICK_BUDGET_MS = 25000;
const STATION_POWER_KEYS = Object.keys(STATION_UNITS).filter((k) => STATION_UNITS[k] === 'W');
const DAILY_MAX_DAYS = 30;
const HISTORY_POINTS_PER_REQUEST = 5;
// Device types /device/history supports; loggers (COLLECTOR), meters etc. have no history.
const HISTORY_DEVICE_TYPES = new Set(['INVERTER', 'MICRO_INVERTER', 'MICRO_STORAGE_IN_ONE', 'PCS']);
const hasHistory = (device) => !device.device_type || HISTORY_DEVICE_TYPES.has(String(device.device_type).toUpperCase());

// ---------- helpers ----------

function firstArray(obj, names) {
  if (!obj) return [];
  for (const n of names) if (Array.isArray(obj[n])) return obj[n];
  if (obj.data && typeof obj.data === 'object') return firstArray(obj.data, names);
  return [];
}

function pickField(obj, names) {
  for (const n of names) if (obj && obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  return undefined;
}

const pad = (n) => String(n).padStart(2, '0');

// Returns a function giving the calendar date (YYYY-MM-DD) of an epoch instant in an IANA time
// zone, falling back to server local time. Reuse it for many conversions: building the
// formatter is the slow part.
function localDayFormatter(timeZone) {
  if (timeZone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      return (epochSec) => {
        const parts = fmt.formatToParts(new Date(epochSec * 1000));
        const get = (t) => parts.find((p) => p.type === t).value;
        return `${get('year')}-${get('month')}-${get('day')}`;
      };
    } catch {
      /* invalid zone */
    }
  }
  return (epochSec) => {
    const d = new Date(epochSec * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
}

// Calendar date of an instant in a given IANA time zone (falls back to server local time).
function dateInZone(epochSec, timeZone) {
  return localDayFormatter(timeZone)(epochSec);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 3700; d = addDays(d, 1)) out.push(d);
  return out;
}

// Normalises the many shapes DeyeCloud uses for station time zones into an IANA name.
function normaliseTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

async function startRun(kind, trigger) {
  const r = await db.query('INSERT INTO collector_runs (kind, trigger_source, started_at) VALUES (?, ?, UTC_TIMESTAMP(3))', [kind, trigger || null]);
  return r.insertId;
}

async function finishRun(id, status, readings, message) {
  await db.query('UPDATE collector_runs SET finished_at = UTC_TIMESTAMP(3), status = ?, readings_added = ?, message = ? WHERE id = ?', [
    status,
    readings || 0,
    message ? String(message).slice(0, 4000) : null,
    id,
  ]);
}

// ---------- discovery ----------

async function discover(client) {
  const stations = [];
  for (let page = 1; page <= 20; page++) {
    const res = await client.stationList(page, 100);
    const list = firstArray(res, ['stationList', 'list', 'stations']);
    stations.push(...list);
    const total = Number(res.total || 0);
    if (!list.length || list.length < 100 || (total && stations.length >= total)) break;
  }

  for (const s of stations) {
    const id = pickField(s, ['id', 'stationId']);
    if (!id) continue;
    await db.query(
      `INSERT INTO stations (id, name, address, lat, lng, timezone, installed_capacity, grid_type, connection_status, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), address = VALUES(address), lat = VALUES(lat), lng = VALUES(lng),
         timezone = VALUES(timezone), installed_capacity = VALUES(installed_capacity), grid_type = VALUES(grid_type),
         connection_status = VALUES(connection_status), raw = VALUES(raw)`,
      [
        id,
        pickField(s, ['name', 'stationName']) || null,
        pickField(s, ['locationAddress', 'address']) || null,
        Number(pickField(s, ['locationLat', 'lat'])) || null,
        Number(pickField(s, ['locationLng', 'lng'])) || null,
        normaliseTimeZone(pickField(s, ['regionTimezone', 'timezone', 'timeZone'])),
        Number(pickField(s, ['installedCapacity', 'capacity'])) || null,
        pickField(s, ['gridInterconnectionType', 'type']) || null,
        pickField(s, ['connectionStatus', 'status']) !== undefined ? String(pickField(s, ['connectionStatus', 'status'])) : null,
        JSON.stringify(s),
      ]
    );
  }

  const ids = stations.map((s) => pickField(s, ['id', 'stationId'])).filter(Boolean);
  let devices = [];
  if (ids.length) {
    try {
      for (let i = 0; i < ids.length; i += 10) {
        for (let page = 1; page <= 20; page++) {
          const res = await client.stationDevices(ids.slice(i, i + 10), page, 100);
          const list = firstArray(res, ['deviceListItems', 'deviceList', 'list']);
          devices.push(...list);
          if (list.length < 100) break;
        }
      }
    } catch (err) {
      // Older accounts: fall back to the combined station+device listing.
      devices = [];
      const res = await client.stationListWithDevice(1, 100);
      for (const s of firstArray(res, ['stationList', 'list'])) {
        for (const d of firstArray(s, ['deviceListItems', 'deviceList'])) devices.push({ stationId: s.id, ...d });
      }
      if (!devices.length) throw err;
    }
  }

  for (const d of devices) {
    const sn = pickField(d, ['deviceSn', 'sn']);
    if (!sn) continue;
    await db.query(
      `INSERT INTO devices (sn, station_id, device_id, device_type, product_id, connect_status, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE station_id = VALUES(station_id), device_id = VALUES(device_id), device_type = VALUES(device_type),
         product_id = VALUES(product_id), connect_status = VALUES(connect_status), raw = VALUES(raw)`,
      [
        String(sn),
        pickField(d, ['stationId']) || null,
        pickField(d, ['deviceId', 'id']) || null,
        pickField(d, ['deviceType', 'type']) || null,
        pickField(d, ['productId', 'model']) || null,
        pickField(d, ['connectStatus', 'connectionStatus', 'status']) !== undefined ? String(pickField(d, ['connectStatus', 'connectionStatus', 'status'])) : null,
        JSON.stringify(d),
      ]
    );
  }
  await settings.set({ last_discover_ts: Math.floor(Date.now() / 1000) });
  return { stations: stations.length, devices: devices.length };
}

// ---------- latest data ----------

// DeyeCloud leaves a station power field blank when it is zero (e.g. purchasePower while not
// buying). Skipping blanks would leave the last non-zero value showing, so while the frame has any
// power value its blank power fields are stored as 0.
function stationSamples(item, ts) {
  const samples = [];
  for (const [key, value] of Object.entries(item)) {
    if (META_KEYS.has(key) || DAILY_META.has(key) || value === null || typeof value === 'object') continue;
    samples.push({ ts, key, value, unit: STATION_UNITS[key] });
  }
  const blank = (v) => v === null || v === '';
  if (STATION_POWER_KEYS.some((k) => k in item && !blank(item[k]))) {
    for (const key of STATION_POWER_KEYS) if (key in item && blank(item[key])) samples.push({ ts, key, value: 0, unit: 'W' });
  }
  return samples;
}

async function collectStationLatest(client, station) {
  const res = await client.stationLatest(station.id);
  const ts = toEpochSeconds(pickField(res, ['lastUpdateTime', 'collectionTime', 'timeStamp'])) || Math.floor(Date.now() / 1000);
  const added = await storeSamples('station', station.id, stationSamples(res, ts));
  await db.query('UPDATE stations SET last_ts = GREATEST(COALESCE(last_ts, 0), ?) WHERE id = ?', [ts, station.id]);
  return added;
}

function deviceItemsToSamples(list, ts) {
  const out = [];
  for (const it of list || []) {
    const key = pickField(it, ['key', 'name']);
    if (!key) continue;
    out.push({ ts, key, value: it.value, unit: it.unit, name: it.name && it.name !== key ? it.name : null });
  }
  return out;
}

async function collectDevicesLatest(client, devices) {
  let added = 0;
  const errors = [];
  for (let i = 0; i < devices.length; i += 10) {
    const batch = devices.slice(i, i + 10);
    let items = [];
    try {
      items = firstArray(await client.deviceLatest(batch.map((d) => d.sn)), ['deviceDataList', 'dataList', 'list']);
    } catch (err) {
      if (batch.length === 1) {
        errors.push(`Device ${batch[0].sn}: ${err.message}`);
        continue;
      }
      // One unsupported device (e.g. a logger) must not hide the others: retry one by one.
      for (const d of batch) {
        try {
          items.push(...firstArray(await client.deviceLatest([d.sn]), ['deviceDataList', 'dataList', 'list']));
        } catch (e) {
          errors.push(`Device ${d.sn}: ${e.message}`);
        }
      }
    }
    for (const item of items) {
      const sn = String(pickField(item, ['deviceSn', 'sn']) || '');
      if (!sn) continue;
      const ts = toEpochSeconds(pickField(item, ['collectionTime', 'lastUpdateTime', 'updateTime'])) || Math.floor(Date.now() / 1000);
      const samples = deviceItemsToSamples(firstArray(item, ['dataList', 'itemList']), ts);
      if (item.deviceState !== undefined) samples.push({ ts, key: 'deviceState', value: item.deviceState });
      const prev = devices.find((d) => d.sn === sn);
      added += await storeSamples('device', sn, samples);
      await db.query('UPDATE devices SET last_ts = GREATEST(COALESCE(last_ts, 0), ?) WHERE sn = ?', [ts, sn]);
      if (prev) prev.newTs = ts;
    }
  }
  return { added, errors };
}

// ---------- daily energy ----------

function dailyItemDay(it) {
  const y = pickField(it, ['year']);
  const m = pickField(it, ['month']);
  const d = pickField(it, ['day']);
  if (y && m && d) return `${y}-${pad(m)}-${pad(d)}`;
  const date = pickField(it, ['date', 'time']);
  if (date && /^\d{4}-\d{2}-\d{2}/.test(String(date))) return String(date).slice(0, 10);
  const ts = toEpochSeconds(pickField(it, ['timeStamp']));
  return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
}

// DeyeCloud rejects day ranges longer than 30 days ("should be within 31 days"), and returns
// nothing when endAt falls in a month that has not started yet, so the end is clamped.
async function collectDaily(client, station, fromDay, toDayExclusive) {
  const today = dateInZone(Math.floor(Date.now() / 1000), station.timezone);
  let end = [toDayExclusive, addDays(fromDay, DAILY_MAX_DAYS), addDays(today, 1)].sort()[0];
  if (end.slice(0, 7) > today.slice(0, 7)) end = today;
  if (end <= fromDay) return 0;
  const res = await client.stationHistory(station.id, 2, fromDay, end);
  const rows = [];
  for (const it of firstArray(res, ['stationDataItems', 'dataList', 'list'])) {
    const day = dailyItemDay(it);
    if (!day) continue;
    for (const [key, value] of Object.entries(it)) {
      if (DAILY_META.has(key) || typeof value === 'object') continue;
      rows.push({ day, key, value });
    }
  }
  return upsertDailyEnergy(station.id, rows);
}

// ---------- history import (backfill) ----------

async function measurePointsFor(client, device) {
  let raw = {};
  try {
    raw = device.raw ? JSON.parse(device.raw) : {};
  } catch {
    raw = {};
  }
  const cached = raw.__measurePoints;
  if (cached && cached.at > Date.now() / 1000 - 7 * 86400 && cached.list.length) return cached.list;
  const res = await client.deviceMeasurePoints(device.sn);
  let list = firstArray(res, ['measurePoints', 'measurePointList', 'list']).map((p) => (typeof p === 'string' ? p : pickField(p, ['key', 'name', 'measurePoint'])));
  list = [...new Set(list.filter(Boolean).map(String))];
  if (!list.length) {
    // Fall back to the keys we have already seen for this device.
    const rows = await db.query("SELECT mkey FROM metrics WHERE source_type = 'device' AND source_id = ? AND mkey <> 'deviceState'", [device.sn]);
    list = rows.map((r) => r.mkey);
  }
  raw.__measurePoints = { at: Math.floor(Date.now() / 1000), list };
  await db.query('UPDATE devices SET raw = ? WHERE sn = ?', [JSON.stringify(raw), device.sn]);
  return list;
}

async function backfillDeviceDay(client, device, day) {
  if (!hasHistory(device)) return 0;
  const points = await measurePointsFor(client, device);
  if (!points.length) return 0;
  let added = 0;
  // DeyeCloud answers "list too long" for more than 5 measure points per request.
  for (let i = 0; i < points.length; i += HISTORY_POINTS_PER_REQUEST) {
    const res = await client.deviceHistory(device.sn, 1, day, addDays(day, 1), points.slice(i, i + HISTORY_POINTS_PER_REQUEST));
    const samples = [];
    for (const frame of firstArray(res, ['dataList', 'list', 'historyDataList'])) {
      const ts = toEpochSeconds(pickField(frame, ['time', 'collectionTime', 'timeStamp']));
      if (!ts) continue;
      samples.push(...deviceItemsToSamples(firstArray(frame, ['itemList', 'dataList']), ts));
    }
    added += await storeSamples('device', device.sn, samples);
  }
  return added;
}

async function backfillStationDay(client, station, day) {
  // Frame requests without endAt are refused with "invalid param".
  const res = await client.stationHistory(station.id, 1, day, addDays(day, 1));
  const samples = [];
  for (const it of firstArray(res, ['stationDataItems', 'dataList', 'list'])) {
    const ts = toEpochSeconds(pickField(it, ['timeStamp', 'time', 'collectionTime']));
    if (ts) samples.push(...stationSamples(it, ts));
  }
  return storeSamples('station', station.id, samples);
}

async function enqueue(items) {
  if (!items.length) return 0;
  let n = 0;
  for (let i = 0; i < items.length; i += 1000) {
    const r = await db.query(
      `INSERT INTO backfill_queue (kind, target, day) VALUES ?
       ON DUPLICATE KEY UPDATE status = IF(status = 'running', status, 'pending'), attempts = IF(status = 'running', attempts, 0), message = NULL`,
      [items.slice(i, i + 1000).map((x) => [x.kind, String(x.target), x.day])]
    );
    n += r.affectedRows ? Math.min(r.affectedRows, items.slice(i, i + 1000).length) : 0;
  }
  return n;
}

async function enqueueRange(fromDay, toDay) {
  const days = daysBetween(fromDay, toDay);
  const stations = await db.query('SELECT id FROM stations WHERE enabled = 1');
  const devices = (await db.query('SELECT sn, device_type FROM devices WHERE enabled = 1')).filter(hasHistory);
  const items = [];
  for (const day of days) {
    for (const s of stations) items.push({ kind: 'station_day', target: s.id, day });
    for (const d of devices) items.push({ kind: 'device_day', target: d.sn, day });
  }
  // Daily totals are fetched up to 30 days per request.
  for (const s of stations) {
    for (let d = fromDay; d <= toDay; d = addDays(d, DAILY_MAX_DAYS)) items.push({ kind: 'station_daily', target: s.id, day: d });
  }
  await enqueue(items);
  return { days: days.length, items: items.length };
}

async function processBackfill(client, maxItems, deadline) {
  let done = 0;
  let added = 0;
  const errors = [];
  // Reset items left "running" by a process that died.
  await db.query("UPDATE backfill_queue SET status = 'pending' WHERE status = 'running' AND updated_at < UTC_TIMESTAMP() - INTERVAL 15 MINUTE");
  while (done < maxItems && Date.now() < deadline) {
    const item = await db.one("SELECT * FROM backfill_queue WHERE status = 'pending' ORDER BY day DESC, id LIMIT 1");
    if (!item) break;
    await db.query("UPDATE backfill_queue SET status = 'running', attempts = attempts + 1 WHERE id = ?", [item.id]);
    try {
      let n = 0;
      if (item.kind === 'device_day') {
        const dev = await db.one('SELECT * FROM devices WHERE sn = ?', [item.target]);
        if (dev) n = await backfillDeviceDay(client, dev, item.day);
      } else if (item.kind === 'station_day') {
        const st = await db.one('SELECT * FROM stations WHERE id = ?', [item.target]);
        if (st) n = await backfillStationDay(client, st, item.day);
      } else if (item.kind === 'station_daily') {
        const st = await db.one('SELECT * FROM stations WHERE id = ?', [item.target]);
        if (st) n = await collectDaily(client, st, item.day, addDays(item.day, DAILY_MAX_DAYS));
      }
      added += n;
      await db.query("UPDATE backfill_queue SET status = 'done', rows_added = ?, message = NULL WHERE id = ?", [n, item.id]);
    } catch (err) {
      const giveUp = item.attempts + 1 >= 3;
      errors.push(`${item.kind} ${item.target} ${item.day}: ${err.message}`);
      await db.query('UPDATE backfill_queue SET status = ?, message = ? WHERE id = ?', [giveUp ? 'error' : 'pending', err.message.slice(0, 500), item.id]);
      if (err.code === 'NETWORK' || err.auth) break;
    }
    done += 1;
  }
  return { done, added, errors };
}

// After downtime (e.g. the host put the app to sleep) queue the missed days for re-import.
async function queueGaps(devicesBefore, pollIntervalMin) {
  const now = Math.floor(Date.now() / 1000);
  const threshold = Math.max(pollIntervalMin * 60 * 3, 30 * 60);
  const items = [];
  for (const d of devicesBefore) {
    if (!d.last_ts || !d.newTs || !hasHistory(d)) continue;
    if (d.newTs - d.last_ts <= threshold) continue;
    const tz = d.timezone;
    const from = dateInZone(Math.max(d.last_ts, now - 31 * 86400), tz);
    const to = dateInZone(d.newTs, tz);
    for (const day of daysBetween(from, to)) {
      items.push({ kind: 'device_day', target: d.sn, day });
      if (d.station_id) items.push({ kind: 'station_day', target: d.station_id, day });
    }
  }
  return enqueue(items);
}

async function applyRetention(days) {
  if (!days || days <= 0) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const r = await db.query('DELETE FROM readings WHERE ts < ? LIMIT 50000', [cutoff]);
    total += r.affectedRows;
    if (r.affectedRows < 50000) break;
  }
  await db.query('DELETE FROM text_readings WHERE ts < ? LIMIT 50000', [cutoff]);
  return total;
}

// ---------- main entry points ----------

/**
 * One scheduler tick: polls DeyeCloud if due (or forced), then works the history queue.
 * Safe to call from several processes at once; only one runs at a time.
 */
async function tick({ trigger = 'scheduler', force = false, discover: forceDiscover = false, backfill = true } = {}) {
  const res = await db.withLock(LOCK, () => runTick({ trigger, force, forceDiscover, backfill }));
  if (!res.locked) return { status: 'busy', message: 'Another collection is already running' };
  return res.result;
}

async function runTick({ trigger, force, forceDiscover, backfill }) {
  const started = Date.now();
  const deadline = started + TICK_BUDGET_MS;
  const s = await settings.loadAll(true);
  const cfg = await settings.getDeyeConfig();
  if (!settings.isDeyeConfigured(cfg)) return { status: 'skipped', message: 'DeyeCloud credentials are not configured' };

  const now = Math.floor(Date.now() / 1000);
  const pollEvery = Math.max(1, parseInt(s.poll_interval_minutes, 10) || 5) * 60;
  const lastPoll = parseInt(s.last_poll_ts, 10) || 0;
  const due = force || forceDiscover || now - lastPoll >= pollEvery - 15;
  const client = new DeyeClient(cfg);
  const summary = { status: 'ok', polled: false, readings: 0, backfilled: 0, messages: [] };

  if (due) {
    const runId = await startRun('poll', trigger);
    await settings.set({ last_poll_ts: now });
    const errors = [];
    let readings = 0;
    try {
      const stationRefresh = Math.max(10, parseInt(s.station_refresh_minutes, 10) || 60) * 60;
      const stationCount = await db.one('SELECT COUNT(*) AS n FROM stations');
      if (forceDiscover || !stationCount.n || now - (parseInt(s.last_discover_ts, 10) || 0) >= stationRefresh) {
        const d = await discover(client);
        summary.messages.push(`Discovered ${d.stations} station(s), ${d.devices} device(s)`);
      }
      // Inverter settings: read hourly; failures are reported but don't fail the run.
      if (forceDiscover || now - (parseInt(s.last_config_ts, 10) || 0) >= stationRefresh) {
        const failed = await inverter.readAll(client);
        await settings.set({ last_config_ts: now });
        if (failed.length) summary.messages.push(`Inverter settings: ${failed.slice(0, 3).join(' · ')}`);
      } else {
        await inverter.finishPendingReads(client).catch((err) => summary.messages.push(`Inverter settings: ${err.message}`));
      }
      // Changes queued on the Inverter page carry on here if nobody keeps the page open.
      await inverter.processCommands(client, 8000).catch((err) => summary.messages.push(`Inverter changes: ${err.message}`));

      const stations = await db.query('SELECT * FROM stations WHERE enabled = 1');
      for (const st of stations) {
        try {
          readings += await collectStationLatest(client, st);
        } catch (err) {
          errors.push(`Station ${st.id}: ${err.message}`);
        }
      }

      const devices = await db.query(
        'SELECT d.sn, d.station_id, d.device_type, d.last_ts, s.timezone FROM devices d LEFT JOIN stations s ON s.id = d.station_id WHERE d.enabled = 1'
      );
      const dres = await collectDevicesLatest(client, devices);
      readings += dres.added;
      errors.push(...dres.errors);

      const dailyEvery = Math.max(10, parseInt(s.daily_refresh_minutes, 10) || 60) * 60;
      if (force || now - (parseInt(s.last_daily_ts, 10) || 0) >= dailyEvery) {
        for (const st of stations) {
          try {
            const today = dateInZone(now, st.timezone);
            await collectDaily(client, st, addDays(today, -6), addDays(today, 1));
          } catch (err) {
            errors.push(`Daily energy ${st.id}: ${err.message}`);
          }
        }
        await settings.set({ last_daily_ts: now });
      }

      if (s.auto_gap_fill === '1') {
        const queued = await queueGaps(devices, pollEvery / 60);
        if (queued) summary.messages.push(`Queued ${queued} day(s) to fill a data gap`);
      }

      if (now - (parseInt(s.last_retention_ts, 10) || 0) > 86400) {
        const removed = await applyRetention(parseInt(s.retention_days, 10) || 0);
        if (removed) summary.messages.push(`Removed ${removed} readings older than the retention period`);
        await db.query('DELETE FROM collector_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL 30 DAY');
        await settings.set({ last_retention_ts: now });
      }

      summary.polled = true;
      summary.readings = readings;
      summary.status = errors.length ? (readings ? 'partial' : 'error') : 'ok';
      summary.messages.push(`${readings} new reading(s) from ${stations.length} station(s) and ${devices.length} device(s)`);
      if (errors.length) summary.messages.push(...errors.slice(0, 5));
      await finishRun(runId, summary.status, readings, summary.messages.join(' · '));
    } catch (err) {
      summary.status = 'error';
      summary.messages.push(err.message);
      await finishRun(runId, 'error', readings, err.message);
    }
  }

  if (backfill && summary.status !== 'error') {
    const pending = await db.one("SELECT COUNT(*) AS n FROM backfill_queue WHERE status = 'pending'");
    if (pending.n) {
      const runId = await startRun('history', trigger);
      const perTick = Math.max(1, parseInt(s.backfill_per_tick, 10) || 6);
      const b = await processBackfill(client, perTick, deadline);
      summary.backfilled = b.done;
      const msg = `Imported ${b.done} day(s), ${b.added} reading(s); ${Math.max(0, pending.n - b.done)} left${b.errors.length ? ` · ${b.errors.slice(0, 3).join(' · ')}` : ''}`;
      summary.messages.push(msg);
      await finishRun(runId, b.errors.length ? (b.done > b.errors.length ? 'partial' : 'error') : 'ok', b.added, msg);
    }
  }

  summary.message = summary.messages.join(' · ') || 'Nothing to do';
  summary.durationMs = Date.now() - started;
  return summary;
}

/** Checks credentials without touching stored state. */
async function testConnection(cfg) {
  const client = new DeyeClient(cfg, { persistToken: false });
  await client.obtainToken();
  const res = await client.stationList(1, 100);
  const list = firstArray(res, ['stationList', 'list', 'stations']);
  const total = Number(res.total || list.length);
  const names = list.slice(0, 3).map((s) => s.name || s.id).join(', ');
  return { stations: total, message: `Signed in. Found ${total} station(s)${names ? `: ${names}` : ''}.` };
}

module.exports = { tick, testConnection, enqueueRange, discover, dateInZone, localDayFormatter, addDays, daysBetween };
