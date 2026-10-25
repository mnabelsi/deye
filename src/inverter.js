'use strict';

// Inverter settings: read for the overview and the Inverter page, and changed from the Inverter
// page by an admin. Settings come from two places: DeyeCloud's stored copy (/config/battery,
// /config/system, /config/tou), which can lag, and a live read that asks the inverter itself
// (/strategy/dynamicControl/read). Each change is a DeyeCloud command; they are sent one at a time
// per inverter (overlapping commands are rejected) and followed until the inverter confirms them.

const db = require('./db');
const settings = require('./settings');

const META = new Set(['code', 'msg', 'success', 'requestId']);
const CMD_LOCK = 'deye_monitor_inverter_commands';
const GIVE_UP = 15 * 60; // seconds a live read or a command may take before it is given up
const CONFIRMED_TTL = 24 * 3600; // how long a confirmed change outranks DeyeCloud's stored copy
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const DEVICE_TYPES = new Set(['INVERTER', 'MICRO_INVERTER', 'MICRO_STORAGE_IN_ONE', 'PCS']);

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (res) => Object.fromEntries(Object.entries(res || {}).filter(([k]) => !META.has(k)));
const given = (v) => v !== undefined && v !== null && v !== '';
const pick = (...vals) => vals.find(given) ?? null;
const onOff = (v) => (given(v) ? ['on', 'true', '1', 'enable', 'enabled'].includes(String(v).toLowerCase()) : null);
const onOffText = (b) => (b ? 'on' : 'off');

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Error codes of GET /order/{id}.
const ORDER_ERRORS = {
  501: 'conflicting command',
  502: 'not supported by this inverter',
  505: 'DeyeCloud system error',
  510: 'parsing failure',
  511: 'invalid firmware version',
  530: 'the inverter rejected the command',
  573: 'could not reach the inverter',
};

function orderError(o) {
  const code = parseInt(o && o.error, 10);
  return `${Number(o && o.status) === 400 ? 'Terminated' : 'Failed'}${o && o.error ? `: ${ORDER_ERRORS[code] || o.error}` : ''}`;
}

// ---------- what can be changed ----------

const int = (min, max, unit) => ({ type: 'int', min, max, unit });

/**
 * Every setting the Inverter page can change: how it is validated, where its current value is in
 * the merged settings (`get`/`set`), the key of the live read that reports it (`live`, if any)
 * and the command that changes it. Ranges stay inside what Deye inverters accept; the inverter
 * also clamps values to its own model's limits.
 */
