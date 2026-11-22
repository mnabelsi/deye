'use strict';

// WhatsApp notifications, sent through a WAHA server (src/waha.js).
//
// Each notification rule watches one kind of event: the grid or the generator coming on or going
// off, the battery reaching or dropping to chosen levels, any automation-style condition starting
// (or stopping) to hold, the inverter's data going stale, DeyeCloud collection failing, smart
// devices going offline, automations running or failing, inverter settings being changed, and a
// daily summary at a chosen time. Rules are checked every minute, with the automations, from the
// same live snapshot, so "grid on" means the same as on the Overview and in automations.
//
// Like automations, rules act on changes: the first time a rule looks it only notes what it sees,
// and later runs send a message when that changes. Messages go into notification_log first and are
// sent from there, so a WAHA server that is briefly down gets them a little later, and messages
// during quiet hours can be held and sent together when the quiet hours end.

const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');
const waha = require('./waha');
const automations = require('./automations');
const { liveStations, flow } = require('./live');

const LOCK = 'deye_monitor_notifications';
const TYPES = ['source', 'soc', 'condition', 'stale', 'collector', 'device', 'automation', 'inverter', 'summary'];
const QUIET = ['hold', 'skip', 'send'];
const HYSTERESIS = 2; // % the battery must move back before the same level can be crossed again
const RETRY_FOR = 3600; // s a message is retried while WAHA can't be reached
const MAX_ATTEMPTS = 8;
const HELD_FOR = 24 * 3600; // s a held message waits for the quiet hours to end
const SUMMARY_LATE = 3 * 3600; // s after its time a missed summary is still sent
const MAX_RECIPIENTS = 20;
const MAX_TEXT = 4000;

const nowSec = () => Math.floor(Date.now() / 1000);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const intIn = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// ---------- formatting ----------

function dur(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const h = Math.round(m / 60);
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

const num = (v, d = 0) => Number(v).toLocaleString('en', { maximumFractionDigits: d });
const watts = (w) => (w === null || w === undefined ? '—' : Math.abs(w) >= 1000 ? `${num(w / 1000, 2)} kW` : `${num(w)} W`);
const kwh = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${num(v, 1)} kWh`);
const pct = (v) => (v === null || v === undefined ? '—' : `${num(v)}%`);
const pad = (n) => String(n).padStart(2, '0');
const hm = (minute) => `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;
const spans = (list) => list.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(', ');

function timeIn(ts, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(11, 16);
  }
}

function dateIn(ts, tz, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toDateString();
  }
}

/** YYYY-MM-DD in a zone. */
function dayIn(ts, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
}

