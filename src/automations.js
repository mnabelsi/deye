'use strict';

// Automations: "when these conditions hold, do these actions; when they stop holding, do these
// other actions". Conditions read the inverter's state (grid or generator on, battery level, solar,
// home load…), the time and day, and smart devices; actions switch eWeLink devices.
//
// Rules act on changes, like scenes in the eWeLink app: actions run once when the conditions start
// holding (after holding for `holdMinutes`, if set) and the "otherwise" actions once when they stop.
// A rule can also keep its devices in place (`enforce`): if someone switches a device by hand while
// the rule holds, it is switched back (at most every 5 minutes).
//
// While the inverter's data is stale (DeyeCloud not answering, logger offline) conditions about it
// are unknown and the rule waits instead of acting on old values.

const db = require('./db');
const settings = require('./settings');
const { liveStations, flow } = require('./live');
const ewelink = require('./ewelink');
const devices = require('./ewelink/devices');

const LOCK = 'deye_monitor_automations';
const SOURCE_IDLE = 50; // W: same threshold as the Overview
const STALE_MIN = 20; // minutes after which inverter data counts as unknown
const RETRY_EVERY = 5 * 60; // s between retries of failed actions and between enforcements
const POWER_NODES = ['solar', 'load', 'grid', 'generator', 'battery', 'surplus', 'import', 'export', 'charge', 'discharge'];
const OPS = { lt: '<', lte: '≤', gt: '>', gte: '≥' };
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const NODE_LABELS = {
  solar: 'Solar power',
  load: 'Home load',
  grid: 'Grid power (+ import / − export)',
  generator: 'Generator power',
  battery: 'Battery power (+ discharge / − charge)',
  surplus: 'Solar surplus (solar − home load)',
  import: 'Grid import',
  export: 'Grid export',
  charge: 'Battery charging power',
  discharge: 'Battery discharging power',
};

const nowSec = () => Math.floor(Date.now() / 1000);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const compare = (a, op, b) => (op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b);
const fmt = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en', { maximumFractionDigits: d }));
const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// ---------- validation ----------

function cleanOp(op) {
  if (!OPS[op]) throw badRequest('Choose a comparison');
  return op;
}

function cleanNumber(v, label) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw badRequest(`${label}: enter a number`);
  return n;
}

function cleanChannel(c) {
  if (c === null || c === undefined || c === '' || c === 'all') return null;
  const n = parseInt(c, 10);
  if (!Number.isInteger(n) || n < 0 || n > 31) throw badRequest('Invalid channel');
  return n;
}

