import { api } from '../api.js';
import { $, $$, esc, icon, toast, modal, fmtAgo, fmtTime, fmtNumber } from '../util.js';
import { touSlot } from '../flow.js';

// The inverter's settings, read from DeyeCloud (its stored copy plus a live read from the
// inverter), and, for admins, forms to change them. Changes are sent one at a time and the
// inverter confirms each; the log at the bottom shows who changed what and how it went.

const LABELS = {
  BATTERY_FIRST: 'Battery first',
  LOAD_FIRST: 'Load first',
  SELLING_FIRST: 'Selling first',
  ZERO_EXPORT_TO_LOAD: 'Zero export to load',
  ZERO_EXPORT_TO_CT: 'Zero export to CT',
};
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const dayShort = (d) => d.charAt(0) + d.slice(1, 3).toLowerCase();
const SOURCES = [
  ['live', 'Live read from the inverter'],
  ['configBattery', 'DeyeCloud stored copy: battery'],
  ['configSystem', 'DeyeCloud stored copy: system'],
  ['configTou', 'DeyeCloud stored copy: time of use'],
];
const STATUS = {
  pending: ['info', 'Waiting'],
  sent: ['info', 'Sent, waiting for the inverter'],
  succeeded: ['ok', 'Confirmed'],
  accepted: ['ok', 'Accepted'],
  failed: ['err', 'Failed'],
};
const isOpen = (c) => c.status === 'pending' || c.status === 'sent';
const given = (v) => v !== undefined && v !== null && v !== '';
const onOff = (v) => (given(v) ? ['on', 'true', '1', 'enable', 'enabled'].includes(String(v).toLowerCase()) : null);

// The current value of each field, in the shape the server validates.
function currentValues(st) {
  const b = st.battery || {};
  const s = st.system || {};
  const t = st.tou || {};
  const touOn = onOff(t.touAction);
  return {
    energyPattern: s.energyPattern ?? null,
    workMode: s.systemWorkMode ?? null,
    solarSell: onOff(s.solarSellAction),
    maxSellPower: s.maxSellPower ?? null,
    maxSolarPower: s.maxSolarPower ?? null,
    zeroExportPower: s.zeroExportPower ?? null,
    battLow: b.battLowCapacity ?? null,
    maxChargeCurrent: b.maxChargeCurrent ?? null,
    maxDischargeCurrent: b.maxDischargeCurrent ?? null,
    gridChargeAmpere: b.gridChargeAmpere ?? null,
    gridCharge: onOff(b.gridChargeAction),
    genCharge: onOff(b.genChargeAction),
    touSwitch: touOn === null ? null : { on: touOn, days: touOn ? DAYS.filter((d) => (t.touDays || []).map((x) => String(x).toUpperCase()).includes(d)) : [] },
    touSlots: (t.timeUseSettingItems || []).map((x) => {
      const out = { time: String(x.time), power: Number(x.power), soc: Number(x.soc), enableGridCharge: Boolean(x.enableGridCharge), enableGeneration: Boolean(x.enableGeneration), enableSell: Boolean(x.enableSell) };
      if (given(x.voltage)) out.voltage = Number(x.voltage);
      return out;
    }),
  };
}

