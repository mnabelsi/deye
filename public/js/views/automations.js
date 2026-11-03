import { api } from '../api.js';
import { $, esc, icon, toast, fmtNumber, fmtAgo, fmtTime, debounce, confirmDialog } from '../util.js';
import { sourceNames } from '../flow.js';

// Automations: rules that switch smart devices based on the inverter (grid or generator on, battery
// level, solar, load…), the time and other devices. Rules act when their conditions start or stop
// holding; the editor shows what each condition sees right now.

const OPS = [['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥']];
const OP_TEXT = Object.fromEntries(OPS);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TYPES = [
  ['source', 'Grid or generator on/off'],
  ['soc', 'Battery level'],
  ['power', 'Power (solar, load, grid…)'],
  ['battery', 'Battery charging or discharging'],
  ['time', 'Time of day and days'],
  ['device', 'Smart device on/off or online'],
  ['deviceReading', 'Smart device reading (power, temperature…)'],
  ['reading', 'Any inverter reading'],
];
const BRANCH = { then: 'Actions', else: 'Otherwise', enforce: 'Put back', test: 'Run by hand' };
const STATUS = { ok: ['ok', 'Done'], partial: ['warn', 'Partly'], failed: ['err', 'Failed'], nothing: ['', 'Nothing to do'] };

function defaults(type, ctx) {
  const dev = ctx.devices[0];
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
      const d = ctx.devices.find((x) => x.readings.some((r) => r.kind === 'number' && r.key !== 'rssi')) || dev;
      const r = d && d.readings.find((x) => x.kind === 'number' && x.key !== 'rssi');
      return { type, deviceId: d ? d.id : '', key: r ? r.key : '', op: 'gt', value: 0 };
    }
    case 'reading': {
      const m = ctx.metrics[0];
      return { type, metricId: m ? m.id : '', op: 'gt', value: 0 };
    }
    default:
      return { type };
  }
}

const TEMPLATES = [
  {
    key: 'grid-heater',
    title: 'Heater on while the grid is on',
    text: 'Turn a heater on when grid power comes, and off when it goes.',
    build: (c) => ({ name: `${c.names.grid} on → heater on`, conditions: [{ type: 'source', source: 'grid', state: 'on' }], holdMinutes: 2, actions: [c.pick('meter')].filter(Boolean).map((id) => ({ deviceId: id, channel: null, state: 'on' })), elseActions: [c.pick('meter')].filter(Boolean).map((id) => ({ deviceId: id, channel: null, state: 'off' })) }),
  },
  {
    key: 'night-lights',
    title: 'Lights off at night when the battery is low',
    text: 'Between 00:00 and 05:00, if the battery is under 30%, turn the lights off.',
    build: (c) => ({ name: 'Night: lights off on low battery', conditions: [{ type: 'time', from: '00:00', to: '05:00', days: [1, 2, 3, 4, 5, 6, 7] }, { type: 'soc', op: 'lt', value: 30 }], holdMinutes: 0, actions: c.devices.filter((d) => d.kind === 'light' || /light|lamp/i.test(d.name)).map((d) => ({ deviceId: d.id, channel: null, state: 'off' })), elseActions: [] }),
  },
  {
    key: 'surplus',
    title: 'Use spare solar',
    text: 'When solar makes 1.5 kW more than the home uses for 5 minutes, turn a load on; off again when it doesn’t.',
    build: (c) => ({ name: 'Spare solar → load on', conditions: [{ type: 'power', node: 'surplus', op: 'gt', value: 1500 }], holdMinutes: 5, actions: [c.pick('meter')].filter(Boolean).map((id) => ({ deviceId: id, channel: null, state: 'on' })), elseActions: [c.pick('meter')].filter(Boolean).map((id) => ({ deviceId: id, channel: null, state: 'off' })) }),
  },
  {
    key: 'generator',
    title: 'Heavy loads off on the generator',
    text: `While the generator runs, keep heavy loads off.`,
    build: (c) => ({ name: `${c.names.generator} running → heavy loads off`, conditions: [{ type: 'source', source: 'generator', state: 'on' }], holdMinutes: 0, actions: [c.pick('meter')].filter(Boolean).map((id) => ({ deviceId: id, channel: null, state: 'off' })), elseActions: [], enforce: true }),
  },
];