function cleanCondition(c) {
  if (!c || typeof c !== 'object') throw badRequest('Invalid condition');
  switch (c.type) {
    case 'source':
      if (!['grid', 'generator'].includes(c.source) || !['on', 'off'].includes(c.state)) throw badRequest('Choose grid or generator, on or off');
      return { type: 'source', source: c.source, state: c.state };
    case 'soc':
      return { type: 'soc', op: cleanOp(c.op), value: Math.min(100, Math.max(0, cleanNumber(c.value, 'Battery level'))) };
    case 'power':
      if (!POWER_NODES.includes(c.node)) throw badRequest('Choose what power to compare');
      return { type: 'power', node: c.node, op: cleanOp(c.op), value: cleanNumber(c.value, 'Power') };
    case 'battery':
      if (!['charging', 'discharging', 'idle'].includes(c.state)) throw badRequest('Choose charging, discharging or idle');
      return { type: 'battery', state: c.state };
    case 'time': {
      const from = minutesOf(c.from);
      const to = minutesOf(c.to);
      if (from === null || to === null) throw badRequest('Times must be HH:MM');
      if (from === to) throw badRequest('The time window starts and ends at the same time');
      const days = [...new Set((Array.isArray(c.days) ? c.days : [1, 2, 3, 4, 5, 6, 7]).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
      if (!days.length) throw badRequest('Choose at least one day');
      return { type: 'time', from: String(c.from).padStart(5, '0'), to: String(c.to).padStart(5, '0'), days };
    }
    case 'device':
      if (!c.deviceId) throw badRequest('Choose a device');
      if (!['on', 'off', 'online', 'offline'].includes(c.state)) throw badRequest('Choose a device state');
      return { type: 'device', deviceId: String(c.deviceId), channel: cleanChannel(c.channel), state: c.state };
    case 'deviceReading':
      if (!c.deviceId || !c.key) throw badRequest('Choose a device reading');
      return { type: 'deviceReading', deviceId: String(c.deviceId), key: String(c.key).slice(0, 64), op: cleanOp(c.op), value: cleanNumber(c.value, 'Reading') };
    case 'reading': {
      const id = parseInt(c.metricId, 10);
      if (!Number.isFinite(id)) throw badRequest('Choose an inverter reading');
      return { type: 'reading', metricId: id, op: cleanOp(c.op), value: cleanNumber(c.value, 'Reading') };
    }
    default:
      throw badRequest(`Unknown condition type "${c.type}"`);
  }
}

function cleanAction(a) {
  if (!a || !a.deviceId) throw badRequest('Choose a device for each action');
  if (!['on', 'off'].includes(a.state)) throw badRequest('Actions turn devices on or off');
  return { deviceId: String(a.deviceId), channel: cleanChannel(a.channel), state: a.state };
}

/** Validates a rule from the editor and returns its stored form. */
function cleanRule(input) {
  const r = input || {};
  const name = String(r.name || '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the automation a name');
  const conditions = (Array.isArray(r.conditions) ? r.conditions : []).slice(0, 20).map(cleanCondition);
  if (!conditions.length) throw badRequest('Add at least one condition');
  const actions = (Array.isArray(r.actions) ? r.actions : []).slice(0, 30).map(cleanAction);
  const elseActions = (Array.isArray(r.elseActions) ? r.elseActions : []).slice(0, 30).map(cleanAction);
  if (!actions.length && !elseActions.length) throw badRequest('Add at least one action');
  const hold = Math.round(Number(r.holdMinutes) || 0);
  return {
    name,
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    rule: {
      stationId: r.stationId ? String(r.stationId) : null,
      match: r.match === 'any' ? 'any' : 'all',
      conditions,
      holdMinutes: Math.min(1440, Math.max(0, hold)),
      actions,
      elseActions,
      enforce: Boolean(r.enforce),
    },
  };
}

// ---------- the world as the rules see it ----------

function localClock(timeZone, now = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || undefined, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(now));
    const get = (t) => parts.find((x) => x.type === t).value;
    return { minutes: Number(get('hour')) * 60 + Number(get('minute')), day: DAY_NAMES.indexOf(get('weekday')) + 1, text: `${get('weekday')} ${get('hour')}:${get('minute')}` };
  } catch {
    const d = new Date(now);
    return { minutes: d.getHours() * 60 + d.getMinutes(), day: ((d.getDay() + 6) % 7) + 1, text: d.toTimeString().slice(0, 5) };
  }
}

/** Everything conditions need, read once per run: each station's power flow, and smart devices. */
async function snapshot() {
  const f = await flow();
  const { stations } = await liveStations();
  const pollMin = Number(await settings.get('poll_interval_minutes')) || 5;
  const staleAfter = Math.max(STALE_MIN, pollMin * 3) * 60;
  const now = nowSec();
  const byStation = new Map();
  for (const s of stations) {
    const r = f.resolveFlow(s);
    const v = (role) => (r[role] && !r[role].hidden ? r[role].value : null);
    const solar = v('solar');
    const load = v('load');
    const grid = v('grid');
    const generator = v('generator');
    const battery = v('battery');
    const hasGenerator = !r.generator.hidden && r.generator.parts.length > 0;
    const lastTs = Math.max(s.lastTs || 0, ...s.devices.map((d) => d.lastTs || 0));
    byStation.set(s.id, {
      id: s.id,
      name: s.name,
      timezone: s.timezone,
      names: f.sourceNames(s),
      lastTs,
      stale: !lastTs || now - lastTs > staleAfter,
      values: { solar, load, grid, generator, battery, soc: v('soc') },
      gridOn: r.grid.hidden ? null : f.sourceOn(r.gridVoltage, grid, SOURCE_IDLE),
      genOn: hasGenerator ? f.sourceOn(r.generatorVoltage, generator, SOURCE_IDLE) : null,
      metrics: new Map([...s.metrics, ...s.devices.flatMap((d) => d.metrics)].map((m) => [m.id, m])),
    });
  }
  const devs = new Map((await ewelink.loadAll()).map((d) => [d.deviceid, d]));
  return { stations: byStation, devices: devs, now };
}

