'use strict';

// What an eWeLink device is and can do, worked out from its UIID (eWeLink's device-type number)
// and its params. Covers switches and plugs (single and multi-channel), power-metering plugs,
// lights, thermostats and sensors as described in eWeLink's UIID protocol; anything else still
// shows its raw params and can be sent raw params by an admin.

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Channel counts of multi-channel devices (params.switches[].outlet 0..n-1).
const MULTI = {
  2: 2, 3: 3, 4: 4, 7: 2, 8: 3, 9: 4, 29: 2, 30: 3, 31: 4, 34: 4, 41: 4, 82: 2, 83: 3, 84: 4, 113: 2, 114: 3,
  126: 2, 130: 4, 133: 2, 139: 2, 140: 3, 141: 4, 161: 2, 162: 3, 163: 4, 165: 2, 210: 2, 211: 3, 212: 4,
  289: 2, 290: 4, 2256: 2, 3256: 3, 4256: 4,
};
const LIGHTS = new Set([22, 33, 36, 44, 45, 52, 56, 57, 59, 103, 104, 135, 136, 137, 157, 159, 173, 179, 1257, 1258, 3258]);
const FANS = new Set([17, 34]);
const THERMOSTATS = new Set([15, 181, 1771]);
const METERING = new Set([5, 32, 126, 130, 182, 190, 226, 283, 286, 289, 290, 294, 295]);
// Sensors whose "switch" is a reading (door open/closed), not a relay.
const DOOR_SWITCH = new Set([102, 154]);
const SENSORS = new Set([18, 102, 154, 1000, 1770, 2026, 3026, 4026, 5026, 7002, 7003, 7014, 7016]);
// Newer devices report numeric power, voltage, current and energy × 100.
const X100 = new Set([126, 130, 182, 190, 226, 283, 286, 289, 290, 294, 295]);
// Zigbee sensors report temperature and humidity × 100.
const ZIGBEE_TH = new Set([1770, 7014]);

function kindOf(uiid, params) {
  if (LIGHTS.has(uiid)) return 'light';
  if (FANS.has(uiid)) return 'fan';
  if (THERMOSTATS.has(uiid)) return 'thermostat';
  if (SENSORS.has(uiid)) return 'sensor';
  if (METERING.has(uiid) || (params && params.power !== undefined)) return 'meter';
  return 'switch';
}

const KIND_LABELS = { light: 'Light', fan: 'Fan', thermostat: 'Thermostat', sensor: 'Sensor', meter: 'Plug with power metering', switch: 'Switch' };

/** How the device's relays are addressed: { mode: 'single'|'multi'|'none', count }. */
function channelMode(uiid, params = {}) {
  if (DOOR_SWITCH.has(uiid) || SENSORS.has(uiid)) return { mode: 'none', count: 0 };
  if (MULTI[uiid]) return { mode: 'multi', count: MULTI[uiid] };
  if (typeof params.switch === 'string' || typeof params.switch === 'boolean') return { mode: 'single', count: 1 };
  // "Multi-channel protocol" single relays (UIID 77, 78, 138, 160, 182, 190...) use switches[0].
  if (Array.isArray(params.switches) && params.switches.length) return { mode: 'multi', count: 1 };
  return { mode: 'none', count: 0 };
}

function channelNames(raw) {
  const tags = (raw && raw.tags) || {};
  const names = tags.ck_channel_name || {};
  return typeof names === 'object' ? names : {};
}

/** [{ index, name, state }] for each relay; state 'on' | 'off' | null. */
function channels(dev) {
  const p = dev.params || {};
  const { mode, count } = channelMode(dev.uiid, p);
  const names = channelNames(dev.raw);
  if (mode === 'single') {
    const state = p.switch === 'on' || p.switch === true ? 'on' : p.switch === 'off' || p.switch === false ? 'off' : null;
    return [{ index: 0, name: names['0'] || (dev.uiid === 34 ? 'Light' : 'Power'), state }];
  }
  if (mode !== 'multi') return [];
  const list = Array.isArray(p.switches) ? p.switches : [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = list.find((x) => Number(x.outlet) === i);
    const fallback = dev.uiid === 34 ? ['Light', 'Fan low', 'Fan medium', 'Fan high'][i] : count === 1 ? 'Power' : `Channel ${i + 1}`;
    out.push({ index: i, name: names[String(i)] || fallback, state: s ? (s.switch === 'on' ? 'on' : 'off') : null });
  }
  return out;
}

/** Params that set one channel (or every channel when channel is null) to 'on' or 'off'. */
function switchParams(dev, channel, state) {
  const { mode, count } = channelMode(dev.uiid, dev.params || {});
  // UIID 226 (circuit breaker) takes true/false instead of "on"/"off".
  if (mode === 'single') return { switch: typeof (dev.params || {}).switch === 'boolean' ? state === 'on' : state };
  if (mode === 'multi') {
    const outlets = channel === null || channel === undefined ? [...Array(count).keys()] : [Number(channel)];
    return { switches: outlets.filter((o) => o >= 0 && o < count).map((outlet) => ({ switch: state, outlet })) };
  }
  return null;
}

