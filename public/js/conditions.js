import { esc, fmtNumber } from './util.js';

// The condition editor shared by Automations and Notifications: the kinds of condition, their
// fields, and a one-line description of each. The server checks them with src/automations.js.

export const OPS = [['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥']];
export const OP_TEXT = Object.fromEntries(OPS);
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const CONDITION_TYPES = [
  ['source', 'Grid or generator on/off'],
  ['soc', 'Battery level'],
  ['power', 'Power (solar, load, grid…)'],
  ['battery', 'Battery charging or discharging'],
  ['time', 'Time of day and days'],
  ['device', 'Smart device on/off or online'],
  ['deviceReading', 'Smart device reading (power, temperature…)'],
  ['reading', 'Any inverter reading'],
];

export const sel = (field, value, options) => `<select data-f="${field}">${options.map(([k, l]) => `<option value="${esc(k)}" ${String(value) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
export const opSelect = (op) => `<select data-f="op" class="op">${OPS.map(([k, l]) => `<option value="${k}" ${op === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

/**
 * Helpers bound to what this installation has. `devices` come from /api/ewelink/devices, `metrics`
 * are the inverter's number readings (with `category`), `names` the grid's and generator's names,
 * `powerNodes` [{ key, label }], and `timeZone()` the zone time conditions are read in.
 */
export function conditionKit({ devices = [], metrics = [], names, powerNodes = [], timeZone = () => '' }) {
  const devById = new Map(devices.map((d) => [d.id, d]));
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const nodes = new Map(powerNodes.map((n) => [n.key, n.label]));

  function defaults(type) {
    const dev = devices[0];
    switch (type) {
      case 'source':
        return { type, source: 'grid', state: 'on' };
      case 'soc':
        return { type, op: 'lt', value: 30 };
      case 'power':
        return { type, node: 'surplus', op: 'gt', value: 1000 };
      case 'battery':
        return { type, state: 'charging' };
      case 'time':
        return { type, from: '00:00', to: '05:00', days: [1, 2, 3, 4, 5, 6, 7] };
      case 'device':
        return { type, deviceId: dev ? dev.id : '', channel: null, state: 'on' };
      case 'deviceReading': {
        const d = devices.find((x) => x.readings.some((r) => r.kind === 'number' && r.key !== 'rssi')) || dev;
        const r = d && d.readings.find((x) => x.kind === 'number' && x.key !== 'rssi');
        return { type, deviceId: d ? d.id : '', key: r ? r.key : '', op: 'gt', value: 0 };
      }
      case 'reading': {
        const m = metrics[0];
        return { type, metricId: m ? m.id : '', op: 'gt', value: 0 };
      }
      default:
        return { type };
    }
  }

  const devName = (id, channel) => {
    const d = devById.get(id);
    if (!d) return `device ${id}`;
    if (channel === null || channel === undefined || d.channels.length < 2) return d.name;
    const ch = d.channels.find((x) => x.index === channel);
    return `${d.name} (${ch ? ch.name : `channel ${channel + 1}`})`;
  };

  function condText(x) {
    switch (x.type) {
      case 'source':
        return `${x.source === 'grid' ? names.grid : names.generator} is ${x.state}`;
      case 'soc':
        return `battery ${OP_TEXT[x.op]} ${fmtNumber(x.value)}%`;
      case 'power':
        return `${(nodes.get(x.node) || x.node).replace(/ \(.*\)$/, '').toLowerCase()} ${OP_TEXT[x.op]} ${fmtNumber(x.value)} W`;
      case 'battery':
        return `battery is ${x.state}`;
      case 'time':
        return `time is ${x.from}–${x.to}${x.days.length === 7 ? '' : ` on ${x.days.map((d) => DAYS[d - 1]).join(', ')}`}`;
      case 'device':
        return `${devName(x.deviceId, x.channel)} is ${x.state}`;
      case 'deviceReading': {
        const d = devById.get(x.deviceId);
        const r = d && d.readings.find((y) => y.key === x.key);
        return `${d ? d.name : x.deviceId} ${r ? r.label.toLowerCase() : x.key} ${OP_TEXT[x.op]} ${fmtNumber(x.value)}${r && r.unit ? ` ${r.unit}` : ''}`;
      }
      case 'reading': {
        const m = metricById.get(x.metricId);
        return `${m ? m.label : `reading #${x.metricId}`} ${OP_TEXT[x.op]} ${fmtNumber(x.value)}${m && m.unit ? ` ${m.unit}` : ''}`;
      }
      default:
        return x.type;
    }
  }

  function deviceOptions(selected, filter = () => true) {
    const byRoom = new Map();
    for (const d of devices.filter(filter)) {
      const k = d.room || 'No room';
      if (!byRoom.has(k)) byRoom.set(k, []);
      byRoom.get(k).push(d);
    }
    if (selected && !devById.has(selected)) byRoom.set('Missing', [{ id: selected, name: `Unknown device ${selected}` }]);
    return [...byRoom.entries()].map(([room, list]) => `<optgroup label="${esc(room)}">${list.map((d) => `<option value="${esc(d.id)}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</optgroup>`).join('');
  }

  function channelSelect(deviceId, channel, field, allLabel = 'All channels') {
    const d = devById.get(deviceId);
    if (!d || d.channels.length < 2) return '';
    return `<select data-f="${field}"><option value="" ${channel === null || channel === undefined ? 'selected' : ''}>${allLabel}</option>${d.channels.map((ch) => `<option value="${ch.index}" ${channel === ch.index ? 'selected' : ''}>${esc(ch.name)}</option>`).join('')}</select>`;
  }

  function condFields(x) {
    switch (x.type) {
      case 'source':
        return `${sel('source', x.source, [['grid', names.grid], ['generator', names.generator]])}<span>is</span>${sel('state', x.state, [['on', 'on (has power)'], ['off', 'off (no power)']])}`;
      case 'soc':
        return `<span>Battery</span>${opSelect(x.op)}<input type="number" data-f="value" value="${esc(x.value)}" min="0" max="100" class="num"><span>%</span>`;
      case 'power':
        return `${sel('node', x.node, powerNodes.map((n) => [n.key, n.label]))}${opSelect(x.op)}<input type="number" data-f="value" value="${esc(x.value)}" class="num"><span>W</span>`;
      case 'battery':
        return `<span>Battery is</span>${sel('state', x.state, [['charging', 'charging'], ['discharging', 'discharging'], ['idle', 'idle']])}`;
      case 'time': {
        const tz = timeZone();
        return `<span>between</span><input type="time" data-f="from" value="${esc(x.from)}"><span>and</span><input type="time" data-f="to" value="${esc(x.to)}"><span class="small faint">${esc(tz ? `(${tz} time)` : '')}</span>
          <span class="day-picks">${DAYS.map((d, i) => `<label class="check small"><input type="checkbox" data-day="${i + 1}" ${x.days.includes(i + 1) ? 'checked' : ''}>${d}</label>`).join('')}</span>`;
      }
      case 'device':
        return `<select data-f="deviceId">${deviceOptions(x.deviceId)}</select>${channelSelect(x.deviceId, x.channel, 'channel', 'Any channel')}<span>is</span>${sel('state', x.state, [['on', 'on'], ['off', 'off'], ['online', 'online'], ['offline', 'offline']])}`;
      case 'deviceReading': {
        const d = devById.get(x.deviceId);
        const rs = d ? d.readings.filter((r) => r.kind === 'number') : [];
        return `<select data-f="deviceId">${deviceOptions(x.deviceId, (dd) => dd.readings.some((r) => r.kind === 'number'))}</select>
          ${sel('key', x.key, rs.map((r) => [r.key, `${r.label}${r.unit ? ` (${r.unit})` : ''}`]))}${opSelect(x.op)}<input type="number" data-f="value" value="${esc(x.value)}" step="any" class="num">`;
      }
      case 'reading':
        return `<select data-f="metricId">${metrics.map((m) => `<option value="${m.id}" ${m.id === Number(x.metricId) ? 'selected' : ''}>${esc(`${m.category} · ${m.label}${m.unit ? ` (${m.unit})` : ''}`)}</option>`).join('')}</select>
          ${opSelect(x.op)}<input type="number" data-f="value" value="${esc(x.value)}" step="any" class="num">`;
      default:
        return '';
    }
  }

  /** A condition after one of its fields changed: picking a new device resets what depends on it. */
  function changed(x, field, value) {
    if (field === 'type') return defaults(value);
    const out = { ...x, [field]: value };
    if (field === 'deviceId') {
      out.channel = null;
      if (x.type === 'deviceReading') {
        const d = devById.get(value);
        const r = d && d.readings.find((y) => y.kind === 'number' && y.key !== 'rssi');
        out.key = r ? r.key : '';
      }
    }
    return out;
  }

  return { devById, metricById, defaults, devName, condText, condFields, deviceOptions, channelSelect, changed };
}