function stationFor(rule, snap) {
  if (rule.stationId && snap.stations.has(rule.stationId)) return snap.stations.get(rule.stationId);
  return snap.stations.values().next().value || null;
}

function powerValue(node, v) {
  const pos = (x) => (x === null || x === undefined ? null : Math.max(0, x));
  switch (node) {
    case 'surplus':
      return v.solar === null || v.load === null ? null : v.solar - v.load;
    case 'import':
      return pos(v.grid);
    case 'export':
      return v.grid === null ? null : Math.max(0, -v.grid);
    case 'charge':
      return v.battery === null ? null : Math.max(0, -v.battery);
    case 'discharge':
      return pos(v.battery);
    default:
      return v[node] === undefined ? null : v[node];
  }
}

function deviceName(snap, id) {
  const d = snap.devices.get(id);
  return d ? d.name || id : `device ${id}`;
}

function channelLabel(dev, channel) {
  if (channel === null || channel === undefined || !dev) return '';
  const c = devices.channels(dev).find((x) => x.index === channel);
  return ` (${c ? c.name : `channel ${channel + 1}`})`;
}

/** { ok: true|false|null (unknown), text } for one condition. */
function evaluate(c, rule, snap) {
  const st = stationFor(rule, snap);
  const inverter = ['source', 'soc', 'power', 'battery', 'reading'].includes(c.type);
  if (inverter) {
    if (!st) return { ok: null, text: 'No inverter data yet' };
    if (st.stale) return { ok: null, text: `Inverter data is stale (last ${st.lastTs ? new Date(st.lastTs * 1000).toISOString().slice(11, 16) + ' UTC' : 'never'})` };
  }
  switch (c.type) {
    case 'source': {
      const on = c.source === 'grid' ? st.gridOn : st.genOn;
      const name = c.source === 'grid' ? st.names.grid : st.names.generator;
      if (on === null) return { ok: null, text: `Can't tell whether ${name} is on (no voltage reading)` };
      return { ok: on === (c.state === 'on'), text: `${name} is ${on ? 'on' : 'off'} (wanted ${c.state})` };
    }
    case 'soc': {
      const soc = st.values.soc;
      if (soc === null) return { ok: null, text: 'No battery level reading' };
      return { ok: compare(soc, c.op, c.value), text: `Battery ${fmt(soc)}% (wanted ${OPS[c.op]} ${fmt(c.value)}%)` };
    }
    case 'power': {
      const w = powerValue(c.node, st.values);
      const label = NODE_LABELS[c.node].replace(/ \(.*\)$/, '');
      if (w === null) return { ok: null, text: `No ${label.toLowerCase()} reading` };
      return { ok: compare(w, c.op, c.value), text: `${label} ${fmt(w)} W (wanted ${OPS[c.op]} ${fmt(c.value)} W)` };
    }
    case 'battery': {
      const b = st.values.battery;
      if (b === null) return { ok: null, text: 'No battery power reading' };
      const state = b < -15 ? 'charging' : b > 15 ? 'discharging' : 'idle';
      return { ok: state === c.state, text: `Battery ${state} (wanted ${c.state})` };
    }
    case 'reading': {
      const m = st.metrics.get(c.metricId);
      if (!m) return { ok: null, text: `Reading #${c.metricId} not found` };
      const v = Number(m.lastValue);
      if (m.lastValue === null || !Number.isFinite(v)) return { ok: null, text: `${m.label}: no value` };
      return { ok: compare(v, c.op, c.value), text: `${m.label} ${fmt(v, 2)} ${m.unit} (wanted ${OPS[c.op]} ${fmt(c.value, 2)})` };
    }
    case 'time': {
      const clock = localClock(st ? st.timezone : null);
      const from = minutesOf(c.from);
      const to = minutesOf(c.to);
      // A window past midnight (22:00–06:00) belongs to the day it started on.
      const inWindow = from < to ? clock.minutes >= from && clock.minutes < to : clock.minutes >= from || clock.minutes < to;
      const day = from > to && clock.minutes < to ? ((clock.day + 5) % 7) + 1 : clock.day;
      const dayOk = c.days.length === 7 || c.days.includes(day);
      const days = c.days.length === 7 ? '' : ` on ${c.days.map((d) => DAY_NAMES[d - 1]).join(', ')}`;
      return { ok: inWindow && dayOk, text: `Time ${clock.text} (wanted ${c.from}–${c.to}${days})` };
    }
    case 'device': {
      const dev = snap.devices.get(c.deviceId);
      if (!dev) return { ok: null, text: `Smart device ${c.deviceId} not found` };
      const name = `${dev.name || dev.deviceid}${channelLabel(dev, c.channel)}`;
      if (c.state === 'online' || c.state === 'offline') {
        if (dev.online === null) return { ok: null, text: `${name}: connection unknown` };
        return { ok: dev.online === (c.state === 'online'), text: `${name} is ${dev.online ? 'online' : 'offline'} (wanted ${c.state})` };
      }
      const chs = devices.channels(dev).filter((x) => c.channel === null || x.index === c.channel);
      if (!chs.length || chs.some((x) => !x.state)) return { ok: null, text: `${name}: state unknown` };
      const on = chs.some((x) => x.state === 'on');
      return { ok: on === (c.state === 'on'), text: `${name} is ${on ? 'on' : 'off'} (wanted ${c.state})` };
    }
    case 'deviceReading': {
      const dev = snap.devices.get(c.deviceId);
      if (!dev) return { ok: null, text: `Smart device ${c.deviceId} not found` };
      const r = devices.readings(dev).find((x) => x.key === c.key);
      if (!r || r.kind !== 'number' || r.value === null) return { ok: null, text: `${dev.name}: no ${c.key} reading` };
      return { ok: compare(r.value, c.op, c.value), text: `${dev.name} ${r.label.toLowerCase()} ${fmt(r.value, 2)} ${r.unit} (wanted ${OPS[c.op]} ${fmt(c.value, 2)})` };
    }
    default:
      return { ok: null, text: 'Unknown condition' };
  }
}