// ---------- readings ----------

function scaled(uiid, v) {
  if (typeof v === 'string') return num(v);
  const n = num(v);
  return n === null ? null : X100.has(uiid) ? n / 100 : n;
}

/** Readings shown on the device and stored as history: [{ key, label, value, unit, kind }]. */
function readings(dev) {
  const p = dev.params || {};
  const u = dev.uiid;
  const out = [];
  const add = (key, label, value, unit, kind = 'number') => {
    if (value === null || value === undefined || value === '') return;
    out.push({ key, label, value, unit: unit || '', kind });
  };

  if (p.power !== undefined) add('power', 'Power', scaled(u, p.power), 'W');
  if (p.voltage !== undefined) add('voltage', 'Voltage', scaled(u, p.voltage), 'V');
  if (p.current !== undefined) add('current', 'Current', scaled(u, p.current), 'A');
  // Dual R3 / SPM sub-channels: actPow_00, voltage_00, current_00 … (× 100).
  for (const [k, v] of Object.entries(p)) {
    const m = /^(actPow|voltage|current)_0(\d)$/.exec(k);
    if (!m) continue;
    const ch = Number(m[2]) + 1;
    const [label, unit] = { actPow: ['Power', 'W'], voltage: ['Voltage', 'V'], current: ['Current', 'A'] }[m[1]];
    add(`${m[1] === 'actPow' ? 'power' : m[1]}_${ch}`, `${label} (channel ${ch})`, num(v) === null ? null : num(v) / 100, unit);
  }
  if (p.dayKwh !== undefined) add('dayKwh', 'Energy today', scaled(u, p.dayKwh), 'kWh');
  if (p.monthKwh !== undefined) add('monthKwh', 'Energy this month', scaled(u, p.monthKwh), 'kWh');
  if (p.totalKwh !== undefined) add('totalKwh', 'Energy total', scaled(u, p.totalKwh), 'kWh');
  if (p.oneKwhData !== undefined) add('oneKwhData', 'Energy (since started)', num(p.oneKwhData), 'kWh');

  const t = p.currentTemperature !== undefined ? p.currentTemperature : p.temperature;
  const h = p.currentHumidity !== undefined ? p.currentHumidity : p.humidity;
  if (t !== undefined && String(t) !== 'unavailable') add('temperature', 'Temperature', ZIGBEE_TH.has(u) ? (num(t) === null ? null : num(t) / 100) : num(t), '°C');
  if (h !== undefined && String(h) !== 'unavailable') add('humidity', 'Humidity', ZIGBEE_TH.has(u) ? (num(h) === null ? null : num(h) / 100) : num(h), '%');

  if (DOOR_SWITCH.has(u) && p.switch !== undefined) add('door', 'Door', p.switch === 'on' ? 'open' : 'closed', '', 'text');
  if (p.lock !== undefined && SENSORS.has(u)) add('door', 'Door', Number(p.lock) ? 'open' : 'closed', '', 'text');
  if (p.motion !== undefined) add('motion', 'Motion', Number(p.motion) ? 'detected' : 'clear', '', 'text');
  if (p.water !== undefined) add('water', 'Water leak', Number(p.water) ? 'leak' : 'dry', '', 'text');
  if (p.smoke !== undefined) add('smoke', 'Smoke', Number(p.smoke) ? 'smoke' : 'clear', '', 'text');
  if (p.battery !== undefined) add('battery', 'Battery', num(p.battery), u === 102 || u === 154 ? 'V' : '%');

  const b = brightness(dev);
  if (b) add('brightness', 'Brightness', b.value, '%');
  if (p.rssi !== undefined) add('rssi', 'Wi-Fi signal', num(p.rssi), 'dBm');
  return out;
}

// ---------- extra controls ----------

/** Brightness (1-100) and how to set it, for lights that report one. */
function brightness(dev) {
  const p = dev.params || {};
  if (p.ltype && p[p.ltype] && typeof p[p.ltype] === 'object' && num(p[p.ltype].br) !== null) {
    return { value: num(p[p.ltype].br), min: 1, max: 100, set: (v) => ({ ltype: p.ltype, [p.ltype]: { ...p[p.ltype], br: v } }) };
  }
  for (const key of ['brightness', 'bright']) {
    if (num(p[key]) !== null) return { value: num(p[key]), min: 1, max: 100, set: (v) => ({ [key]: v }) };
  }
  return null;
}