const FIELDS = {
  energyPattern: {
    label: 'Energy pattern',
    type: 'enum',
    values: ['BATTERY_FIRST', 'LOAD_FIRST'],
    get: (c) => c.system.energyPattern,
    set: (c, v) => (c.system.energyPattern = v),
    send: (cl, sn, v) => cl.setEnergyPattern(sn, v),
  },
  workMode: {
    label: 'Work mode',
    type: 'enum',
    values: ['SELLING_FIRST', 'ZERO_EXPORT_TO_LOAD', 'ZERO_EXPORT_TO_CT'],
    live: 'workMode',
    get: (c) => c.system.systemWorkMode,
    set: (c, v) => (c.system.systemWorkMode = v),
    send: (cl, sn, v) => cl.setWorkMode(sn, v),
  },
  solarSell: {
    label: 'Solar sell',
    type: 'bool',
    live: 'solarSellAction',
    get: (c) => onOff(c.system.solarSellAction),
    set: (c, v) => (c.system.solarSellAction = onOffText(v)),
    send: (cl, sn, v) => cl.setSolarSell(sn, v),
  },
  maxSellPower: {
    label: 'Max sell power',
    ...int(0, 100000, 'W'),
    live: 'maxSellPower',
    get: (c) => c.system.maxSellPower,
    set: (c, v) => (c.system.maxSellPower = v),
    send: (cl, sn, v) => cl.setSystemPower(sn, 'MAX_SELL_POWER', v),
  },
  maxSolarPower: {
    label: 'Max solar power',
    ...int(0, 100000, 'W'),
    live: 'maxSolarPower',
    get: (c) => c.system.maxSolarPower,
    set: (c, v) => (c.system.maxSolarPower = v),
    send: (cl, sn, v) => cl.setSystemPower(sn, 'MAX_SOLAR_POWER', v),
  },
  zeroExportPower: {
    label: 'Zero export power',
    ...int(0, 1000, 'W'),
    live: 'zeroExportPower',
    get: (c) => c.system.zeroExportPower,
    set: (c, v) => (c.system.zeroExportPower = v),
    send: (cl, sn, v) => cl.setSystemPower(sn, 'ZERO_EXPORT_POWER', v),
  },
  battLow: {
    label: 'Batt Low',
    ...int(5, 95, '%'),
    get: (c) => c.battery.battLowCapacity,
    set: (c, v) => (c.battery.battLowCapacity = v),
    send: (cl, sn, v) => cl.setBatteryParameter(sn, 'BATT_LOW', v),
  },
  maxChargeCurrent: {
    label: 'Max charge current',
    ...int(0, 350, 'A'),
    live: 'maxChargeCurrent',
    get: (c) => c.battery.maxChargeCurrent,
    set: (c, v) => (c.battery.maxChargeCurrent = v),
    send: (cl, sn, v) => cl.setBatteryParameter(sn, 'MAX_CHARGE_CURRENT', v),
  },
  maxDischargeCurrent: {
    label: 'Max discharge current',
    ...int(0, 350, 'A'),
    live: 'maxDischargeCurrent',
    get: (c) => c.battery.maxDischargeCurrent,
    set: (c, v) => (c.battery.maxDischargeCurrent = v),
    send: (cl, sn, v) => cl.setBatteryParameter(sn, 'MAX_DISCHARGE_CURRENT', v),
  },
  gridChargeAmpere: {
    label: 'Grid charge current',
    ...int(0, 350, 'A'),
    live: 'gridChargeAmpere',
    get: (c) => c.battery.gridChargeAmpere,
    set: (c, v) => (c.battery.gridChargeAmpere = v),
    send: (cl, sn, v) => cl.setBatteryParameter(sn, 'GRID_CHARGE_AMPERE', v),
  },
  gridCharge: {
    label: 'Charge from the grid',
    type: 'bool',
    live: 'gridChargeAction',
    get: (c) => onOff(c.battery.gridChargeAction),
    set: (c, v) => (c.battery.gridChargeAction = onOffText(v)),
    send: (cl, sn, v) => cl.setBatteryMode(sn, 'GRID_CHARGE', v),
  },
  // DeyeCloud has no read for this switch, so it is known only after the app has set it.
  genCharge: {
    label: 'Charge from the generator',
    type: 'bool',
    get: (c) => onOff(c.battery.genChargeAction),
    set: (c, v) => (c.battery.genChargeAction = onOffText(v)),
    send: (cl, sn, v) => cl.setBatteryMode(sn, 'GEN_CHARGE', v),
  },
  touSwitch: {
    label: 'Time of use',
    type: 'touSwitch',
    live: 'touAction',
    get: (c) => {
      const on = onOff(c.tou.touAction);
      if (on === null) return null;
      const days = (c.tou.touDays || []).map((d) => String(d).toUpperCase());
      return { on, days: on ? DAYS.filter((d) => days.includes(d)) : [] };
    },
    set: (c, v) => {
      c.tou.touAction = onOffText(v.on);
      c.tou.touDays = v.days;
    },
    send: (cl, sn, v) => cl.setTouSwitch(sn, v.on, v.days),
  },
  touSlots: {
    label: 'Time-of-use slots',
    type: 'touSlots',
    live: 'timeUseSettingItems',
    get: (c) => (c.tou.timeUseSettingItems && c.tou.timeUseSettingItems.length ? normalSlots(c.tou.timeUseSettingItems) : null),
    set: (c, v) => (c.tou.timeUseSettingItems = v),
    send: (cl, sn, v) => cl.setTou(sn, v),
  },
};