function evaluateRule(rule, snap) {
  const results = rule.conditions.map((c) => ({ ...evaluate(c, rule, snap), type: c.type }));
  let ok;
  if (rule.match === 'any') ok = results.some((r) => r.ok === true) ? true : results.some((r) => r.ok === null) ? null : false;
  else ok = results.some((r) => r.ok === false) ? false : results.some((r) => r.ok === null) ? null : true;
  return { ok, results };
}

// ---------- acting ----------

/** Turns actions into one command per device (channels of the same device merged). */
function commandsFor(actions, snap, { onlyDifferent = false } = {}) {
  const byDevice = new Map();
  const skipped = [];
  for (const a of actions) {
    const dev = snap.devices.get(a.deviceId);
    if (!dev) {
      skipped.push(`${a.deviceId}: not found`);
      continue;
    }
    if (onlyDifferent) {
      const chs = devices.channels(dev).filter((x) => a.channel === null || x.index === a.channel);
      if (chs.length && chs.every((x) => x.state === a.state)) continue;
    }
    const params = devices.switchParams(dev, a.channel, a.state);
    if (!params) {
      skipped.push(`${dev.name || dev.deviceid}: has nothing to switch`);
      continue;
    }
    const cur = byDevice.get(dev.deviceid);
    if (!cur) byDevice.set(dev.deviceid, params);
    else if (params.switches && cur.switches) {
      for (const s of params.switches) {
        const i = cur.switches.findIndex((x) => x.outlet === s.outlet);
        if (i >= 0) cur.switches[i] = s;
        else cur.switches.push(s);
      }
    } else byDevice.set(dev.deviceid, params);
  }
  return { list: [...byDevice.entries()].map(([deviceid, params]) => ({ deviceid, params })), skipped };
}