/** Power-on state: single relays use startup, multi-channel ones configure[] (on | off | stay). */
function powerOnState(dev) {
  const p = dev.params || {};
  if (typeof p.startup === 'string') return { perChannel: false, values: [p.startup] };
  if (Array.isArray(p.configure) && p.configure.length) {
    const count = channels(dev).length || p.configure.length;
    const values = [];
    for (let i = 0; i < count; i++) {
      const c = p.configure.find((x) => Number(x.outlet) === i);
      values.push(c ? c.startup : null);
    }
    return { perChannel: true, values };
  }
  return null;
}

/** Inching (turns itself off again after a delay): pulse / pulseWidth, or pulses[] per channel. */
function inching(dev) {
  const p = dev.params || {};
  if (typeof p.pulse === 'string') return { perChannel: false, values: [{ on: p.pulse === 'on', ms: num(p.pulseWidth) || 1000 }] };
  if (Array.isArray(p.pulses) && p.pulses.length) {
    const count = channels(dev).length || p.pulses.length;
    const values = [];
    for (let i = 0; i < count; i++) {
      const x = p.pulses.find((y) => Number(y.outlet) === i);
      values.push(x ? { on: x.pulse === 'on', ms: num(x.width !== undefined ? x.width : x.pulseWidth) || 1000 } : null);
    }
    return { perChannel: true, values };
  }
  return null;
}

/**
 * Turns a friendly setting from the device page into eWeLink params, or null when the device
 * doesn't have it. Validated here so the browser can't send arbitrary values through these.
 */
function settingParams(dev, setting, value, channel) {
  const p = dev.params || {};
  const ch = channel === null || channel === undefined || channel === '' ? null : Number(channel);
  switch (setting) {
    case 'brightness': {
      const b = brightness(dev);
      const v = Math.round(Number(value));
      if (!b || !Number.isFinite(v)) return null;
      return b.set(Math.min(b.max, Math.max(b.min, v)));
    }
    case 'startup': {
      if (!['on', 'off', 'stay'].includes(value)) return null;
      const s = powerOnState(dev);
      if (!s) return null;
      if (!s.perChannel) return { startup: value };
      if (ch === null || !Number.isInteger(ch) || ch < 0 || ch >= s.values.length) return null;
      const list = p.configure.map((c) => ({ ...c }));
      const it = list.find((c) => Number(c.outlet) === ch);
      if (it) it.startup = value;
      else list.push({ startup: value, outlet: ch });
      return { configure: list };
    }
    case 'inching': {
      const s = inching(dev);
      const on = Boolean(value && value.on);
      const ms = Math.min(3600000, Math.max(500, Math.round((Number(value && value.ms) || 1000) / 500) * 500));
      if (!s) return null;
      if (!s.perChannel) return { pulse: on ? 'on' : 'off', pulseWidth: ms };
      if (ch === null || !Number.isInteger(ch) || ch < 0 || ch >= s.values.length) return null;
      const list = p.pulses.map((x) => ({ ...x }));
      const it = list.find((x) => Number(x.outlet) === ch);
      const widthKey = it && it.width !== undefined ? 'width' : 'pulseWidth';
      if (it) Object.assign(it, { pulse: on ? 'on' : 'off', [widthKey]: ms });
      else list.push({ pulse: on ? 'on' : 'off', pulseWidth: ms, outlet: ch });
      return { pulses: list };
    }
    case 'led':
      if (typeof p.sledOnline !== 'string' || !['on', 'off'].includes(value)) return null;
      return { sledOnline: value };
    default:
      return null;
  }
}