/** Field descriptions for the Inverter page (labels, choices and ranges). */
function fieldInfo() {
  return Object.fromEntries(
    Object.entries(FIELDS).map(([k, f]) => [k, { label: f.label, type: f.type, values: f.values, min: f.min, max: f.max, unit: f.unit }])
  );
}

function normalSlots(slots) {
  return slots.map((s) => {
    const out = {
      time: String(s.time),
      power: Number(s.power),
      soc: Number(s.soc),
      enableGridCharge: Boolean(s.enableGridCharge),
      enableGeneration: Boolean(s.enableGeneration),
      enableSell: Boolean(s.enableSell),
    };
    // Batteries in voltage mode use a voltage per slot instead of SOC; keep it when present.
    if (given(s.voltage)) out.voltage = Number(s.voltage);
    return out;
  });
}

function validateSlots(slots) {
  if (!Array.isArray(slots) || slots.length !== 6) throw badRequest('Time of use needs exactly 6 slots');
  let prev = -1;
  return slots.map((s, i) => {
    const n = `Slot ${i + 1}`;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String((s && s.time) || ''));
    if (!m) throw badRequest(`${n}: start time as HH:MM`);
    const min = Number(m[1]) * 60 + Number(m[2]);
    if (min % 5) throw badRequest(`${n}: start times go in 5-minute steps`);
    if (min <= prev) throw badRequest(`${n}: each slot must start after the one before`);
    prev = min;
    const power = Number(s.power);
    const soc = Number(s.soc);
    if (!Number.isInteger(power) || power < 0 || power > 100000) throw badRequest(`${n}: power must be a whole number from 0 to 100000 W`);
    if (!Number.isInteger(soc) || soc < 5 || soc > 100) throw badRequest(`${n}: SOC must be a whole number from 5 to 100 %`);
    if (given(s.voltage) && (!Number.isInteger(Number(s.voltage)) || Number(s.voltage) < 0 || Number(s.voltage) > 1000)) throw badRequest(`${n}: invalid voltage`);
    return normalSlots([{ ...s, power, soc }])[0];
  });
}

/** Checks and normalises one requested change; throws a 400 error with a readable message. */
function validate(name, value) {
  const f = FIELDS[name];
  if (!f) throw badRequest(`Unknown setting: ${name}`);
  switch (f.type) {
    case 'enum':
      if (!f.values.includes(value)) throw badRequest(`${f.label}: choose one of ${f.values.join(', ')}`);
      return value;
    case 'bool':
      if (typeof value !== 'boolean') throw badRequest(`${f.label}: on or off`);
      return value;
    case 'int': {
      const n = Number(value);
      if (value === '' || value === null || !Number.isInteger(n) || n < f.min || n > f.max) {
        throw badRequest(`${f.label}: a whole number from ${f.min} to ${f.max} ${f.unit}`);
      }
      return n;
    }
    case 'touSwitch': {
      if (!value || typeof value.on !== 'boolean') throw badRequest('Time of use: on or off');
      if (!value.on) return { on: false, days: [] };
      const days = [...new Set((Array.isArray(value.days) ? value.days : []).map((d) => String(d).toUpperCase()))];
      if (!days.length || days.some((d) => !DAYS.includes(d))) throw badRequest('Time of use: pick at least one day');
      return { on: true, days: DAYS.filter((d) => days.includes(d)) };
    }
    case 'touSlots':
      return validateSlots(value);
    default:
      throw badRequest(`Unknown setting: ${name}`);
  }
}

// ---------- reading ----------