async function logRun(id, branch, status, reason, message) {
  await db.query('INSERT INTO automation_runs (automation_id, ts, branch, status, reason, message) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    nowSec(),
    branch,
    status,
    reason ? String(reason).slice(0, 4000) : null,
    message ? String(message).slice(0, 4000) : null,
  ]);
}

/** Runs actions for an automation and logs the outcome. Returns { status, message }. */
async function act(row, rule, branch, actions, snap, reason, opts = {}) {
  const { list, skipped } = commandsFor(actions, snap, opts);
  if (!list.length) {
    if (skipped.length) await logRun(row.id, branch, 'failed', reason, skipped.join(' · '));
    return { status: skipped.length ? 'failed' : 'nothing', message: skipped.join(' · ') || 'Devices already as wanted' };
  }
  let results;
  try {
    results = await ewelink.commandMany(list, { source: 'automation', automationId: row.id, username: row.name });
  } catch (err) {
    await logRun(row.id, branch, 'failed', reason, err.message);
    return { status: 'failed', message: err.message, retry: true };
  }
  const ok = results.filter((r) => r.ok);
  const lines = results.map((r) => `${deviceName(snap, r.deviceid)}: ${r.summary}${r.ok ? '' : ` — failed: ${r.message}`}`).concat(skipped);
  const status = ok.length === results.length && !skipped.length ? 'ok' : ok.length ? 'partial' : 'failed';
  await logRun(row.id, branch, status, reason, lines.join('\n'));
  return { status, message: lines.join(' · '), retry: !ok.length };
}

function parseRow(row) {
  let rule = null;
  try {
    rule = JSON.parse(row.rule);
  } catch {
    rule = null;
  }
  return rule;
}