/** Merges params a device reported into what we knew; switch lists are merged by outlet. */
function mergeParams(cur, upd) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(upd || {})) {
    if (['switches', 'configure', 'pulses'].includes(k) && Array.isArray(v) && Array.isArray(out[k])) {
      const list = out[k].map((x) => ({ ...x }));
      for (const item of v) {
        const i = list.findIndex((x) => Number(x.outlet) === Number(item.outlet));
        if (i >= 0) list[i] = { ...list[i], ...item };
        else list.push({ ...item });
      }
      out[k] = list;
    } else if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Samples for the metrics tables: relay states, online state and readings. */
function samples(dev, ts) {
  const out = [];
  const chs = channels(dev);
  for (const c of chs) {
    if (!c.state) continue;
    out.push({ ts, key: chs.length === 1 && channelMode(dev.uiid, dev.params).mode === 'single' ? 'switch' : `switch_${c.index + 1}`, value: c.state, name: c.name });
  }
  if (dev.online !== null && dev.online !== undefined) out.push({ ts, key: 'online', value: dev.online ? 'online' : 'offline', name: 'Connection' });
  for (const r of readings(dev)) {
    if (r.value === null) continue;
    out.push({ ts, key: r.key, value: r.value, unit: r.unit || undefined, name: r.label });
  }
  return out;
}

/** The metric key that holds a channel's state. */
function channelKey(dev, index) {
  const chs = channels(dev);
  return chs.length === 1 && channelMode(dev.uiid, dev.params).mode === 'single' ? 'switch' : `switch_${Number(index) + 1}`;
}

/** A short text for a command, for the action log ("Channel 2 on", "Brightness 40%"). */
function summarize(dev, params) {
  const parts = [];
  const chs = channels(dev);
  if (params.switch !== undefined && typeof params.switch !== 'object') {
    const word = params.switch === true ? 'on' : params.switch === false ? 'off' : params.switch;
    parts.push(`${chs.length === 1 && chs[0].name !== 'Power' ? `${chs[0].name} ` : ''}${word}`);
  }
  if (Array.isArray(params.switches)) {
    if (params.switches.length === chs.length && chs.length > 1 && params.switches.every((s) => s.switch === params.switches[0].switch)) {
      parts.push(`all channels ${params.switches[0].switch}`);
    } else {
      for (const s of params.switches) {
        const c = chs.find((x) => x.index === Number(s.outlet));
        parts.push(`${chs.length > 1 ? `${c ? c.name : `Channel ${Number(s.outlet) + 1}`} ` : ''}${s.switch}`);
      }
    }
  }
  const b = brightness({ ...dev, params: mergeParams(dev.params, params) });
  if (b && (params.brightness !== undefined || params.bright !== undefined || (params.ltype && params[params.ltype]))) parts.push(`brightness ${b.value}%`);
  if (params.startup) parts.push(`power-on state ${params.startup}`);
  if (params.configure) parts.push('power-on state changed');
  if (params.pulse) parts.push(`inching ${params.pulse}${params.pulse === 'on' ? ` (${(params.pulseWidth || 0) / 1000} s)` : ''}`);
  if (params.pulses) parts.push('inching changed');
  if (params.sledOnline) parts.push(`indicator light ${params.sledOnline}`);
  if (params.hundredDaysKwh) parts.push('energy history requested');
  if (!parts.length) parts.push(JSON.stringify(params).slice(0, 120));
  return parts.join(', ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Daily energy of the last 100 days (newest first) from hundredDaysKwhData, which POW plugs send
 * when asked with { hundredDaysKwh: 'get' }. UIID 5/32 pack each day as 3 hex bytes: whole kWh,
 * tenths, hundredths; newer devices as a 2-byte whole part and 1 byte of hundredths.
 */
function hundredDays(dev) {
  const data = dev.params && dev.params.hundredDaysKwhData;
  if (typeof data !== 'string' || data.length < 6 || !/^[0-9a-f]+$/i.test(data)) return null;
  const out = [];
  for (let i = 0; i + 6 <= data.length && out.length < 100; i += 6) {
    const c = data.slice(i, i + 6);
    const v = X100.has(dev.uiid)
      ? parseInt(c.slice(0, 4), 16) + parseInt(c.slice(4, 6), 16) / 100
      : parseInt(c.slice(0, 2), 16) + parseInt(c.slice(2, 4), 16) / 10 + parseInt(c.slice(4, 6), 16) / 100;
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

const canAskHundredDays = (dev) => [5, 32].includes(dev.uiid) || (dev.params && dev.params.hundredDaysKwhData !== undefined);

/** Everything the UI shows about one device. */
function describe(dev) {
  const chs = channels(dev);
  const b = brightness(dev);
  const p = dev.params || {};
  return {
    id: dev.deviceid,
    name: dev.name || dev.deviceid,
    uiid: dev.uiid,
    kind: kindOf(dev.uiid, p),
    kindLabel: KIND_LABELS[kindOf(dev.uiid, p)],
    model: dev.model,
    brand: dev.brand,
    shared: dev.item_type === 2,
    room: dev.room_name || null,
    online: dev.online === null || dev.online === undefined ? null : Boolean(dev.online),
    hidden: Boolean(dev.hidden),
    seenTs: dev.seen_ts,
    updatedTs: dev.updated_ts,
    channels: chs,
    readings: readings(dev),
    controls: {
      brightness: b ? { value: b.value, min: b.min, max: b.max } : null,
      startup: powerOnState(dev),
      inching: inching(dev),
      led: typeof p.sledOnline === 'string' ? p.sledOnline : null,
      hundredDays: canAskHundredDays(dev),
    },
    firmware: p.fwVersion || null,
    mac: (dev.raw && dev.raw.extra && dev.raw.extra.mac) || null,
    timers: Array.isArray(p.timers) ? p.timers.length : 0,
  };
}

module.exports = {
  channels,
  channelMode,
  channelKey,
  switchParams,
  settingParams,
  readings,
  samples,
  mergeParams,
  summarize,
  describe,
  hundredDays,
  canAskHundredDays,
  kindOf,
};