async function load(sn) {
  const value = (await settings.loadAll(true))[`device_config:${sn}`];
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function save(sn, cfg) {
  await settings.set({ [`device_config:${sn}`]: JSON.stringify(cfg) });
}

/** The settings from both sources; the inverter's live answer wins over DeyeCloud's stored copy. */
function merge(src) {
  const cb = src.configBattery || {};
  const cs = src.configSystem || {};
  const ct = src.configTou || {};
  const live = src.live || {};
  const liveSlots = Array.isArray(live.timeUseSettingItems) && live.timeUseSettingItems.length ? live.timeUseSettingItems : null;
  return {
    battery: {
      battCapacity: pick(cb.battCapacity),
      battLowCapacity: pick(cb.battLowCapacity),
      battShutDownCapacity: pick(cb.battShutDownCapacity),
      maxChargeCurrent: pick(live.maxChargeCurrent, cb.maxChargeCurrent),
      maxDischargeCurrent: pick(live.maxDischargeCurrent, cb.maxDischargeCurrent),
      gridChargeAction: pick(live.gridChargeAction),
      gridChargeAmpere: pick(live.gridChargeAmpere),
      genChargeAction: null,
    },
    system: {
      energyPattern: pick(cs.energyPattern),
      systemWorkMode: pick(live.workMode, cs.systemWorkMode),
      maxSellPower: pick(live.maxSellPower, cs.maxSellPower),
      maxSolarPower: pick(live.maxSolarPower, cs.maxSolarPower),
      zeroExportPower: pick(live.zeroExportPower, cs.zeroExportPower),
      solarSellAction: pick(live.solarSellAction),
    },
    tou: {
      touAction: pick(live.touAction, ct.touAction),
      touDays: Array.isArray(live.touDays) ? live.touDays : Array.isArray(ct.touDays) ? ct.touDays : null,
      timeUseSettingItems: liveSlots || (Array.isArray(ct.timeUseSettingItems) ? ct.timeUseSettingItems : []),
    },
  };
}

/**
 * Rebuilds the merged settings, then lays changes the inverter has confirmed on top: DeyeCloud's
 * stored copy can take a while to catch up. A confirmation stops counting once a newer live read
 * reports that setting, or after CONFIRMED_TTL.
 */
function rebuild(cfg) {
  const view = merge(cfg.sources || {});
  const liveAt = (cfg.sourceAt || {}).live || 0;
  for (const [name, c] of Object.entries(cfg.confirmed || {})) {
    const f = FIELDS[name];
    if (!f || nowSec() - c.ts > CONFIRMED_TTL || (f.live && liveAt > c.ts)) {
      delete cfg.confirmed[name];
      continue;
    }
    f.set(view, c.value);
  }
  return Object.assign(cfg, view);
}

const LIVE_KEYS = ['touAction', 'workMode', 'timeUseSettingItems', 'maxSellPower', 'maxChargeCurrent', 'gridChargeAction'];
const hasLiveData = (r) => LIVE_KEYS.some((k) => given(r[k]) && !(Array.isArray(r[k]) && !r[k].length));

/**
 * Follows a live read until the inverter has answered. Stops waiting after waitMs (a later
 * collector run carries on from cfg.livePending) and gives the read up after GIVE_UP.
 */
async function finishLiveRead(client, cfg, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const p = cfg.livePending;
    if (!p) return;
    let order = null;
    try {
      order = await client.orderStatus(p.orderId);
    } catch {
      order = null; // no order status: ask for the result directly
    }
    const status = order ? Number(order.status) : null;
    if (status === 400 || status === 500) {
      cfg.errors.live = orderError(order);
      delete cfg.livePending;
      return;
    }
    if (status === 666 || status === null) {
      try {
        const res = strip(await client.strategyReadResult(p.orderId));
        if (hasLiveData(res)) {
          cfg.sources.live = res;
          cfg.sourceAt.live = nowSec();
          delete cfg.errors.live;
          delete cfg.livePending;
          return;
        }
      } catch (err) {
        if (status === 666) {
          cfg.errors.live = err.message;
          delete cfg.livePending;
          return;
        }
      }
    }
    if (nowSec() - p.at > GIVE_UP) {
      cfg.errors.live = 'The inverter did not answer the read within 15 minutes';
      delete cfg.livePending;
      return;
    }
    if (Date.now() + 2000 > deadline) return;
    await sleep(2000);
  }
}

const CONFIG_CALLS = ['configBattery', 'configSystem', 'configTou'];