/** Fills {placeholders} in a custom message; unknown ones are left as they are. */
function render(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

const PLACEHOLDERS = {
  event: 'the standard message for this event',
  name: 'this notification’s name',
  station: 'the station’s name',
  time: 'the time (HH:MM)',
  date: 'the date',
  soc: 'battery level',
  solar: 'solar power',
  load: 'home load',
  grid: 'the grid: on / off',
  generator: 'the generator: on / off',
  grid_power: 'grid power',
  generator_power: 'generator power',
  battery_power: 'battery power (+ discharging / − charging)',
  duration: 'how long the previous state lasted',
  level: 'the battery level crossed (battery notifications)',
};

// ---------- settings: recipients, quiet hours ----------

function parseRecipients(text) {
  try {
    const list = JSON.parse(text || '[]');
    return Array.isArray(list) ? list.filter((r) => r && r.id && r.chatId) : [];
  } catch {
    return [];
  }
}

async function recipients() {
  return parseRecipients(await settings.get('notify_recipients'));
}

async function saveRecipients(input) {
  const list = (Array.isArray(input) ? input : []).slice(0, MAX_RECIPIENTS).map((r) => {
    const chatId = waha.toChatId(r && (r.chatId || r.number));
    if (!chatId) throw badRequest(`${(r && r.name) || 'A recipient'}: enter a number with its country code, or a chat ID`);
    return {
      id: /^[a-z0-9]{4,16}$/.test(String(r.id || '')) ? String(r.id) : crypto.randomBytes(4).toString('hex'),
      name: String(r.name || '').trim().slice(0, 60) || waha.describeChat(chatId),
      chatId,
      enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    };
  });
  const seen = new Set();
  for (const r of list) {
    if (seen.has(r.chatId)) throw badRequest(`${waha.describeChat(r.chatId)} is in the list twice`);
    seen.add(r.chatId);
  }
  await settings.set({ notify_recipients: JSON.stringify(list) });
  return list;
}

function inWindow(minutes, from, to) {
  if (from === null || to === null || from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

async function options() {
  const s = await settings.loadAll();
  return {
    enabled: s.notify_enabled !== '0',
    quietFrom: s.notify_quiet_from || '',
    quietTo: s.notify_quiet_to || '',
    title: s.notify_title || '',
  };
}

async function saveOptions(input) {
  const o = input || {};
  const out = {};
  if (o.enabled !== undefined) out.notify_enabled = o.enabled ? '1' : '0';
  for (const [k, name] of [['quietFrom', 'notify_quiet_from'], ['quietTo', 'notify_quiet_to']]) {
    if (o[k] === undefined) continue;
    const v = String(o[k] || '').trim();
    if (v && automations.minutesOf(v) === null) throw badRequest('Quiet hours must be HH:MM');
    out[name] = v ? v.padStart(5, '0') : '';
  }
  if (o.title !== undefined) out.notify_title = String(o.title || '').trim().slice(0, 60);
  await settings.set(out);
  return options();
}

// ---------- rules ----------

function cleanLevels(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 100);
  return [...new Set(list)].sort((a, b) => a - b).slice(0, 8);
}

/** Validates a rule from the editor and returns { name, enabled, rule }. */
function cleanRule(input) {
  const r = input || {};
  const name = String(r.name || '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the notification a name');
  if (!TYPES.includes(r.type)) throw badRequest('Choose what to be notified about');
  const rule = {
    type: r.type,
    stationId: r.stationId ? String(r.stationId) : null,
    recipients: [...new Set((Array.isArray(r.recipients) ? r.recipients : []).map(String))].slice(0, MAX_RECIPIENTS),
    message: String(r.message || '').slice(0, 1000),
    messageEnd: String(r.messageEnd || '').slice(0, 1000),
    cooldownMinutes: intIn(r.cooldownMinutes, 0, 1440, 0),
    quiet: QUIET.includes(r.quiet) ? r.quiet : 'hold',
  };
  switch (r.type) {
    case 'source':
      if (!['grid', 'generator'].includes(r.source)) throw badRequest('Choose the grid or the generator');
      Object.assign(rule, { source: r.source, on: Boolean(r.on), off: Boolean(r.off), holdMinutes: intIn(r.holdMinutes, 0, 240, 0) });
      if (!rule.on && !rule.off) throw badRequest('Choose “comes on”, “goes off” or both');
      break;
    case 'soc':
      Object.assign(rule, { levels: cleanLevels(r.levels), up: Boolean(r.up), down: Boolean(r.down) });
      if (!rule.levels.length) throw badRequest('Enter at least one battery level (1–100)');
      if (!rule.up && !rule.down) throw badRequest('Choose “reaches”, “drops to” or both');
      break;
    case 'condition': {
      const conditions = (Array.isArray(r.conditions) ? r.conditions : []).slice(0, 20).map(automations.cleanCondition);
      if (!conditions.length) throw badRequest('Add at least one condition');
      Object.assign(rule, { match: r.match === 'any' ? 'any' : 'all', conditions, holdMinutes: intIn(r.holdMinutes, 0, 1440, 0), whenStops: Boolean(r.whenStops) });
      break;
    }
    case 'stale':
      Object.assign(rule, { minutes: intIn(r.minutes, 10, 1440, 30), whenBack: Boolean(r.whenBack) });
      break;
    case 'collector':
      Object.assign(rule, { errors: intIn(r.errors, 1, 50, 3), whenBack: Boolean(r.whenBack) });
      break;
    case 'device':
      Object.assign(rule, { deviceId: r.deviceId ? String(r.deviceId) : null, offline: Boolean(r.offline), online: Boolean(r.online), holdMinutes: intIn(r.holdMinutes, 0, 240, 5) });
      if (!rule.offline && !rule.online) throw badRequest('Choose “goes offline”, “comes back online” or both');
      break;
    case 'automation':
      Object.assign(rule, { automationId: r.automationId ? intIn(r.automationId, 1, 2 ** 31, null) : null, only: r.only === 'all' ? 'all' : 'failed' });
      break;
    case 'inverter':
      rule.only = r.only === 'failed' ? 'failed' : 'all';
      break;
    case 'summary': {
      if (automations.minutesOf(r.at) === null) throw badRequest('The summary time must be HH:MM');
      const days = [...new Set((Array.isArray(r.days) ? r.days : [1, 2, 3, 4, 5, 6, 7]).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
      if (!days.length) throw badRequest('Choose at least one day');
      Object.assign(rule, { at: String(r.at).padStart(5, '0'), days, energy: Boolean(r.energy), sources: Boolean(r.sources), battery: Boolean(r.battery), forecast: Boolean(r.forecast) });
      if (!rule.energy && !rule.sources && !rule.battery && !rule.forecast) throw badRequest('Choose at least one thing for the summary');
      break;
    }
    default:
      break;
  }
  return { name, enabled: r.enabled === undefined ? true : Boolean(r.enabled), rule };
}

function parseJson(text, def) {
  try {
    return text ? JSON.parse(text) : def;
  } catch {
    return def;
  }
}

function toApi(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    rule: parseJson(row.rule, null),
    checkedTs: row.checked_ts,
    sentTs: row.sent_ts,
    note: row.last_note,
    createdBy: row.created_by,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

// ---------- the world as rules see it ----------

/** What every rule reads, once per run. Expensive parts are read only when a rule asks. */
async function context() {
  const snap = await automations.snapshot();
  const tz = (await automations.timeZone()).timeZone;
  const opts = await options();
  const ew = await settings.getEwelinkConfig();
  const live = { value: null };
  return {
    snap,
    now: snap.now,
    tz,
    clock: automations.localClock(tz),
    opts,
    ewelinkConnected: settings.isEwelinkConnected(ew),
    multiStation: snap.stations.size > 1,
    async live() {
      if (!live.value) live.value = await liveStations();
      return live.value;
    },
  };
}

function stationOf(rule, ctx) {
  const s = ctx.snap.stations;
  return (rule.stationId && s.get(rule.stationId)) || s.values().next().value || null;
}

function vars(rule, ctx, extra = {}) {
  const st = stationOf(rule, ctx);
  const v = st ? st.values : {};
  const fresh = st && !st.stale;
  const onOff = (x) => (x === null || x === undefined || !fresh ? 'unknown' : x ? 'on' : 'off');
  return {
    name: rule.name,
    station: st ? st.name : '',
    time: timeIn(ctx.now, ctx.tz),
    date: dateIn(ctx.now, ctx.tz),
    soc: fresh ? pct(v.soc) : '—',
    solar: fresh ? watts(v.solar) : '—',
    load: fresh ? watts(v.load) : '—',
    grid: st ? onOff(st.gridOn) : 'unknown',
    generator: st ? onOff(st.genOn) : 'unknown',
    grid_power: fresh ? watts(v.grid) : '—',
    generator_power: fresh ? watts(v.generator) : '—',
    battery_power: fresh ? watts(v.battery) : '—',
    ...extra,
  };
}

/** "Battery 45% · Home 850 W" (and the sources that are on), for the end of a message. */
function stateLine(rule, ctx, { sources = false, battery = true } = {}) {
  const st = stationOf(rule, ctx);
  if (!st || st.stale) return '';
  const parts = [];
  if (battery && st.values.soc !== null) parts.push(`Battery ${pct(st.values.soc)}`);
  if (st.values.load !== null) parts.push(`Home ${watts(st.values.load)}`);
  if (sources) {
    if (st.gridOn !== null) parts.push(`${st.names.grid} ${st.gridOn ? 'on' : 'off'}`);
    if (st.genOn !== null) parts.push(`${st.names.generator} ${st.genOn ? 'on' : 'off'}`);
  }
  return parts.join(' · ');
}

const lines = (...xs) => xs.filter(Boolean).join('\n');
const where = (rule, ctx) => {
  const st = stationOf(rule, ctx);
  return ctx.multiStation && st ? ` (${st.name})` : '';
};

/**
 * A yes/no value that must hold `holdSec` before it counts as changed. `t` is the rule's memory:
 * { v, since, exact } and, while a change waits out the hold, { pv, psince }. Returns the change,
 * with how long the previous value lasted (`atLeast` when its start wasn't seen), or null.
 */
function track(t, value, now, holdSec) {
  if (value === null || value === undefined) return null;
  if (t.v === undefined || t.v === null) {
    Object.assign(t, { v: value, since: now, exact: false });
    delete t.pv;
    delete t.psince;
    return null;
  }
  if (value === t.v) {
    delete t.pv;
    delete t.psince;
    return null;
  }
  if (t.pv !== value) Object.assign(t, { pv: value, psince: now });
  if (now - t.psince < holdSec) return null;
  const change = { value, at: t.psince, prevFor: t.psince - t.since, atLeast: !t.exact };
  Object.assign(t, { v: value, since: t.psince, exact: true });
  delete t.pv;
  delete t.psince;
  return change;
}

const forText = (ch) => (ch.prevFor > 0 ? `${ch.atLeast ? 'for at least ' : 'for '}${dur(ch.prevFor)}` : '');

// ---------- each kind of rule ----------

// step(rule, state, ctx) → { messages: [{ text, vars }], note }. `state` is changed in place.
const STEPS = {
  source(rule, state, ctx) {
    const st = stationOf(rule, ctx);
    if (!st) return { note: 'No inverter data yet' };
    const name = rule.source === 'grid' ? st.names.grid : st.names.generator;
    if (st.stale) return { note: `Waiting: the inverter's data is stale` };
    const on = rule.source === 'grid' ? st.gridOn : st.genOn;
    if (on === null) return { note: `Can't tell whether ${name} is on (no voltage or power reading)` };
    const t = (state.t = state.t || {});
    const ch = track(t, on, ctx.now, rule.holdMinutes * 60);
    const note = t.pv !== undefined ? `${name} looks ${t.pv ? 'on' : 'off'}; waiting ${rule.holdMinutes} min to be sure` : `${name} is ${t.v ? 'on' : 'off'} since ${timeIn(t.since, ctx.tz)}${t.exact ? '' : ' or earlier'}`;
    if (!ch || (ch.value ? !rule.on : !rule.off)) return { note };
    const was = forText(ch);
    const text = ch.value
      ? lines(`⚡ ${name} is ON${where(rule, ctx)}${was ? ` — it was off ${was}` : ''}`, stateLine(rule, ctx))
      : lines(`🔌 ${name} is OFF${where(rule, ctx)}${was ? ` — it was on ${was}` : ''}`, stateLine(rule, ctx, { sources: rule.source === 'grid' }));
    return { note, messages: [{ text, end: !ch.value, vars: { duration: dur(ch.prevFor) || '' } }] };
  },

  soc(rule, state, ctx) {
    const st = stationOf(rule, ctx);
    if (!st) return { note: 'No inverter data yet' };
    if (st.stale) return { note: `Waiting: the inverter's data is stale` };
    const soc = st.values.soc;
    if (soc === null) return { note: 'No battery level reading' };
    const lv = (state.levels = state.levels || {});
    let up = null;
    let down = null;
    for (const level of rule.levels) {
      const l = lv[level];
      if (!l) {
        lv[level] = { up: soc < level, down: soc > level };
        continue;
      }
      if (l.up && soc >= level) {
        l.up = false;
        up = level; // levels go up, so this ends at the highest one crossed
      } else if (!l.up && soc <= level - HYSTERESIS) l.up = true;
      if (level < 100) {
        if (l.down && soc <= level) {
          l.down = false;
          if (down === null) down = level; // the lowest one crossed
        } else if (!l.down && soc >= level + HYSTERESIS) l.down = true;
      }
    }
    for (const k of Object.keys(lv)) if (!rule.levels.includes(Number(k))) delete lv[k];
    const note = `Battery ${pct(soc)}`;
    const messages = [];
    if (up !== null && rule.up) messages.push({ text: lines(`🔋 Battery reached ${up}%${where(rule, ctx)}${Math.round(soc) !== up ? ` (now ${pct(soc)})` : ''}`, stateLine(rule, ctx, { sources: true, battery: false })), vars: { level: `${up}%` } });
    if (down !== null && rule.down) messages.push({ text: lines(`🪫 Battery dropped to ${down}%${where(rule, ctx)}${Math.round(soc) !== down ? ` (now ${pct(soc)})` : ''}`, stateLine(rule, ctx, { sources: true, battery: false })), end: true, vars: { level: `${down}%` } });
    return { note, messages };
  },

  condition(rule, state, ctx) {
    const ev = automations.evaluateRule({ stationId: rule.stationId, match: rule.match, conditions: rule.conditions }, ctx.snap);
    if (ev.ok === null) return { note: `Waiting: ${ev.results.filter((r) => r.ok === null).map((r) => r.text).join('; ')}` };
    const t = (state.t = state.t || {});
    const ch = track(t, ev.ok, ctx.now, ev.ok ? rule.holdMinutes * 60 : 0);
    const note = t.pv ? `Conditions hold; notifying in ${Math.max(1, Math.ceil((rule.holdMinutes * 60 - (ctx.now - t.psince)) / 60))} min` : `${t.v ? 'Conditions hold' : 'Conditions not met'} since ${timeIn(t.since, ctx.tz)}${t.exact ? '' : ' or earlier'}`;
    if (!ch) return { note };
    const detail = ev.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.text}`).join('\n');
    if (ch.value) return { note, messages: [{ text: lines(`🔔 ${rule.name}`, detail), vars: { duration: dur(ch.prevFor) || '' } }] };
    if (!rule.whenStops) return { note };
    return { note, messages: [{ text: lines(`🔕 ${rule.name}: no longer${ch.prevFor > 0 ? ` (held ${ch.atLeast ? 'at least ' : ''}${dur(ch.prevFor)})` : ''}`, detail), end: true, vars: { duration: dur(ch.prevFor) || '' } }] };
  },

  stale(rule, state, ctx) {
    const st = stationOf(rule, ctx);
    if (!st || !st.lastTs) return { note: 'No inverter data yet' };
    const gap = ctx.now - st.lastTs;
    const isStale = gap > rule.minutes * 60;
    const t = (state.t = state.t || {});
    const before = t.v;
    const ch = track(t, isStale, ctx.now, 0);
    if (isStale && (ch || before === undefined)) state.lastBefore = st.lastTs;
    const note = isStale ? `No new data since ${timeIn(st.lastTs, ctx.tz)}` : `Last reading ${timeIn(st.lastTs, ctx.tz)}`;
    if (!ch) return { note };
    if (ch.value) {
      return { note, messages: [{ text: `⚠️ No new data from the inverter${where(rule, ctx)} for ${dur(gap)} (last reading at ${timeIn(st.lastTs, ctx.tz)}). DeyeCloud, the internet or the logger may be down.`, vars: { duration: dur(gap) } }] };
    }
    if (!rule.whenBack) return { note };
    const missing = state.lastBefore ? st.lastTs - state.lastBefore : null;
    return { note, messages: [{ text: lines(`✅ Inverter data is back${where(rule, ctx)}${missing ? ` after ${dur(missing)} without readings` : ''}`, stateLine(rule, ctx, { sources: true })), end: true, vars: { duration: dur(missing) || '' } }] };
  },

  async collector(rule, state, ctx) {
    const runs = await db.query(
      "SELECT status, message, UNIX_TIMESTAMP(finished_at) AS ts FROM collector_runs WHERE kind = 'poll' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT ?",
      [rule.errors]
    );
    if (!runs.length) return { note: 'No collection has run yet' };
    const failing = runs.length >= rule.errors && runs.every((r) => r.status === 'error');
    const value = failing ? true : runs[0].status !== 'error' ? false : null;
    const t = (state.t = state.t || {});
    const ch = track(t, value, ctx.now, 0);
    const note = runs[0].status === 'error' ? `Last poll failed: ${runs[0].message || ''}`.slice(0, 300) : `Last poll ${runs[0].status} at ${timeIn(Number(runs[0].ts), ctx.tz)}`;
    if (!ch) return { note };
    if (ch.value) return { note, messages: [{ text: lines(`⚠️ Collecting data from DeyeCloud is failing (${rule.errors === 1 ? 'the last poll' : `the last ${rule.errors} polls`} failed)`, runs[0].message ? `Error: ${String(runs[0].message).slice(0, 300)}` : '') }] };
    if (!rule.whenBack) return { note };
    return { note, messages: [{ text: `✅ Collecting data from DeyeCloud works again${ch.prevFor > 0 ? ` (it failed for ${dur(ch.prevFor)})` : ''}`, end: true, vars: { duration: dur(ch.prevFor) || '' } }] };
  },

  device(rule, state, ctx) {
    if (!ctx.ewelinkConnected) return { note: 'eWeLink is not connected' };
    const all = [...ctx.snap.devices.values()];
    const list = rule.deviceId ? all.filter((d) => d.deviceid === rule.deviceId) : all.filter((d) => !d.hidden);
    if (!list.length) return { note: rule.deviceId ? `Smart device ${rule.deviceId} not found` : 'No smart devices' };
    const mem = (state.d = state.d || {});
    const went = [];
    const back = [];
    for (const d of list) {
      const t = (mem[d.deviceid] = mem[d.deviceid] || {});
      const ch = track(t, d.online === null ? null : !d.online, ctx.now, rule.holdMinutes * 60);
      if (!ch) continue;
      if (ch.value && rule.offline) went.push(d.name || d.deviceid);
      if (!ch.value && rule.online) back.push({ name: d.name || d.deviceid, was: ch.prevFor > 0 ? ` (offline ${ch.atLeast ? 'at least ' : ''}${dur(ch.prevFor)})` : '' });
    }
    const ids = new Set(list.map((d) => d.deviceid));
    for (const k of Object.keys(mem)) if (!ids.has(k)) delete mem[k];
    const off = list.filter((d) => d.online === false).length;
    const note = `${list.length - off} online, ${off} offline`;
    const messages = [];
    if (went.length) messages.push({ text: went.length === 1 ? `📴 ${went[0]} went offline` : `📴 These smart devices went offline:\n• ${went.join('\n• ')}` });
    if (back.length) messages.push({ end: true, text: back.length === 1 ? `📶 ${back[0].name} is back online${back[0].was}` : `📶 These smart devices are back online:\n• ${back.map((b) => `${b.name}${b.was}`).join('\n• ')}` });
    return { note, messages };
  },

  async automation(rule, state) {
    const max = await db.one('SELECT COALESCE(MAX(id), 0) AS id FROM automation_runs');
    if (state.lastId === undefined || state.lastId > Number(max.id)) {
      state.lastId = Number(max.id);
      return { note: 'Watching automations' };
    }
    const rows = await db.query(
      'SELECT r.*, a.name FROM automation_runs r LEFT JOIN automations a ON a.id = r.automation_id WHERE r.id > ? ORDER BY r.id LIMIT 100',
      [state.lastId]
    );
    if (rows.length) state.lastId = rows[rows.length - 1].id;
    const picked = rows.filter((r) => (!rule.automationId || r.automation_id === rule.automationId) && (rule.only === 'all' || r.status === 'failed' || r.status === 'partial'));
    const BR = { then: 'ran its actions', else: 'ran its “otherwise” actions', enforce: 'put devices back', test: 'was run by hand' };
    const messages = picked.map((r) => {
      const name = r.name || `#${r.automation_id}`;
      const head = r.status === 'failed' ? `❌ Automation “${name}” failed` : r.status === 'partial' ? `⚠️ Automation “${name}” partly failed` : `🤖 Automation “${name}” ${BR[r.branch] || 'ran'}`;
      return { text: lines(head, String(r.message || '').slice(0, 600)) };
    });
    // Many at once (e.g. after a restart) go as one message.
    if (messages.length > 3) return { note: 'Watching automations', messages: [{ text: messages.map((m) => m.text).join('\n\n') }] };
    return { note: 'Watching automations', messages };
  },

  async inverter(rule, state, ctx) {
    if (state.lastTs === undefined) {
      state.lastTs = ctx.now;
      return { note: 'Watching inverter settings' };
    }
    const rows = await db.query(
      "SELECT * FROM inverter_commands WHERE done_ts > ? AND status IN ('succeeded', 'failed') ORDER BY done_ts, id LIMIT 50",
      [state.lastTs]
    );
    if (rows.length) state.lastTs = Number(rows[rows.length - 1].done_ts);
    const { FIELDS } = require('./inverter');
    const messages = rows
      .filter((r) => rule.only === 'all' || r.status === 'failed')
      .map((r) => {
        const label = (FIELDS[r.field] && FIELDS[r.field].label) || r.field;
        let value = r.new_value;
        try {
          const v = JSON.parse(r.new_value);
          value = typeof v === 'object' ? 'new values' : String(v);
        } catch {
          /* plain text */
        }
        return {
          text: r.status === 'succeeded'
            ? `⚙️ Inverter setting changed: ${label} → ${value}${r.username ? ` (by ${r.username})` : ''}`
            : lines(`❌ Changing the inverter's ${label} to ${value} failed${r.username ? ` (asked by ${r.username})` : ''}`, r.message ? String(r.message).slice(0, 300) : ''),
        };
      });
    return { note: 'Watching inverter settings', messages };
  },

  async summary(rule, state, ctx) {
    const at = automations.minutesOf(rule.at);
    const today = dayIn(ctx.now, ctx.tz);
    const due = ctx.clock.minutes >= at && (ctx.clock.minutes - at) * 60 < SUMMARY_LATE && rule.days.includes(ctx.clock.day);
    if (state.lastDay === undefined) state.lastDay = ctx.clock.minutes >= at ? today : null;
    const note = state.lastDay === today ? `Sent today; next at ${rule.at}` : `Next at ${rule.at}`;
    if (!due || state.lastDay === today) return { note };
    state.lastDay = today;
    return { note: `Sent today; next at ${rule.at}`, messages: [{ text: await summaryText(rule, ctx) }] };
  },
};

/** The daily summary: today's energy, how long the grid and generator were on, the battery, tomorrow's grid. */
async function summaryText(rule, ctx) {
  const st = stationOf(rule, ctx);
  if (!st) return `📊 ${rule.name}\nNo inverter data yet.`;
  const out = [`📊 ${rule.name} — ${dateIn(ctx.now, ctx.tz)}${where(rule, ctx)}`];
  const { stations } = await ctx.live();
  const s = stations.find((x) => x.id === st.id);
  if (rule.energy && s) {
    const e = s.energy || {};
    const f = await flow();
    const gen = f.generatorEnergyToday(s);
    if (s.energyDay === dayIn(ctx.now, ctx.tz)) {
      const solar = e.generationValue === undefined || e.generationValue === null ? null : Math.max(0, e.generationValue - (gen || 0));
      out.push(`☀️ Solar ${kwh(solar)} · 🏠 Home ${kwh(e.consumptionValue)}`);
      const grid = [`${st.names.grid} ${kwh(e.purchaseValue)}`];
      if (Number(e.gridValue) > 0) grid.push(`export ${kwh(e.gridValue)}`);
      if (gen !== null) grid.push(`${st.names.generator} ${kwh(gen)}`);
      out.push(`🔌 ${grid.join(' · ')}`);
      if (e.chargeValue !== undefined || e.dischargeValue !== undefined) out.push(`🔋 Charged ${kwh(e.chargeValue)} · discharged ${kwh(e.dischargeValue)}`);
    } else out.push(`Today's energy totals haven't arrived from DeyeCloud yet.`);
  }
  if (rule.sources || rule.battery) {
    const events = require('./events');
    const midnight = ctx.now - ctx.clock.minutes * 60 - (ctx.now % 60);
    const data = await events.build({ stationId: st.id, from: midnight, to: ctx.now }).catch(() => null);
    if (data && rule.sources) {
      for (const src of data.sources) {
        if (!src.knownSeconds) continue;
        const onSec = src.share * src.knownSeconds;
        const cuts = data.events.filter((x) => x.kind === src.kind && x.on === false).length;
        const starts = data.events.filter((x) => x.kind === src.kind && x.on === true).length;
        out.push(`${src.kind === 'grid' ? '⚡' : '⛽'} ${src.name} on ${onSec < 60 ? '0 min' : dur(onSec)} today${src.kind === 'grid' ? (cuts ? ` · ${cuts} cut${cuts > 1 ? 's' : ''}` : '') : starts ? ` · started ${starts}×` : ''}${src.now ? ` · ${src.now.on ? 'on' : 'off'} now` : ''}`);
      }
    }
    if (rule.battery) {
      const lv = data && data.levelStats ? data.levelStats : [];
      const soc = st.stale ? null : st.values.soc;
      const parts = [`🔋 Battery ${soc === null ? 'unknown' : pct(soc)} now`];
      const full = lv.find((l) => l.level === 100);
      if (full && full.up.days) parts.push(`full at ${hm(full.up.medianMinute)}`);
      out.push(parts.join(' · '));
    }
  }
  if (rule.forecast) {
    const events = require('./events');
    const fc = await events.forecasts(st.id).catch(() => null);
    const sc = fc && fc.source && fc.source.schedule;
    if (sc) {
      const d = sc.tomorrow;
      const text = d.likely.length ? `likely on ${spans(d.likely)}${d.possible.length ? `; possibly ${spans(d.possible)}` : ''}` : d.possible.length ? `possibly on ${spans(d.possible)}` : 'unlikely to be on';
      out.push(`🔮 Tomorrow ${fc.source.name} ${text}`);
    } else if (fc && fc.source) out.push(`🔮 Not enough history yet to predict ${fc.source.name} for tomorrow`);
  }
  return out.join('\n');
}

// ---------- sending ----------

function resolveRecipients(rule, all) {
  const on = all.filter((r) => r.enabled);
  const list = rule.recipients && rule.recipients.length ? on.filter((r) => rule.recipients.includes(r.id)) : on;
  return list.map((r) => ({ name: r.name, chatId: r.chatId }));
}

function compose(text, ctx) {
  const t = ctx.opts.title ? `*${ctx.opts.title}*\n${text}` : text;
  return t.slice(0, MAX_TEXT);
}

/**
 * Message text for a rule: its custom message with placeholders filled, or the standard one.
 * Rules that report two ways (on / off, reached / dropped, starts / stops) have a custom message
 * for each; `msg.end` marks the second way.
 */
function finalText(row, rule, msg, ctx) {
  const v = vars({ ...rule, name: row.name }, ctx, { duration: '', level: '', ...(msg.vars || {}), event: msg.text });
  const template = msg.end ? rule.messageEnd : rule.message;
  return compose(template && template.trim() ? render(template, v) : msg.text, ctx);
}

function quietNow(ctx) {
  return inWindow(ctx.clock.minutes, automations.minutesOf(ctx.opts.quietFrom), automations.minutesOf(ctx.opts.quietTo));
}

async function logMessage({ ruleId = null, ruleName = null, kind = 'event', ts, to, text, status, message = null, sentTs = null, attempts = 0 }) {
  const r = await db.query(
    'INSERT INTO notification_log (rule_id, rule_name, kind, ts, recipients, text, status, message, attempts, sent_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ruleId, ruleName, kind, ts, JSON.stringify(to), text, status, message ? String(message).slice(0, 1000) : null, attempts, sentTs]
  );
  return r.insertId;
}

/** Sends a text to each recipient. Returns { status, message, retry }. */
async function sendTo(cfg, to, text) {
  const failed = [];
  let retry = false;
  for (const r of to) {
    try {
      await waha.sendText(cfg, r.chatId, text);
    } catch (err) {
      failed.push(`${r.name}: ${err.message}`);
      // No answer, or the server's own trouble: worth trying again. A refusal is not.
      if (!err.status || err.status >= 500 || err.status === 429) retry = true;
    }
  }
  if (!failed.length) return { status: 'sent', message: null, retry: false };
  return { status: failed.length === to.length ? 'failed' : 'partial', message: failed.join(' · '), retry: retry && failed.length === to.length };
}

/** Sends what is waiting: new and retried messages, and held ones once the quiet hours are over. */
async function flush(cfg, ctx) {
  const now = ctx.now;
  await db.query("UPDATE notification_log SET status = 'failed', message = CONCAT('Not sent: ', COALESCE(message, 'WAHA could not be reached')) WHERE status = 'pending' AND ts < ?", [now - RETRY_FOR]);
  await db.query("UPDATE notification_log SET status = 'skipped', message = 'Held for quiet hours too long' WHERE status = 'held' AND ts < ?", [now - HELD_FOR]);
  const pending = await db.query("SELECT * FROM notification_log WHERE status = 'pending' ORDER BY id LIMIT 30");
  for (const row of pending) {
    const r = await sendTo(cfg, parseJson(row.recipients, []), row.text);
    const attempts = row.attempts + 1;
    if (r.retry && attempts < MAX_ATTEMPTS) await db.query('UPDATE notification_log SET attempts = ?, message = ? WHERE id = ?', [attempts, `Will retry: ${r.message}`.slice(0, 1000), row.id]);
    else await db.query('UPDATE notification_log SET status = ?, attempts = ?, message = ?, sent_ts = ? WHERE id = ?', [r.status, attempts, r.message, r.status === 'failed' ? null : now, row.id]);
    if (r.retry) break; // WAHA is down: the rest waits for the next run
  }
  if (quietNow(ctx)) return;
  const held = await db.query("SELECT * FROM notification_log WHERE status = 'held' ORDER BY id LIMIT 200");
  if (!held.length) return;
  // One message per group of recipients, oldest first, each line with its time.
  const groups = new Map();
  for (const row of held) {
    const k = row.recipients;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  for (const [k, rows] of groups) {
    const strip = (t) => (ctx.opts.title && t.startsWith(`*${ctx.opts.title}*\n`) ? t.slice(ctx.opts.title.length + 3) : t);
    const body = rows.map((row) => `[${timeIn(row.ts, ctx.tz)}] ${strip(row.text)}`).join('\n\n');
    const text = compose(`🌙 During quiet hours:\n\n${body}`, ctx);
    const r = await sendTo(cfg, parseJson(k, []), text);
    if (r.retry) return;
    await db.query('UPDATE notification_log SET status = ?, message = ?, sent_ts = ? WHERE id IN (?)', [r.status, r.message ? `Sent together after quiet hours. ${r.message}` : 'Sent together after quiet hours', r.status === 'failed' ? null : now, rows.map((x) => x.id)]);
  }
}

/** Queues a rule's message: pending (sent right after), held for quiet hours, or skipped. */
async function queue(row, rule, msg, ctx, all, lastSent) {
  const text = finalText(row, rule, msg, ctx);
  const to = resolveRecipients(rule, all);
  const base = { ruleId: row.id, ruleName: row.name, ts: ctx.now, to, text };
  if (!to.length) return logMessage({ ...base, status: 'skipped', message: 'No recipients (add them on this page, or turn one on)' });
  if (rule.cooldownMinutes && lastSent && ctx.now - lastSent < rule.cooldownMinutes * 60) {
    return logMessage({ ...base, status: 'skipped', message: `Within the ${rule.cooldownMinutes} min cooldown` });
  }
  if (quietNow(ctx) && rule.quiet !== 'send') {
    return logMessage({ ...base, status: rule.quiet === 'hold' ? 'held' : 'skipped', message: rule.quiet === 'hold' ? 'Quiet hours: sent when they end' : 'Quiet hours' });
  }
  row.sent_ts = ctx.now;
  return logMessage({ ...base, status: 'pending' });
}

// ---------- the engine ----------

async function step(row, ctx, deliver, all) {
  const rule = parseJson(row.rule, null);
  if (!rule || !STEPS[rule.type]) return;
  const state = parseJson(row.state, {}) || {};
  const r = (await STEPS[rule.type]({ ...rule, name: row.name }, state, ctx)) || {};
  const messages = r.messages || [];
  let note = r.note || '';
  if (messages.length) {
    const lastSent = row.sent_ts;
    if (deliver) for (const m of messages) await queue(row, rule, m, ctx, all, lastSent);
    else note = `Notifications are off or WhatsApp isn't set up; would have sent: ${messages[0].text.split('\n')[0]}`;
  }
  await db.query('UPDATE notification_rules SET state = ?, checked_ts = ?, sent_ts = ?, last_note = ? WHERE id = ?', [
    JSON.stringify(state),
    ctx.now,
    row.sent_ts,
    note.slice(0, 500),
    row.id,
  ]);
}

/** Called every minute by the scheduler and by the cron URL. */
async function tick() {
  const res = await db.withLock(LOCK, async () => {
    const rows = await db.query('SELECT * FROM notification_rules WHERE enabled = 1 ORDER BY sort_index, id');
    const cfg = await settings.getWahaConfig();
    const waiting = await db.one("SELECT COUNT(*) AS n FROM notification_log WHERE status IN ('pending', 'held')");
    if (!rows.length && !Number(waiting.n)) return { status: 'idle' };
    const ctx = await context();
    const deliver = ctx.opts.enabled && Boolean(cfg.url);
    const all = await recipients();
    for (const row of rows) {
      try {
        await step(row, ctx, deliver, all);
      } catch (err) {
        console.error(`[notifications] ${row.name}:`, err.message);
        await db.query('UPDATE notification_rules SET checked_ts = ?, last_note = ? WHERE id = ?', [ctx.now, `Error: ${err.message}`.slice(0, 500), row.id]).catch(() => {});
      }
    }
    if (deliver) await flush(cfg, ctx);
    // Daily: keep the log from growing forever.
    const last = Number(await settings.get('notify_cleanup_ts')) || 0;
    if (ctx.now - last > 86400) {
      await db.query('DELETE FROM notification_log WHERE ts < ?', [ctx.now - 180 * 86400]);
      await settings.set({ notify_cleanup_ts: ctx.now });
    }
    return { status: 'ok', rules: rows.length };
  });
  return res.locked ? res.result : { status: 'busy' };
}

// ---------- for the page ----------

/** What a rule's message would say right now (with made-up durations), without sending it. */
async function preview(input) {
  const { name, rule } = cleanRule(input);
  const ctx = await context();
  const st = stationOf(rule, ctx);
  const gridName = st ? st.names.grid : 'Grid';
  const genName = st ? st.names.generator : 'Generator';
  const r = { ...rule, name };
  let samples = [];
  switch (rule.type) {
    case 'source': {
      const n = rule.source === 'grid' ? gridName : genName;
      if (rule.on) samples.push({ text: lines(`⚡ ${n} is ON${where(r, ctx)} — it was off for 2 h 15 min`, stateLine(r, ctx)), vars: { duration: '2 h 15 min' } });
      if (rule.off) samples.push({ text: lines(`🔌 ${n} is OFF${where(r, ctx)} — it was on for 3 h 40 min`, stateLine(r, ctx, { sources: rule.source === 'grid' })), end: true, vars: { duration: '3 h 40 min' } });
      break;
    }
    case 'soc': {
      const rest = stateLine(r, ctx, { sources: true, battery: false });
      if (rule.up) samples.push({ text: lines(`🔋 Battery reached ${rule.levels[rule.levels.length - 1]}%${where(r, ctx)}`, rest), vars: { level: `${rule.levels[rule.levels.length - 1]}%` } });
      if (rule.down) {
        const lv = rule.levels.find((l) => l < 100) || rule.levels[0];
        samples.push({ text: lines(`🪫 Battery dropped to ${lv}%${where(r, ctx)}`, rest), end: true, vars: { level: `${lv}%` } });
      }
      break;
    }
    case 'condition': {
      const ev = automations.evaluateRule({ stationId: rule.stationId, match: rule.match, conditions: rule.conditions }, ctx.snap);
      const detail = ev.results.map((x) => `${x.ok === true ? '✓' : x.ok === false ? '✗' : '?'} ${x.text}`).join('\n');
      samples.push({ text: lines(`🔔 ${name}`, detail) });
      if (rule.whenStops) samples.push({ text: lines(`🔕 ${name}: no longer (held 45 min)`, detail), end: true, vars: { duration: '45 min' } });
      break;
    }
    case 'stale':
      samples.push({ text: `⚠️ No new data from the inverter${where(r, ctx)} for ${dur(rule.minutes * 60)} (last reading at ${timeIn(ctx.now - rule.minutes * 60, ctx.tz)}). DeyeCloud, the internet or the logger may be down.` });
      if (rule.whenBack) samples.push({ text: lines(`✅ Inverter data is back${where(r, ctx)} after 1 h 10 min without readings`, stateLine(r, ctx, { sources: true })), end: true, vars: { duration: '1 h 10 min' } });
      break;
    case 'collector':
      samples.push({ text: lines(`⚠️ Collecting data from DeyeCloud is failing (${rule.errors === 1 ? 'the last poll' : `the last ${rule.errors} polls`} failed)`, 'Error: (the error DeyeCloud gave)') });
      if (rule.whenBack) samples.push({ text: '✅ Collecting data from DeyeCloud works again (it failed for 25 min)', end: true, vars: { duration: '25 min' } });
      break;
    case 'device': {
      const d = rule.deviceId ? ctx.snap.devices.get(rule.deviceId) : [...ctx.snap.devices.values()][0];
      const dn = d ? d.name || d.deviceid : 'Water heater';
      if (rule.offline) samples.push({ text: `📴 ${dn} went offline` });
      if (rule.online) samples.push({ text: `📶 ${dn} is back online (offline 20 min)`, end: true });
      break;
    }
    case 'automation': {
      const a = rule.automationId ? await db.one('SELECT name FROM automations WHERE id = ?', [rule.automationId]) : await db.one('SELECT name FROM automations ORDER BY sort_index, id LIMIT 1');
      const an = a ? a.name : 'Heater on with the grid';
      if (rule.only === 'all') samples.push({ text: lines(`🤖 Automation “${an}” ran its actions`, 'Water heater: on') });
      samples.push({ text: lines(`❌ Automation “${an}” failed`, 'Water heater: on — failed: device is offline') });
      break;
    }
    case 'inverter':
      if (rule.only === 'all') samples.push({ text: '⚙️ Inverter setting changed: Work mode → Zero export to load (by admin)' });
      samples.push({ text: lines(`❌ Changing the inverter's Max charge current to 80 failed (asked by admin)`, 'No result within 15 minutes') });
      break;
    case 'summary':
      samples.push({ text: await summaryText(r, ctx) });
      break;
    default:
      break;
  }
  const row = { id: null, name };
  return { texts: samples.map((m) => finalText(row, rule, m, ctx)), quietNow: quietNow(ctx) };
}

/** Sends a test message to the given recipients (all turned-on ones when none are given). */
async function sendTest({ text, recipientIds, ruleId = null, ruleName = null } = {}) {
  const cfg = await settings.getWahaConfig();
  if (!cfg.url) throw badRequest('Enter the WAHA server address first');
  const all = await recipients();
  const to = (recipientIds && recipientIds.length ? all.filter((r) => recipientIds.includes(r.id)) : all.filter((r) => r.enabled)).map((r) => ({ name: r.name, chatId: r.chatId }));
  if (!to.length) throw badRequest('Add a recipient first');
  const r = await sendTo(cfg, to, String(text).slice(0, MAX_TEXT));
  const now = nowSec();
  await logMessage({ ruleId, ruleName, kind: 'test', ts: now, to, text: String(text).slice(0, MAX_TEXT), status: r.status, message: r.message, sentTs: r.status === 'failed' ? null : now, attempts: 1 });
  return { ...r, recipients: to.length };
}

/** Sends a saved rule's message as it would read now, marked as a test. */
async function testRule(id) {
  const row = await db.one('SELECT * FROM notification_rules WHERE id = ?', [id]);
  if (!row) {
    const err = new Error('Notification not found');
    err.status = 404;
    throw err;
  }
  const rule = parseJson(row.rule, {});
  const p = await preview({ ...rule, name: row.name });
  const ctx = { opts: await options() };
  const strip = (t) => (ctx.opts.title && t.startsWith(`*${ctx.opts.title}*\n`) ? t.slice(ctx.opts.title.length + 3) : t);
  const text = compose(`🧪 Test of “${row.name}”:\n\n${p.texts.map(strip).join('\n\n')}`, ctx);
  const all = await recipients();
  const ids = rule.recipients && rule.recipients.length ? rule.recipients : all.filter((r) => r.enabled).map((r) => r.id);
  return sendTest({ text, recipientIds: ids, ruleId: row.id, ruleName: row.name });
}

module.exports = {
  tick,
  cleanRule,
  toApi,
  preview,
  sendTest,
  testRule,
  recipients,
  saveRecipients,
  options,
  saveOptions,
  PLACEHOLDERS,
  TYPES,
  // exposed for checks
  _track: track,
  _render: render,
  _inWindow: inWindow,
};