// A value as people read it, for the forms' "now" hints, the confirmation and the log.
function show(field, v, fields) {
  if (v === null || v === undefined) return 'unknown';
  const f = fields[field] || {};
  if (f.type === 'bool') return v ? 'On' : 'Off';
  if (f.type === 'enum') return LABELS[v] || v;
  if (f.type === 'int') return `${fmtNumber(v, 0)} ${f.unit}`;
  if (f.type === 'touSwitch') return v.on ? `On (${v.days.length === 7 ? 'every day' : v.days.map(dayShort).join(', ')})` : 'Off';
  if (f.type === 'touSlots') return v.map((x) => `${x.time} ${x.soc}%`).join(' · ');
  return JSON.stringify(v);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What differs between two sets of time-of-use slots, one line per changed slot.
function slotChanges(before, after) {
  return (after || [])
    .map((s, k) => {
      const o = (before || [])[k] || {};
      const parts = [];
      if (s.time !== o.time) parts.push(`starts ${o.time || '—'} → ${s.time}`);
      if (s.power !== o.power) parts.push(`power ${o.power ?? '—'} → ${s.power} W`);
      if (s.soc !== o.soc) parts.push(`keep SOC ${o.soc ?? '—'} → ${s.soc}%`);
      for (const [key, label] of [['enableGridCharge', 'grid charge'], ['enableGeneration', 'gen charge'], ['enableSell', 'sell']]) {
        if (Boolean(s[key]) !== Boolean(o[key])) parts.push(`${label} ${s[key] ? 'on' : 'off'}`);
      }
      return parts.length ? `Slot ${k + 1}: ${parts.join(', ')}` : '';
    })
    .filter(Boolean);
}

export async function mount(root, ctx) {
  let data = await api.get('/api/inverter');
  if (!data.inverters.length) {
    root.innerHTML = `<div class="card empty" style="padding:56px 20px">${icon('device')}<h3>No inverter found</h3>
      <p>Connect DeyeCloud in <a href="#/settings">Settings</a>; inverters appear here after the first collection.</p></div>`;
    return;
  }
  const canEdit = data.canEdit;
  const fields = data.fields;
  let sn = ctx.params.get('sn') || data.inverters[0].sn;
  if (!data.inverters.some((x) => x.sn === sn)) sn = data.inverters[0].sn;
  const dirty = new Set(); // forms with unsaved edits are not redrawn by the refresh
  let timer = null;

  const inv = () => data.inverters.find((x) => x.sn === sn);
  const disabled = canEdit ? '' : 'disabled';

  root.innerHTML = `
    <div class="stack">
      <div class="card" id="inv-head"></div>
      ${canEdit ? `<div class="alert">${icon('info')}<div class="grow small">Changes go to your inverter through DeyeCloud, one at a time; each is listed in the change log with the inverter's confirmation. Values outside what your model accepts are clamped by the inverter.</div></div>` : ''}
      <div class="grid cols-2">
        <div class="card"><div class="card-head"><h2>${icon('battery', 'style="width:16px;height:16px;vertical-align:-3px"')} Battery</h2></div><form id="f-battery" class="stack" novalidate></form></div>
        <div class="card"><div class="card-head"><h2>${icon('bolt', 'style="width:16px;height:16px;vertical-align:-3px"')} System</h2></div><form id="f-system" class="stack" novalidate></form></div>
      </div>
      <div class="card"><div class="card-head"><h2>${icon('history', 'style="width:16px;height:16px;vertical-align:-3px"')} Time of use</h2><span class="small faint" id="tou-now"></span></div><form id="f-tou" class="stack" novalidate></form></div>
      <div class="card"><div class="card-head"><h2>Change log</h2></div><div id="log"></div></div>
      <div class="card"><details id="raw"><summary class="card-head" style="cursor:pointer;margin:0"><h2>What DeyeCloud reported</h2></summary><div id="raw-body" style="margin-top:12px"></div></details></div>
    </div>`;

  // ---------- header ----------
  function renderHead() {
    const i = inv();
    const st = i.settings || {};
    const at = (k) => (st.sourceAt && st.sourceAt[k] ? fmtAgo(st.sourceAt[k]) : 'never');
    const errors = Object.entries(st.errors || {});
    const pending = st.livePending ? '<span class="badge info">Live read waiting for the inverter</span>' : '';
    const picker = data.inverters.length > 1
      ? `<select id="inv-pick" class="inline-input">${data.inverters.map((x) => `<option value="${esc(x.sn)}" ${x.sn === sn ? 'selected' : ''}>${esc(x.stationName || '')} · ${esc(x.sn)}</option>`).join('')}</select>`
      : '';
    $('#inv-head', root).innerHTML = `
      <div class="card-head"><h2>${icon('device', 'style="width:16px;height:16px;vertical-align:-3px"')} Inverter ${esc(i.sn)}</h2>${picker}
        ${canEdit ? `<button class="btn sm" id="read-now">${icon('refresh')} Read from inverter now</button>` : ''}</div>
      <div class="row small muted">
        <span>${esc(i.stationName || '')}${i.productId ? ` · ${esc(i.productId)}` : ''}</span>
        <span>Live read: <b>${esc(at('live'))}</b></span>
        <span>DeyeCloud copy: <b>${esc(at('configSystem'))}</b></span>
        ${pending}
      </div>
      ${errors.length ? `<div class="alert warn" style="margin:10px 0 0">${icon('warn')}<div class="grow small">${errors.map(([k, m]) => `<div><b>${esc((SOURCES.find((s) => s[0] === k) || [k, k])[1])}:</b> ${esc(m)}</div>`).join('')}</div></div>` : ''}
      ${!st.at ? '<p class="small faint" style="margin:10px 0 0">Not read yet. Settings are read hourly by the collector.</p>' : ''}`;
    if ($('#inv-pick', root)) {
      $('#inv-pick', root).onchange = (e) => {
        sn = e.target.value;
        dirty.clear();
        renderAll(true);
      };
    }
    if ($('#read-now', root)) $('#read-now', root).onclick = readNow;
  }

  // ---------- forms ----------
  const num = (name, v, f, hint = '') => `<label class="field"><span>${esc(f.label)} <span class="hint">${esc(f.unit)}${hint}</span></span>
      <input type="number" name="${name}" min="${f.min}" max="${f.max}" step="1" value="${given(v) ? esc(v) : ''}" placeholder="unknown" ${disabled}></label>`;
  const onOffSelect = (name, v, f) => `<label class="field">${esc(f.label)}
      <select name="${name}" ${disabled}>${v === null ? '<option value="">unknown</option>' : ''}<option value="on" ${v === true ? 'selected' : ''}>On</option><option value="off" ${v === false ? 'selected' : ''}>Off</option></select></label>`;
  const enumSelect = (name, v, f) => `<label class="field">${esc(f.label)}
      <select name="${name}" ${disabled}>${v === null ? '<option value="">unknown</option>' : ''}${f.values.map((x) => `<option value="${x}" ${v === x ? 'selected' : ''}>${esc(LABELS[x] || x)}</option>`).join('')}</select></label>`;
  const readOnly = (label, v) => `<label class="field">${esc(label)}<input type="text" value="${esc(v)}" disabled></label>`;
  const saveBtn = (label) => (canEdit ? `<div class="row"><button type="submit" class="btn primary">${icon('save')} ${esc(label)}</button><span class="small faint" data-dirty></span></div>` : '');

  function renderBattery(force) {
    if (dirty.has('battery') && !force) return;
    const cur = currentValues(inv().settings || {});
    const b = (inv().settings || {}).battery || {};
    $('#f-battery', root).innerHTML = `
      <div class="form-grid">
        ${num('battLow', cur.battLow, fields.battLow, ' · low-battery alarm')}
        ${readOnly('Shutdown (battery stops here)', given(b.battShutDownCapacity) ? `${b.battShutDownCapacity} %` : 'unknown')}
        ${readOnly('Battery capacity', given(b.battCapacity) ? `${b.battCapacity} Ah` : 'unknown')}
        ${num('maxChargeCurrent', cur.maxChargeCurrent, fields.maxChargeCurrent)}
        ${num('maxDischargeCurrent', cur.maxDischargeCurrent, fields.maxDischargeCurrent)}
        ${num('gridChargeAmpere', cur.gridChargeAmpere, fields.gridChargeAmpere)}
        ${onOffSelect('gridCharge', cur.gridCharge, fields.gridCharge)}
        ${onOffSelect('genCharge', cur.genCharge, fields.genCharge)}
      </div>
      <p class="small faint" style="margin:0">During an outage the battery runs down to Shutdown; with grid or generator power it keeps the time-of-use "Keep SOC". Batt Low only raises an alarm. Shutdown and capacity can only be changed on the inverter, and DeyeCloud doesn't report the generator charge switch until it has been set here.</p>
      ${saveBtn('Save battery settings')}`;
    dirty.delete('battery');
  }

  function renderSystem(force) {
    if (dirty.has('system') && !force) return;
    const cur = currentValues(inv().settings || {});
    $('#f-system', root).innerHTML = `
      <div class="form-grid">
        ${enumSelect('energyPattern', cur.energyPattern, fields.energyPattern)}
        ${enumSelect('workMode', cur.workMode, fields.workMode)}
        ${onOffSelect('solarSell', cur.solarSell, fields.solarSell)}
        ${num('maxSellPower', cur.maxSellPower, fields.maxSellPower)}
        ${num('maxSolarPower', cur.maxSolarPower, fields.maxSolarPower)}
        ${num('zeroExportPower', cur.zeroExportPower, fields.zeroExportPower)}
      </div>
      <p class="small faint" style="margin:0">Battery first: solar charges the battery before covering the home. Load first: solar covers the home first.</p>
      ${saveBtn('Save system settings')}`;
    dirty.delete('system');
  }

  function renderTou(force) {
    if (dirty.has('tou') && !force) return;
    const i = inv();
    const cur = currentValues(i.settings || {});
    const sw = cur.touSwitch;
    const slots = cur.touSlots.length === 6 ? cur.touSlots : Array.from({ length: 6 }, (_, k) => cur.touSlots[k] || { time: '', power: 0, soc: 30, enableGridCharge: false, enableGeneration: false, enableSell: false });
    const now = touSlot({ touAction: 'on', timeUseSettingItems: slots }, Date.now(), i.timezone);
    $('#tou-now', root).textContent = now && sw && sw.on ? `Now in the ${now.from}–${now.to} slot · keeps ${now.soc}%` : '';
    const box = (k, name, v) => `<input type="checkbox" name="${name}${k}" ${v ? 'checked' : ''} ${disabled}>`;
    $('#f-tou', root).innerHTML = `
      <div class="row">
        <label class="field" style="min-width:140px">Time of use
          <select name="touOn" ${disabled}>${sw === null ? '<option value="">unknown</option>' : ''}<option value="on" ${sw && sw.on ? 'selected' : ''}>On</option><option value="off" ${sw && !sw.on ? 'selected' : ''}>Off</option></select></label>
        <div class="tou-days">${DAYS.map((d) => `<label class="check small"><input type="checkbox" name="day_${d}" ${sw && sw.days.includes(d) ? 'checked' : ''} ${disabled}> ${dayShort(d)}</label>`).join('')}</div>
      </div>
      <div class="table-wrap"><table class="table tou-table">
        <thead><tr><th>Slot</th><th>From</th><th>Until</th><th class="num">Power (W)</th><th class="num">Keep SOC (%)</th><th>Grid charge</th><th>Gen charge</th><th>Sell</th></tr></thead>
        <tbody>${slots.map((x, k) => `<tr class="${now && sw && sw.on && now.from === x.time ? 'tou-now' : ''}" data-voltage="${given(x.voltage) ? esc(x.voltage) : ''}">
          <td>${k + 1}</td>
          <td><input type="time" name="time${k}" step="300" value="${esc(x.time)}" ${disabled}></td>
          <td class="faint">${esc(slots[(k + 1) % 6].time)}</td>
          <td class="num"><input type="number" name="power${k}" min="0" max="100000" step="100" value="${esc(x.power)}" ${disabled}></td>
          <td class="num"><input type="number" name="soc${k}" min="5" max="100" step="1" value="${esc(x.soc)}" ${disabled}></td>
          <td>${box(k, 'grid', x.enableGridCharge)}</td><td>${box(k, 'gen', x.enableGeneration)}</td><td>${box(k, 'sell', x.enableSell)}</td>
        </tr>`).join('')}</tbody></table></div>
      <p class="small faint" style="margin:0">Each slot runs from its start time to the next slot's. "Keep SOC" is the charge the battery holds while the grid or generator can take over; with Grid or Gen charge ticked it also charges up to it. Start times go in 5-minute steps.</p>
      ${saveBtn('Save time of use')}`;
    dirty.delete('tou');
  }

  // Reads a form into { field: value } for the fields that differ from the current settings.
  function changesFrom(form, names) {
    const cur = currentValues(inv().settings || {});
    const out = {};
    for (const name of names) {
      const f = fields[name];
      const el = form.elements[name];
      if (!el || el.value === '') continue;
      const v = f.type === 'int' ? Number(el.value) : f.type === 'bool' ? el.value === 'on' : el.value;
      if (!same(v, cur[name])) out[name] = v;
    }
    return out;
  }

  function touChanges(form) {
    const cur = currentValues(inv().settings || {});
    const out = {};
    if (form.elements.touOn.value !== '') {
      const sw = { on: form.elements.touOn.value === 'on', days: form.elements.touOn.value === 'on' ? DAYS.filter((d) => form.elements[`day_${d}`].checked) : [] };
      if (!same(sw, cur.touSwitch)) out.touSwitch = sw;
    }
    const rows = $$('.tou-table tbody tr', form);
    const slots = rows.map((tr, k) => {
      const s = {
        time: form.elements[`time${k}`].value,
        power: Number(form.elements[`power${k}`].value),
        soc: Number(form.elements[`soc${k}`].value),
        enableGridCharge: form.elements[`grid${k}`].checked,
        enableGeneration: form.elements[`gen${k}`].checked,
        enableSell: form.elements[`sell${k}`].checked,
      };
      if (tr.dataset.voltage !== '') s.voltage = Number(tr.dataset.voltage);
      return s;
    });
    if (!same(slots, cur.touSlots)) out.touSlots = slots;
    return out;
  }

  // Confirmation listing old → new, then queue the changes.
  async function submit(changes) {
    const names = Object.keys(changes);
    if (!names.length) return toast('Nothing has changed', 'info');
    const cur = currentValues(inv().settings || {});
    const rows = names.map((n) => {
      if (n === 'touSlots') {
        return `<li><b>${esc(fields.touSlots.label)}</b><ul>${slotChanges(cur.touSlots, changes.touSlots).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></li>`;
      }
      return `<li><b>${esc(fields[n].label)}:</b> ${esc(show(n, cur[n], fields))} → <b>${esc(show(n, changes[n], fields))}</b></li>`;
    });
    const ok = await modal({
      title: 'Change inverter settings?',
      submitLabel: `Send ${names.length} change${names.length > 1 ? 's' : ''}`,
      body: `<p class="muted" style="margin:0">These go to inverter ${esc(sn)} now, one at a time:</p><ul class="change-list">${rows.join('')}</ul>`,
    });
    if (!ok) return;
    try {
      const r = await api.post(`/api/inverter/${encodeURIComponent(sn)}/changes`, { changes });
      toast(r.queued ? `${r.queued} change${r.queued > 1 ? 's' : ''} sent to the inverter` : 'Nothing to change', 'ok');
      dirty.clear();
      await refresh(true);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function bindForms() {
    if (!canEdit) return;
    for (const [id, key] of [['#f-battery', 'battery'], ['#f-system', 'system'], ['#f-tou', 'tou']]) {
      const form = $(id, root);
      form.oninput = () => {
        dirty.add(key);
        const hint = $('[data-dirty]', form);
        if (hint) hint.textContent = 'Unsaved changes';
      };
    }
    $('#f-battery', root).onsubmit = (e) => {
      e.preventDefault();
      submit(changesFrom(e.target, ['battLow', 'maxChargeCurrent', 'maxDischargeCurrent', 'gridChargeAmpere', 'gridCharge', 'genCharge']));
    };
    $('#f-system', root).onsubmit = (e) => {
      e.preventDefault();
      submit(changesFrom(e.target, ['energyPattern', 'workMode', 'solarSell', 'maxSellPower', 'maxSolarPower', 'zeroExportPower']));
    };
    $('#f-tou', root).onsubmit = (e) => {
      e.preventDefault();
      submit(touChanges(e.target));
    };
  }

  // ---------- log and raw answers ----------
  function renderLog() {
    const cmds = inv().commands;
    $('#log', root).innerHTML = cmds.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>By</th><th>Setting</th><th>Change</th><th>Status</th></tr></thead><tbody>
        ${cmds.map((c) => {
          const [cls, label] = STATUS[c.status] || ['', c.status];
          return `<tr><td class="nowrap">${esc(fmtTime(c.createdTs, { dateStyle: 'short', timeStyle: 'short' }))}</td><td>${esc(c.user || '')}</td><td>${esc(c.label)}</td>
            <td>${c.field === 'touSlots' && c.oldValue ? esc(slotChanges(c.oldValue, c.newValue).join('; ') || 'no change') : `${esc(show(c.field, c.oldValue, fields))} → <b>${esc(show(c.field, c.newValue, fields))}</b>`}</td>
            <td><span class="badge ${cls}">${esc(label)}</span>${c.message ? `<div class="small faint">${esc(c.message)}</div>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`
      : '<p class="small faint">No changes made from this app yet.</p>';
  }

  function renderRaw() {
    const st = inv().settings || {};
    $('#raw-body', root).innerHTML = `<p class="small faint" style="margin-top:0">The live read asks the inverter itself; the stored copy is what DeyeCloud last saved, which can lag. Where both report a setting, the live read wins.</p>
      ${SOURCES.map(([k, label]) => `<div class="raw-src"><div class="row small"><b>${esc(label)}</b><span class="faint">${st.sourceAt && st.sourceAt[k] ? esc(fmtTime(st.sourceAt[k])) : 'not read'}</span>
        ${st.errors && st.errors[k] ? `<span class="badge err">${esc(st.errors[k])}</span>` : ''}</div>
        <pre class="raw-json">${esc(st.sources && st.sources[k] ? JSON.stringify(st.sources[k], null, 2) : '—')}</pre></div>`).join('')}`;
  }

  function renderAll(force) {
    renderHead();
    renderBattery(force);
    renderSystem(force);
    renderTou(force);
    renderLog();
    renderRaw();
    bindForms();
  }

  // While changes are on their way, refresh every few seconds (forms with edits are left alone).
  async function refresh(force) {
    data = await api.get('/api/inverter');
    if (!inv()) sn = data.inverters[0].sn;
    renderAll(force);
    clearTimeout(timer);
    if (inv().commands.some(isOpen) || (inv().settings && inv().settings.livePending)) timer = setTimeout(() => refresh(false).catch(() => {}), 3000);
  }

  async function readNow(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner sm"></span> Reading…';
    try {
      await api.post(`/api/inverter/${encodeURIComponent(sn)}/read`);
      dirty.clear();
      await refresh(true);
      toast('Settings read from the inverter', 'ok');
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.innerHTML = `${icon('refresh')} Read from inverter now`;
    }
  }

  await refresh(true);
  return () => clearTimeout(timer);
}