/** Reads one inverter's settings from both sources and stores them as setting `device_config:<sn>`. */
async function readSettings(client, sn, { waitMs = 12000 } = {}) {
  const prev = (await load(sn)) || {};
  const cfg = { sources: { ...(prev.sources || {}) }, sourceAt: { ...(prev.sourceAt || {}) }, confirmed: prev.confirmed || {}, errors: {} };
  for (const call of CONFIG_CALLS) {
    try {
      cfg.sources[call] = strip(await client[call](sn));
      cfg.sourceAt[call] = nowSec();
    } catch (err) {
      cfg.errors[call] = err.message;
    }
  }
  try {
    const res = await client.strategyRead(sn);
    if (!given(res.orderId)) throw new Error('DeyeCloud returned no order id for the live read');
    cfg.livePending = { orderId: res.orderId, at: nowSec() };
    await finishLiveRead(client, cfg, waitMs);
  } catch (err) {
    cfg.errors.live = err.message;
    delete cfg.livePending;
  }
  cfg.at = nowSec();
  rebuild(cfg);
  await save(sn, cfg);
  return cfg;
}

/** Inverters (not loggers or meters) of enabled stations. */
async function inverters() {
  const rows = await db.query(
    `SELECT d.sn, d.station_id, d.device_type, d.product_id, d.connect_status, s.name AS station_name, s.timezone
       FROM devices d LEFT JOIN stations s ON s.id = d.station_id
      WHERE d.enabled = 1 ORDER BY s.name, d.sn`
  );
  return rows.filter((d) => !d.device_type || DEVICE_TYPES.has(String(d.device_type).toUpperCase()));
}

/** Hourly from the collector: reads every inverter's settings. Returns the messages of failed reads. */
async function readAll(client) {
  const failed = [];
  for (const d of await inverters()) {
    const cfg = await readSettings(client, d.sn);
    for (const [source, msg] of Object.entries(cfg.errors)) failed.push(`${d.sn} ${source}: ${msg}`);
  }
  return failed;
}

/** On every collector run: completes live reads that were still waiting for the inverter. */
async function finishPendingReads(client) {
  for (const d of await inverters()) {
    const cfg = await load(d.sn);
    if (!cfg || !cfg.livePending) continue;
    cfg.sources = cfg.sources || {};
    cfg.sourceAt = cfg.sourceAt || {};
    cfg.errors = cfg.errors || {};
    await finishLiveRead(client, cfg, 0);
    rebuild(cfg);
    await save(d.sn, cfg);
  }
}

// ---------- changing ----------

const OPEN = "('pending', 'sent')";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function currentOf(cfg) {
  return { battery: { ...(cfg && cfg.battery) }, system: { ...(cfg && cfg.system) }, tou: { ...(cfg && cfg.tou) } };
}

/**
 * Validates every requested change, then queues the ones that differ from the current value.
 * Nothing is queued if any change is invalid. Returns the number queued.
 */
async function queueChanges(sn, changes, user) {
  if (!(await inverters()).some((d) => d.sn === sn)) {
    const err = new Error('Inverter not found');
    err.status = 404;
    throw err;
  }
  const entries = Object.entries(changes || {});
  if (!entries.length) throw badRequest('Nothing to change');
  const valid = entries.map(([name, value]) => [name, validate(name, value)]);
  const cur = currentOf(await load(sn));
  const rows = [];
  for (const [name, value] of valid) {
    const old = FIELDS[name].get(cur);
    if (old !== null && old !== undefined && same(old, value)) continue;
    rows.push([sn, name, old === null || old === undefined ? null : JSON.stringify(old), JSON.stringify(value), 'pending', user.id, user.username, nowSec()]);
  }
  if (rows.length) {
    await db.query('INSERT INTO inverter_commands (device_sn, field, old_value, new_value, status, user_id, username, created_ts) VALUES ?', [rows]);
  }
  return rows.length;
}

async function finish(cmd, status, message) {
  await db.query('UPDATE inverter_commands SET status = ?, message = ?, done_ts = ? WHERE id = ?', [status, message ? String(message).slice(0, 500) : null, nowSec(), cmd.id]);
}

// Records a change the inverter accepted, so the page shows it before DeyeCloud's copy catches up.
async function confirm(cmd) {
  const cfg = (await load(cmd.device_sn)) || { sources: {}, sourceAt: {} };
  cfg.confirmed = cfg.confirmed || {};
  cfg.confirmed[cmd.field] = { value: JSON.parse(cmd.new_value), ts: nowSec() };
  rebuild(cfg);
  await save(cmd.device_sn, cfg);
}