async function saveState(row, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  await db.query(`UPDATE automations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => fields[c]), row.id]);
}

/**
 * One automation's step: evaluate, update its memory, act on changes. `matching` remembers the
 * last known result and since when; `fired` which branch ('then' or 'else') last ran.
 */
async function step(row, snap) {
  const rule = parseRow(row);
  if (!rule) return;
  const now = snap.now;
  const ev = evaluateRule(rule, snap);
  const reason = ev.results.map((r) => `${r.ok === true ? '✓' : r.ok === false ? '✗' : '?'} ${r.text}`).join('\n');
  const fields = { checked_ts: now };
  if (ev.ok === null) {
    fields.last_note = `Waiting: ${ev.results.filter((r) => r.ok === null).map((r) => r.text).join('; ')}`.slice(0, 500);
    return saveState(row, fields);
  }
  const matching = ev.ok ? 1 : 0;
  let since = row.matching_since;
  if (row.matching === null || Number(row.matching) !== matching) {
    since = now;
    Object.assign(fields, { matching, matching_since: now });
  }
  const recentAttempt = row.fired_ts && now - row.fired_ts < RETRY_EVERY;
  const want = ev.ok ? 'then' : 'else';
  const actions = ev.ok ? rule.actions : rule.elseActions;
  const heldFor = now - (since || now);
  const holdLeft = ev.ok ? rule.holdMinutes * 60 - heldFor : 0;

  if (row.fired !== want) {
    if (holdLeft > 0) {
      fields.last_note = `Conditions hold; acting in ${Math.ceil(holdLeft / 60)} min`;
    } else if (!actions.length) {
      Object.assign(fields, { fired: want, last_note: ev.ok ? 'Conditions hold (no actions)' : 'Conditions not met' });
    } else if (row.fired_ts && recentAttempt && row.last_note && /^Failed/.test(row.last_note)) {
      fields.last_note = row.last_note; // wait before retrying
    } else {
      const r = await act(row, rule, want, actions, snap, reason);
      fields.fired_ts = now;
      if (r.retry) fields.last_note = `Failed: ${r.message}`.slice(0, 500);
      else Object.assign(fields, { fired: want, last_note: `${want === 'then' ? 'Ran actions' : 'Ran "otherwise" actions'}: ${r.message}`.slice(0, 500) });
    }
  } else if (rule.enforce && actions.length && !recentAttempt) {
    // Keep devices as the rule wants them.
    const { list } = commandsFor(actions, snap, { onlyDifferent: true });
    if (list.length) {
      const r = await act(row, rule, 'enforce', actions, snap, reason, { onlyDifferent: true });
      Object.assign(fields, { fired_ts: now, last_note: `Put devices back: ${r.message}`.slice(0, 500) });
    }
  } else if (!/^(Ran|Put)/.test(row.last_note || '') || row.fired !== want) {
    fields.last_note = ev.ok ? 'Conditions hold' : 'Conditions not met';
  }
  await saveState(row, fields);
}

/** Called every minute by the scheduler and by the cron URL. */
async function tick() {
  const res = await db.withLock(LOCK, async () => {
    if ((await settings.get('automations_enabled')) === '0') return { status: 'paused' };
    const rows = await db.query('SELECT * FROM automations WHERE enabled = 1 ORDER BY sort_index, id');
    if (!rows.length) return { status: 'idle' };
    const cfg = await settings.getEwelinkConfig();
    if (!settings.isEwelinkConnected(cfg)) return { status: 'skipped', message: 'eWeLink is not connected' };
    const snap = await snapshot();
    for (const row of rows) {
      try {
        await step(row, snap);
        // Later rules see what earlier ones switched.
        for (const d of await ewelink.loadAll()) snap.devices.set(d.deviceid, d);
      } catch (err) {
        console.error(`[automations] ${row.name}:`, err.message);
        await saveState(row, { checked_ts: snap.now, last_note: `Error: ${err.message}`.slice(0, 500) }).catch(() => {});
      }
    }
    // Daily: keep the logs from growing forever.
    const last = Number(await settings.get('automation_cleanup_ts')) || 0;
    if (snap.now - last > 86400) {
      await db.query('DELETE FROM automation_runs WHERE ts < ?', [snap.now - 180 * 86400]);
      await db.query('DELETE FROM ewelink_actions WHERE created_ts < ?', [snap.now - 365 * 86400]);
      await settings.set({ automation_cleanup_ts: snap.now });
    }
    return { status: 'ok', rules: rows.length };
  });
  return res.locked ? res.result : { status: 'busy' };
}

// ---------- for the page ----------

function toApi(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    rule: parseRow(row),
    matching: row.matching === null ? null : Boolean(row.matching),
    matchingSince: row.matching_since,
    fired: row.fired,
    firedTs: row.fired_ts,
    checkedTs: row.checked_ts,
    note: row.last_note,
    createdBy: row.created_by,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

/** Evaluates a rule (saved or a draft) right now without acting: what each condition sees. */
async function check(input) {
  const draft = { ...(input || {}), name: (input && input.name) || 'check' };
  // Only the conditions matter here; a placeholder action lets an unfinished draft be checked.
  if (!(draft.actions || []).length && !(draft.elseActions || []).length) draft.actions = [{ deviceId: 'x', state: 'on' }];
  const { rule } = cleanRule(draft);
  const snap = await snapshot();
  const ev = evaluateRule(rule, snap);
  const st = stationFor(rule, snap);
  return { ok: ev.ok, results: ev.results, station: st ? { id: st.id, name: st.name, lastTs: st.lastTs, stale: st.stale } : null };
}

/** Runs a saved automation's actions (or its "otherwise" actions) now, as a test. */
async function runNow(id, branch) {
  const row = await db.one('SELECT * FROM automations WHERE id = ?', [id]);
  if (!row) {
    const err = new Error('Automation not found');
    err.status = 404;
    throw err;
  }
  const rule = parseRow(row);
  const actions = branch === 'else' ? rule.elseActions : rule.actions;
  if (!actions.length) throw badRequest('There are no actions to run');
  const snap = await snapshot();
  return act(row, rule, 'test', actions, snap, `Run by hand (${branch === 'else' ? '"otherwise" actions' : 'actions'})`);
}

module.exports = { tick, cleanRule, check, runNow, toApi, evaluateRule, NODE_LABELS, POWER_NODES };