export async function mount(root, ctx) {
  const [auto, devs, live] = await Promise.all([
    api.get('/api/automations'),
    api.get('/api/ewelink/devices').catch(() => ({ devices: [], status: { connected: false } })),
    api.get('/api/live').catch(() => ({ stations: [] })),
  ]);
  let data = auto;
  const canEdit = data.canEdit;
  const stations = live.stations;
  const station0 = stations[0];
  const metrics = [];
  for (const s of stations) {
    for (const m of [...s.metrics, ...s.devices.flatMap((d) => d.metrics)]) if (m.kind === 'number') metrics.push({ ...m, station: s.name });
  }
  const c = {
    devices: devs.devices,
    metrics,
    names: sourceNames(station0),
    nodes: new Map(data.powerNodes.map((n) => [n.key, n.label])),
    pick: (kind) => (devs.devices.find((d) => d.kind === kind) || devs.devices.find((d) => d.channels.length) || {}).id,
  };
  const devById = new Map(c.devices.map((d) => [d.id, d]));
  const metricById = new Map(metrics.map((m) => [m.id, m]));
  let editing = null; // { id|null, draft }
  let checkResults = null;

  // ---------- describing rules ----------
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
        return `${x.source === 'grid' ? c.names.grid : c.names.generator} is ${x.state}`;
      case 'soc':
        return `battery ${OP_TEXT[x.op]} ${fmtNumber(x.value)}%`;
      case 'power':
        return `${(c.nodes.get(x.node) || x.node).replace(/ \(.*\)$/, '').toLowerCase()} ${OP_TEXT[x.op]} ${fmtNumber(x.value)} W`;
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
  const actText = (list) => (list.length ? list.map((a) => `turn ${a.state} ${devName(a.deviceId, a.channel)}`).join(', ') : '—');

  function ruleSummary(r) {
    const when = r.conditions.map((x) => esc(condText(x))).join(r.match === 'any' ? ' <b>or</b> ' : ' <b>and</b> ');
    return `<div><span class="muted">When</span> ${when}${r.holdMinutes ? ` <span class="muted">for ${r.holdMinutes} min</span>` : ''}</div>
      ${r.actions.length ? `<div><span class="muted">then</span> ${esc(actText(r.actions))}</div>` : ''}
      ${r.elseActions.length ? `<div><span class="muted">otherwise</span> ${esc(actText(r.elseActions))}</div>` : ''}
      ${r.enforce ? '<div class="small faint">Puts devices back if they are switched by hand.</div>' : ''}`;
  }

  function stateLine(a) {
    if (!a.enabled) return '<span class="badge">Off</span>';
    const dot = a.matching === null ? '' : a.matching ? 'ok' : '';
    const since = a.matching !== null && a.matchingSince ? ` since ${fmtTime(a.matchingSince, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
    const label = a.matching === null ? 'Not checked yet' : a.matching ? `Conditions hold${since}` : `Conditions not met${since}`;
    const note = a.note && !/^Conditions (hold|not met)$/.test(a.note) ? a.note : '';
    return `<span class="dot ${dot}"></span><span class="small"><b>${esc(label)}</b>${note ? ` · ${esc(note)}` : ''}${a.checkedTs ? ` <span class="faint">(checked ${esc(fmtAgo(a.checkedTs))})</span>` : ''}</span>`;
  }

  // ---------- page ----------
  ctx.actions.innerHTML = canEdit ? `<button class="btn sm primary" id="new-rule">${icon('plus')} New automation</button>` : '';
  root.innerHTML = `
    <div class="stack">
      <div id="banner"></div>
      <div id="editor"></div>
      <div id="rules" class="stack"></div>
      <div class="card"><div class="card-head"><h2>${icon('history', 'style="width:16px;height:16px;vertical-align:-3px"')} What automations did</h2></div><div id="runs"></div></div>
    </div>`;

  function renderBanner() {
    const parts = [];
    if (devs.status.reconnectNeeded) parts.push(`<div class="alert err">${icon('warn')}<div class="grow"><b>The eWeLink sign-in has expired.</b> Automations can't switch devices until it is reconnected${canEdit ? ' in <a href="#/settings?section=ewelink">Settings</a>' : ''}.</div></div>`);
    if (!devs.status.connected) parts.push(`<div class="alert warn">${icon('warn')}<div class="grow"><b>eWeLink is not connected.</b> Automations need it to switch devices. ${canEdit ? '<a href="#/settings?section=ewelink">Connect it in Settings</a>.' : 'Ask an admin to connect it.'}</div></div>`);
    if (data.paused) parts.push(`<div class="alert warn">${icon('warn')}<div class="grow"><b>All automations are paused.</b></div>${canEdit ? '<button class="btn sm" id="resume">Resume</button>' : ''}</div>`);
    parts.push(`<div class="alert">${icon('info')}<div class="grow small">Automations are checked every minute. They act when their conditions <b>start</b> holding, and run their “otherwise” actions when they <b>stop</b> holding, like scenes in the eWeLink app.
      Inverter readings come from DeyeCloud every few minutes, so a grid cut can take that long to show. While the inverter's data is stale, rules wait instead of acting on old values.</div>
      ${canEdit && !data.paused && data.automations.length ? '<button class="btn sm" id="pause">Pause all</button>' : ''}</div>`);
    $('#banner', root).innerHTML = parts.join('');
  }

  function renderRules() {
    if (!data.automations.length && !editing) {
      $('#rules', root).innerHTML = `<div class="card"><div class="card-head"><h2>Start from an idea</h2></div>
        <div class="grid templates">${TEMPLATES.map((t) => `<button class="template" data-template="${t.key}" ${canEdit ? '' : 'disabled'}><b>${esc(t.title)}</b><span class="small muted">${esc(t.text)}</span></button>`).join('')}</div>
        ${canEdit ? '' : '<p class="small faint" style="margin-top:10px">Only admins can create automations.</p>'}</div>`;
      return;
    }
    $('#rules', root).innerHTML = data.automations
      .map(
        (a) => `<div class="card rule-card ${a.enabled ? '' : 'disabled'}" data-id="${a.id}">
        <div class="card-head">${canEdit ? `<button type="button" class="toggle ${a.enabled ? 'on' : ''}" role="switch" aria-checked="${a.enabled}" data-enable="${a.id}" title="${a.enabled ? 'Turn off' : 'Turn on'}"><span></span></button>` : ''}
          <h2>${esc(a.name)}</h2>
          ${canEdit ? `<button class="btn sm ghost" data-check="${a.id}">${icon('check')} Check now</button>
            ${a.rule.actions.length ? `<button class="btn sm ghost" data-run="${a.id}" data-branch="then" title="Run the actions now">${icon('play')} Run</button>` : ''}
            ${a.rule.elseActions.length ? `<button class="btn sm ghost" data-run="${a.id}" data-branch="else" title="Run the otherwise actions now">${icon('play')} Run otherwise</button>` : ''}
            <button class="btn sm ghost" data-edit="${a.id}">${icon('edit')} Edit</button>
            <button class="btn sm ghost danger" data-del="${a.id}" title="Delete">${icon('trash')}</button>` : ''}</div>
        <div class="rule-summary">${ruleSummary(a.rule)}</div>
        <div class="row rule-state">${stateLine(a)}</div>
        <div class="check-out" id="check-${a.id}"></div>
      </div>`
      )
      .join('');
  }

  function renderRuns() {
    $('#runs', root).innerHTML = data.runs.length
      ? `<div class="table-wrap" style="max-height:460px"><table class="table"><thead><tr><th>When</th><th>Automation</th><th>What</th><th>Result</th><th>Details</th></tr></thead><tbody>${data.runs
          .map((r) => {
            const [cls, label] = STATUS[r.status] || ['', r.status];
            return `<tr><td class="nowrap small" title="${esc(fmtTime(r.ts))}">${esc(fmtTime(r.ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
              <td>${esc(r.name)}</td><td class="small">${esc(BRANCH[r.branch] || r.branch)}</td><td><span class="badge ${cls}">${esc(label)}</span></td>
              <td class="small"><div style="white-space:pre-line">${esc(r.message || '')}</div>${r.reason ? `<details><summary class="faint" style="cursor:pointer">Why</summary><div class="faint" style="white-space:pre-line">${esc(r.reason)}</div></details>` : ''}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : '<div class="empty small">No automation has run yet.</div>';
  }

  // ---------- editor ----------
  function deviceOptions(selected, filter = () => true) {
    const byRoom = new Map();
    for (const d of c.devices.filter(filter)) {
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
  const opSelect = (op) => `<select data-f="op" class="op">${OPS.map(([k, l]) => `<option value="${k}" ${op === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const sel = (field, value, options) => `<select data-f="${field}">${options.map(([k, l]) => `<option value="${esc(k)}" ${String(value) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  function condFields(x) {
    switch (x.type) {
      case 'source':
        return `${sel('source', x.source, [['grid', c.names.grid], ['generator', c.names.generator]])}<span>is</span>${sel('state', x.state, [['on', 'on (has power)'], ['off', 'off (no power)']])}`;
      case 'soc':
        return `<span>Battery</span>${opSelect(x.op)}<input type="number" data-f="value" value="${esc(x.value)}" min="0" max="100" class="num"><span>%</span>`;
      case 'power':
        return `${sel('node', x.node, data.powerNodes.map((n) => [n.key, n.label]))}${opSelect(x.op)}<input type="number" data-f="value" value="${esc(x.value)}" class="num"><span>W</span>`;
      case 'battery':
        return `<span>Battery is</span>${sel('state', x.state, [['charging', 'charging'], ['discharging', 'discharging'], ['idle', 'idle']])}`;
      case 'time':
        return `<span>between</span><input type="time" data-f="from" value="${esc(x.from)}"><span>and</span><input type="time" data-f="to" value="${esc(x.to)}"><span class="small faint">${esc(station0 && station0.timezone ? `(${station0.timezone} time)` : '')}</span>
          <span class="day-picks">${DAYS.map((d, i) => `<label class="check small"><input type="checkbox" data-day="${i + 1}" ${x.days.includes(i + 1) ? 'checked' : ''}>${d}</label>`).join('')}</span>`;
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

  function actionRows(list, kind) {
    return list
      .map(
        (a, i) => `<div class="edit-row" data-kind="${kind}" data-i="${i}">
        ${sel('state', a.state, [['on', 'Turn on'], ['off', 'Turn off']])}
        <select data-f="deviceId">${deviceOptions(a.deviceId, (d) => d.channels.length > 0)}</select>
        ${channelSelect(a.deviceId, a.channel, 'channel')}
        <button type="button" class="btn icon sm ghost" data-remove="${kind}" data-i="${i}" title="Remove">${icon('trash')}</button></div>`
      )
      .join('');
  }

  function checkBadge(i) {
    const r = checkResults && checkResults.results[i];
    if (!r) return '';
    return `<span class="check-badge ${r.ok === true ? 'ok' : r.ok === false ? 'no' : 'unknown'}" title="${esc(r.text)}">${r.ok === true ? '✓' : r.ok === false ? '✗' : '?'} ${esc(r.text)}</span>`;
  }

  function renderEditor() {
    const el = $('#editor', root);
    if (!editing) {
      el.innerHTML = '';
      return;
    }
    const r = editing.draft;
    const overall = checkResults ? (checkResults.ok === true ? '<span class="badge ok">The conditions hold right now</span>' : checkResults.ok === false ? '<span class="badge">The conditions do not hold right now</span>' : '<span class="badge warn">Some conditions can’t be checked right now</span>') : '';
    el.innerHTML = `<form class="card editor" novalidate>
      <div class="card-head"><h2>${editing.id ? 'Edit automation' : 'New automation'}</h2>${overall}</div>
      ${!editing.id ? `<div class="chips" style="margin-bottom:12px"><span class="small muted">Start from:</span>${TEMPLATES.map((t) => `<button type="button" class="chip" data-template="${t.key}">${esc(t.title)}</button>`).join('')}</div>` : ''}
      <div class="form-grid">
        <label class="field">Name<input type="text" data-f="name" value="${esc(r.name)}" maxlength="120" placeholder="e.g. Heater on with the grid"></label>
        ${stations.length > 1 ? `<label class="field">Inverter / station${sel('stationId', r.stationId || '', stations.map((s) => [s.id, s.name]))}</label>` : ''}
      </div>
      <h3 class="edit-h">When ${sel('match', r.match, [['all', 'all of these hold'], ['any', 'any of these holds']])}</h3>
      <div class="edit-list">${r.conditions
        .map(
          (x, i) => `<div class="edit-row" data-kind="cond" data-i="${i}">
          ${sel('type', x.type, TYPES)}${condFields(x)}
          <button type="button" class="btn icon sm ghost" data-remove="cond" data-i="${i}" title="Remove">${icon('trash')}</button>
          <div class="edit-check">${checkBadge(i)}</div></div>`
        )
        .join('')}</div>
      <div class="row"><button type="button" class="btn sm" data-add="cond">${icon('plus')} Add condition</button></div>
      <label class="check small" style="margin-top:10px">Wait <input type="number" data-f="holdMinutes" value="${esc(r.holdMinutes)}" min="0" max="1440" class="num inline-input"> minutes before acting, so short blips are ignored</label>
      <h3 class="edit-h">Then</h3>
      <div class="edit-list">${actionRows(r.actions, 'act')}</div>
      <div class="row"><button type="button" class="btn sm" data-add="act" ${c.devices.length ? '' : 'disabled'}>${icon('plus')} Add device</button></div>
      <h3 class="edit-h">Otherwise <span class="small muted" style="font-weight:400">when the conditions stop holding (optional)</span></h3>
      <div class="edit-list">${actionRows(r.elseActions, 'else')}</div>
      <div class="row"><button type="button" class="btn sm" data-add="else" ${c.devices.length ? '' : 'disabled'}>${icon('plus')} Add device</button></div>
      <div class="edit-options">
        <label class="check small"><input type="checkbox" data-f="enforce" ${r.enforce ? 'checked' : ''}> Keep devices this way: if someone switches them by hand, switch them back (checked every 5 minutes)</label>
        <label class="check small"><input type="checkbox" data-f="enabled" ${r.enabled ? 'checked' : ''}> Automation on</label>
      </div>
      <div class="form-error" id="edit-error"></div>
      <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">${icon('save')} Save</button></div>
    </form>`;
  }

  const runCheck = debounce(async () => {
    if (!editing) return;
    try {
      checkResults = await api.post('/api/automations/check', editing.draft);
      $('#edit-error', root).textContent = '';
    } catch (err) {
      checkResults = null;
      const e = $('#edit-error', root);
      if (e) e.textContent = err.message;
    }
    // Only the badges change, so typing isn't interrupted.
    $('#editor', root).querySelectorAll('.edit-row[data-kind="cond"]').forEach((row) => {
      const out = row.querySelector('.edit-check');
      if (out) out.innerHTML = checkBadge(Number(row.dataset.i));
    });
    const head = $('#editor .card-head', root);
    if (head) {
      const badge = head.querySelector('.badge');
      if (badge) badge.remove();
      if (checkResults) head.insertAdjacentHTML('beforeend', checkResults.ok === true ? '<span class="badge ok">The conditions hold right now</span>' : checkResults.ok === false ? '<span class="badge">The conditions do not hold right now</span>' : '<span class="badge warn">Some conditions can’t be checked right now</span>');
    }
  }, 500);

  function openEditor(id, draft) {
    const a = id ? data.automations.find((x) => x.id === id) : null;
    const base = a ? { ...a.rule, name: a.name, enabled: a.enabled } : { name: '', enabled: true, stationId: null, match: 'all', conditions: [defaults('source', c)], holdMinutes: 0, actions: [], elseActions: [], enforce: false };
    editing = { id: id || null, draft: JSON.parse(JSON.stringify({ ...base, ...(draft || {}) })) };
    checkResults = null;
    renderEditor();
    renderRules();
    $('#editor', root).scrollIntoView({ behavior: 'smooth', block: 'start' });
    runCheck();
  }

  function readField(row, el) {
    const f = el.dataset.f;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    if (['value', 'holdMinutes'].includes(f)) return v === '' ? '' : Number(v);
    if (['channel', 'metricId'].includes(f)) return v === '' ? null : Number(v);
    return v;
  }

  function onEdit(e) {
    if (!editing) return;
    const el = e.target;
    const row = el.closest('.edit-row');
    const r = editing.draft;
    let rerender = false;
    if (el.dataset.day) {
      const x = r.conditions[Number(row.dataset.i)];
      const day = Number(el.dataset.day);
      x.days = el.checked ? [...new Set([...x.days, day])].sort() : x.days.filter((d) => d !== day);
    } else if (!el.dataset.f) return;
    else if (!row) {
      r[el.dataset.f] = readField(null, el);
    } else {
      const list = row.dataset.kind === 'cond' ? r.conditions : row.dataset.kind === 'act' ? r.actions : r.elseActions;
      const i = Number(row.dataset.i);
      const f = el.dataset.f;
      if (f === 'type') {
        list[i] = defaults(el.value, c);
        rerender = true;
      } else {
        list[i][f] = readField(row, el);
        if (f === 'deviceId') {
          list[i].channel = null;
          if (list[i].type === 'deviceReading') {
            const d = devById.get(el.value);
            const rr = d && d.readings.find((x) => x.kind === 'number' && x.key !== 'rssi');
            list[i].key = rr ? rr.key : '';
          }
          rerender = true;
        }
      }
    }
    if (rerender && e.type === 'change') renderEditor();
    runCheck();
  }

  root.addEventListener('input', (e) => {
    if (e.target.closest('.editor') && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') onEdit(e);
  });
  root.addEventListener('change', (e) => {
    if (e.target.closest('.editor')) onEdit(e);
  });
  root.addEventListener('submit', async (e) => {
    if (!e.target.closest('.editor')) return;
    e.preventDefault();
    try {
      if (editing.id) await api.put(`/api/automations/${editing.id}`, editing.draft);
      else await api.post('/api/automations', editing.draft);
      toast('Automation saved. It is checked within a minute.', 'ok');
      editing = null;
      checkResults = null;
      await reload();
    } catch (err) {
      $('#edit-error', root).textContent = err.message;
    }
  });

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.template) {
        const tpl = TEMPLATES.find((x) => x.key === t.dataset.template);
        openEditor(editing && editing.id ? editing.id : null, { enabled: true, stationId: null, match: 'all', enforce: false, ...tpl.build(c) });
      } else if (t.dataset.add) {
        const r = editing.draft;
        if (t.dataset.add === 'cond') r.conditions.push(defaults(r.conditions.some((x) => x.type === 'time') ? 'soc' : 'time', c));
        else {
          const first = c.devices.find((d) => d.channels.length);
          (t.dataset.add === 'act' ? r.actions : r.elseActions).push({ deviceId: first ? first.id : '', channel: null, state: t.dataset.add === 'act' ? 'on' : 'off' });
        }
        renderEditor();
        runCheck();
      } else if (t.dataset.remove) {
        const r = editing.draft;
        const list = t.dataset.remove === 'cond' ? r.conditions : t.dataset.remove === 'act' ? r.actions : r.elseActions;
        list.splice(Number(t.dataset.i), 1);
        renderEditor();
        runCheck();
      } else if (t.hasAttribute('data-cancel')) {
        editing = null;
        checkResults = null;
        renderEditor();
        renderRules();
      } else if (t.dataset.edit) {
        openEditor(Number(t.dataset.edit));
      } else if (t.dataset.enable) {
        const a = data.automations.find((x) => x.id === Number(t.dataset.enable));
        await api.post(`/api/automations/${a.id}/enabled`, { enabled: !a.enabled });
        toast(a.enabled ? 'Automation turned off' : 'Automation turned on', 'ok');
        await reload();
      } else if (t.dataset.check) {
        const a = data.automations.find((x) => x.id === Number(t.dataset.check));
        const r = await api.post('/api/automations/check', { ...a.rule, name: a.name });
        $(`#check-${a.id}`, root).innerHTML = `<div class="check-list">${r.results.map((x) => `<span class="check-badge ${x.ok === true ? 'ok' : x.ok === false ? 'no' : 'unknown'}">${x.ok === true ? '✓' : x.ok === false ? '✗' : '?'} ${esc(x.text)}</span>`).join('')}</div>`;
      } else if (t.dataset.run) {
        const a = data.automations.find((x) => x.id === Number(t.dataset.run));
        const branch = t.dataset.branch;
        const list = branch === 'else' ? a.rule.elseActions : a.rule.actions;
        if (!(await confirmDialog('Run now', `${actText(list).replace(/^./, (s) => s.toUpperCase())}?`, 'Run'))) return;
        const r = await api.post(`/api/automations/${a.id}/run`, { branch });
        toast(r.message || 'Done', r.status === 'failed' ? 'err' : 'ok');
        await reload();
      } else if (t.dataset.del) {
        const a = data.automations.find((x) => x.id === Number(t.dataset.del));
        if (!(await confirmDialog('Delete automation', `Delete “${a.name}” and its log?`, 'Delete'))) return;
        await api.del(`/api/automations/${a.id}`);
        toast('Automation deleted', 'ok');
        await reload();
      } else if (t.id === 'pause' || t.id === 'resume') {
        await api.post('/api/automations/paused', { paused: t.id === 'pause' });
        await reload();
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  const nb = $('#new-rule');
  if (nb) nb.onclick = () => openEditor(null);

  async function reload() {
    data = await api.get('/api/automations');
    renderBanner();
    renderEditor();
    renderRules();
    renderRuns();
  }

  renderBanner();
  renderRules();
  renderRuns();
  const timer = setInterval(async () => {
    if (editing) return;
    try {
      data = await api.get('/api/automations');
      renderBanner();
      renderRules();
      renderRuns();
    } catch {}
  }, 20000);
  return () => clearInterval(timer);
}