async function sendCommand(client, cmd) {
  const f = FIELDS[cmd.field];
  try {
    if (!f) throw new Error(`Unknown setting: ${cmd.field}`);
    const res = await f.send(client, cmd.device_sn, JSON.parse(cmd.new_value));
    const offline = Number(res.connectionStatus) === 0 ? 'The inverter was offline when the command was sent' : null;
    if (!given(res.orderId)) {
      await db.query("UPDATE inverter_commands SET status = 'accepted', sent_ts = ?, done_ts = ?, message = ? WHERE id = ?", [
        nowSec(),
        nowSec(),
        offline || 'Accepted by DeyeCloud, which gave no order to follow',
        cmd.id,
      ]);
      await confirm(cmd);
      return 'accepted';
    }
    await db.query("UPDATE inverter_commands SET status = 'sent', order_id = ?, sent_ts = ?, message = ? WHERE id = ?", [res.orderId, nowSec(), offline, cmd.id]);
    return 'sent';
  } catch (err) {
    await finish(cmd, 'failed', err.message);
    return 'failed';
  }
}

async function checkCommand(client, cmd) {
  let order;
  try {
    order = await client.orderStatus(cmd.order_id);
  } catch (err) {
    if (nowSec() - cmd.sent_ts > GIVE_UP) {
      await finish(cmd, 'failed', `No result within 15 minutes (${err.message})`);
      return 'failed';
    }
    return null;
  }
  const status = Number(order.status);
  if (status === 666) {
    await finish(cmd, 'succeeded', null);
    await confirm(cmd);
    return 'succeeded';
  }
  if (status === 400 || status === 500) {
    await finish(cmd, 'failed', orderError(order));
    return 'failed';
  }
  if (nowSec() - cmd.sent_ts > GIVE_UP) {
    await finish(cmd, 'failed', 'The inverter did not confirm the change within 15 minutes');
    return 'failed';
  }
  return null;
}

async function runCommands(client, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const changed = new Set();
  for (;;) {
    const open = await db.query(`SELECT * FROM inverter_commands WHERE status IN ${OPEN} ORDER BY id`);
    if (!open.length) break;
    const seen = new Set();
    for (const cmd of open) {
      if (seen.has(cmd.device_sn)) continue; // one command at a time per inverter
      seen.add(cmd.device_sn);
      const result = cmd.status === 'sent' ? await checkCommand(client, cmd) : await sendCommand(client, cmd);
      if (result === 'succeeded' || result === 'accepted') changed.add(cmd.device_sn);
    }
    if (Date.now() + 2500 > deadline) break;
    await sleep(2500);
  }
  // Fresh values from the inverter once all of its changes have gone through.
  for (const sn of changed) {
    const left = await db.one(`SELECT COUNT(*) AS n FROM inverter_commands WHERE device_sn = ? AND status IN ${OPEN}`, [sn]);
    if (!left.n) await readSettings(client, sn, { waitMs: 10000 }).catch((err) => console.error('[inverter] re-read failed:', err.message));
  }
}

/**
 * Sends queued changes and follows them for up to budgetMs. Runs under a database lock so only one
 * process sends; returns false when another process already is.
 */
async function processCommands(client, budgetMs = 20000) {
  const open = await db.one(`SELECT COUNT(*) AS n FROM inverter_commands WHERE status IN ${OPEN}`);
  if (!open.n) return true;
  const res = await db.withLock(CMD_LOCK, () => runCommands(client, budgetMs));
  return res.locked;
}

async function commands(sn, limit = 30) {
  return db.query('SELECT * FROM inverter_commands WHERE device_sn = ? ORDER BY id DESC LIMIT ?', [sn, limit]);
}

module.exports = {
  FIELDS,
  fieldInfo,
  validate,
  merge,
  readSettings,
  readAll,
  finishPendingReads,
  inverters,
  load,
  queueChanges,
  processCommands,
  commands,
};
