import { api } from '../api.js';
import { $, $$, esc, icon, toast, fmtNumber, fmtAgo, fmtTime, slotColor } from '../util.js';
import { createTimeChart, createBarChart } from '../charts.js';

// Smart devices from eWeLink: every device with its switches and readings, and for each device its
// settings, a timeline of when it was on, charts of its readings and a log of who switched it.

const KIND_ICONS = { light: 'bulb', fan: 'fan', thermostat: 'thermo', sensor: 'sensor', meter: 'plug', switch: 'power' };
const RANGES = [
  ['1d', 'Last 24 h', 86400],
  ['7d', '7 days', 7 * 86400],
  ['30d', '30 days', 30 * 86400],
];
const STATE_WORDS = {
  on: 'on',
  off: 'off',
  online: 'came online',
  offline: 'went offline',
  open: 'opened',
  closed: 'closed',
  detected: 'detected motion',
  clear: 'clear',
  leak: 'detected water',
  dry: 'dry',
  smoke: 'detected smoke',
};
const ACTIVE = new Set(['on', 'online', 'open', 'detected', 'leak', 'smoke']);

const val = (r) => (r.kind === 'text' ? r.value : `${fmtNumber(r.value, r.unit === 'kWh' ? 2 : undefined)}${r.unit ? ` ${r.unit}` : ''}`);

function duration(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** The two or three readings worth showing on a device card. */
function keyReadings(d) {
  const order = ['power', 'temperature', 'humidity', 'door', 'motion', 'water', 'smoke', 'voltage', 'current', 'dayKwh', 'brightness', 'battery'];
  const list = d.readings.filter((r) => order.includes(r.key) || /^power_\d/.test(r.key));
  list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return list.slice(0, 3);
}

function toggle(on, attrs, disabled) {
  return `<button type="button" class="toggle ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" ${attrs} ${disabled ? 'disabled' : ''}><span></span></button>`;
}

function statusLine(s) {
  if (!s.connected) return '';
  const live = s.live || {};
  const liveText = live.up ? `<span class="badge ok">Live</span>` : s.liveEnabled ? `<span class="badge warn" title="${esc(live.error || '')}">Live connection ${live.state === 'waiting' ? 'retrying' : 'off'}</span>` : '';
  const sync = s.lastSyncTs ? `synced ${fmtAgo(s.lastSyncTs)}` : 'not synced yet';
  return `${liveText}<span class="small faint">${esc(sync)} · ${live.up ? `full sync every ${s.liveSyncMinutes} min` : `polling every ${s.pollMinutes} min`}</span>`;
}

export async function mount(root, ctx) {
  const id = ctx.params.get('id');
  return id ? mountDevice(root, ctx, id) : mountList(root, ctx);
}

// ---------- the device list ----------

async function mountList(root, ctx) {
  let data = await api.get('/api/ewelink/devices');
  const s = data.status;
  if (!s.connected) {
    root.innerHTML = `<div class="card empty" style="padding:56px 20px">${icon('bulb')}<h3>Connect eWeLink to control your smart devices</h3>
      <p>Sonoff and other eWeLink devices appear here once your eWeLink account is connected. Then you can switch them,
      see their history and drive them from <a href="#/automations">Automations</a> based on what your inverter is doing.</p>
      ${ctx.user.isAdmin ? `<div class="row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="#/settings?section=ewelink">${icon('settings')} Set up eWeLink</a></div>` : '<p class="small faint">Ask an admin to connect it in Settings.</p>'}</div>`;
    return;
  }
  const canControl = data.canControl;
  let room = '';
  try {
    room = localStorage.getItem('deye-smart-room') || '';
  } catch {}
  let showHidden = false;
  const busy = new Set();

  ctx.actions.innerHTML = `${canControl ? `<button class="btn sm" id="sync">${icon('refresh')} Sync</button>` : ''}`;
  root.innerHTML = `
    <div class="stack">
      ${s.reconnectNeeded ? `<div class="alert err">${icon('warn')}<div class="grow"><b>eWeLink no longer accepts the dashboard's sign-in.</b> Devices can't be controlled and automations can't switch them until the account is reconnected${ctx.user.isAdmin ? ' in <a href="#/settings?section=ewelink">Settings</a>' : ' by an admin'}.</div></div>` : ''}
      <div class="row" id="list-head"></div>
      <div class="smart-grid" id="cards"></div>
      <div class="card">
        <div class="card-head"><h2>${icon('history', 'style="width:16px;height:16px;vertical-align:-3px"')} Recent activity</h2><a class="small" href="#/automations">Automations →</a></div>
        <div id="activity"></div>
      </div>
    </div>`;

  function render() {
    const rooms = [...new Set(data.devices.map((d) => d.room).filter(Boolean))].sort();
    if (room && !rooms.includes(room)) room = '';
    const hiddenCount = data.devices.filter((d) => d.hidden).length;
    $('#list-head', root).innerHTML = `
      <div class="chips">${['', ...rooms].map((r) => `<button class="chip ${r === room ? 'active' : ''}" data-room="${esc(r)}">${esc(r || 'All rooms')}</button>`).join('')}</div>
      <span class="spacer"></span>
      ${hiddenCount ? `<label class="check small"><input type="checkbox" id="show-hidden" ${showHidden ? 'checked' : ''}> Show ${hiddenCount} hidden</label>` : ''}
      ${statusLine(data.status)}`;
    const list = data.devices.filter((d) => (!room || d.room === room) && (showHidden || !d.hidden));
    $('#cards', root).innerHTML = list.length
      ? list.map(card).join('')
      : `<div class="card empty">${icon('bulb')}<h3>No devices</h3><p>${data.devices.length ? 'None in this room.' : 'Your eWeLink account has no devices this App ID can see.'}</p></div>`;
    if (data.status.totalOnAccount && data.status.totalOnAccount > data.devices.length) {
      $('#cards', root).insertAdjacentHTML(
        'beforeend',
        `<div class="alert small" style="grid-column:1/-1">${icon('info')}<div class="grow">eWeLink reports ${data.status.totalOnAccount} devices on the account; ${data.devices.length} are shown. Free eWeLink App IDs only see Sonoff and other authorised brands.</div></div>`
      );
    }
  }

  function card(d) {
    const off = d.online === false;
    const chs = d.channels;
    const dis = !canControl || off || busy.has(d.id);
    let controls = '';
    if (chs.length === 1) {
      const on = chs[0].state === 'on';
      controls = `<button type="button" class="power-btn ${on ? 'on' : ''}" data-dev="${esc(d.id)}" data-ch="0" ${dis ? 'disabled' : ''} title="${on ? 'Turn off' : 'Turn on'}" aria-pressed="${on}">${busy.has(d.id) ? '<span class="spinner sm"></span>' : icon('power')}</button>`;
    } else if (chs.length > 1) {
      controls = `<div class="ch-list">${chs
        .map((c) => `<div class="ch-row"><span class="ch-name">${esc(c.name)}</span>${toggle(c.state === 'on', `data-dev="${esc(d.id)}" data-ch="${c.index}"`, dis)}</div>`)
        .join('')}
        ${canControl ? `<div class="row ch-all"><button class="btn sm ghost" data-dev="${esc(d.id)}" data-all="on" ${dis ? 'disabled' : ''}>All on</button><button class="btn sm ghost" data-dev="${esc(d.id)}" data-all="off" ${dis ? 'disabled' : ''}>All off</button></div>` : ''}</div>`;
    }
    const readings = keyReadings(d);
    const anyOn = chs.some((c) => c.state === 'on');
    return `<div class="card smart-card ${off ? 'offline' : ''} ${anyOn ? 'is-on' : ''}" data-open="${esc(d.id)}">
      <div class="sc-top">
        <span class="sc-icon kind-${esc(d.kind)}">${icon(KIND_ICONS[d.kind] || 'power')}</span>
        <div class="sc-title"><div class="sc-name">${esc(d.name)}</div>
          <div class="small faint">${esc([d.room, d.shared ? 'shared with you' : null, d.hidden ? 'hidden' : null].filter(Boolean).join(' · ') || d.kindLabel)}</div></div>
        <span class="dot ${off ? 'err' : d.online ? 'ok' : ''}" title="${off ? 'Offline' : d.online ? 'Online' : 'Unknown'}"></span>
      </div>
      ${readings.length ? `<div class="sc-readings">${readings.map((r) => `<span><b>${esc(val(r))}</b> <small>${esc(r.label.toLowerCase())}</small></span>`).join('')}</div>` : ''}
      ${off ? `<div class="small faint">Offline${d.updatedTs ? ` · last seen ${esc(fmtAgo(d.updatedTs))}` : ''}</div>` : ''}
      ${controls ? `<div class="sc-controls">${controls}</div>` : ''}
    </div>`;
  }

  async function renderActivity() {
    const { actions } = await api.get('/api/ewelink/actions', { limit: 30 });
    $('#activity', root).innerHTML = actions.length ? activityTable(actions, true) : '<div class="empty small">Nothing switched from this dashboard yet.</div>';
  }

  async function switchDevice(devId, body) {
    busy.add(devId);
    render();
    try {
      const r = await api.post(`/api/ewelink/devices/${encodeURIComponent(devId)}/switch`, body);
      const i = data.devices.findIndex((x) => x.id === devId);
      if (i >= 0) data.devices[i] = r.device;
      if (!r.ok) toast(`${r.device.name}: ${r.message}`, 'err');
      renderActivity().catch(() => {});
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      busy.delete(devId);
      render();
    }
  }

  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-room]');
    if (chip) {
      room = chip.dataset.room;
      try {
        localStorage.setItem('deye-smart-room', room);
      } catch {}
      return render();
    }
    const sw = e.target.closest('[data-dev][data-ch]');
    if (sw) return switchDevice(sw.dataset.dev, { channel: Number(sw.dataset.ch), state: 'toggle' });
    const all = e.target.closest('[data-dev][data-all]');
    if (all) return switchDevice(all.dataset.dev, { channel: null, state: all.dataset.all });
    if (e.target.closest('button, a, input, label')) return;
    const open = e.target.closest('[data-open]');
    if (open) ctx.navigate('smart', { id: open.dataset.open });
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'show-hidden') {
      showHidden = e.target.checked;
      render();
    }
  });
  const syncBtn = $('#sync');
  if (syncBtn) {
    syncBtn.onclick = async () => {
      syncBtn.disabled = true;
      try {
        const r = await api.post('/api/ewelink/sync');
        toast(r.message, 'ok');
        data = await api.get('/api/ewelink/devices');
        render();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        syncBtn.disabled = false;
      }
    };
  }

  render();
  renderActivity().catch(() => {});
  const timer = setInterval(async () => {
    if (busy.size) return;
    try {
      data = await api.get('/api/ewelink/devices');
      render();
    } catch {}
  }, 10000);
  return () => clearInterval(timer);
}

function activityTable(actions, withDevice) {
  return `<div class="table-wrap" style="max-height:380px"><table class="table">
    <thead><tr><th>When</th>${withDevice ? '<th>Device</th>' : ''}<th>What</th><th>Who</th><th>Result</th></tr></thead>
    <tbody>${actions
      .map(
        (a) => `<tr><td class="nowrap small" title="${esc(fmtTime(a.ts))}">${esc(fmtAgo(a.ts))}</td>
        ${withDevice ? `<td><a href="#/smart?id=${encodeURIComponent(a.deviceId)}">${esc(a.device)}</a></td>` : ''}
        <td>${esc(a.summary)}</td>
        <td class="small">${a.automation ? `${icon('zap', 'style="width:12px;height:12px;vertical-align:-1px"')} <a href="#/automations">${esc(a.automation)}</a>` : esc(a.user || a.source)}</td>
        <td>${a.status === 'ok' ? '<span class="badge ok">Done</span>' : `<span class="badge err" title="${esc(a.message || '')}">Failed</span> <span class="small faint">${esc(a.message || '')}</span>`}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
}

// ---------- one device ----------

async function mountDevice(root, ctx, id) {
  let { device: d, canControl } = await api.get(`/api/ewelink/devices/${encodeURIComponent(id)}`);
  const st = { range: '1d', hist: null, cloud: null, selected: null, busy: false };
  try {
    st.range = localStorage.getItem('deye-smart-range') || '1d';
  } catch {}
  ctx.setTitle(d.name);
  document.title = `${d.name} · Deye Monitor`;
  ctx.actions.innerHTML = `<a class="btn sm ghost" href="#/smart">← All devices</a>`;

  root.innerHTML = `
    <div class="stack">
      <div class="card" id="head"></div>
      <div class="grid cols-2">
        <div class="card"><div class="card-head"><h2>${icon('sliders', 'style="width:16px;height:16px;vertical-align:-3px"')} Controls</h2></div><div id="controls"></div></div>
        <div class="card"><div class="card-head"><h2>Now</h2><span class="small faint" id="updated"></span></div><div id="now"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>${icon('history', 'style="width:16px;height:16px;vertical-align:-3px"')} History</h2>
          <div class="seg sm" id="ranges">${RANGES.map(([k, l]) => `<button data-v="${k}">${esc(l)}</button>`).join('')}</div></div>
        <div id="timeline"></div>
        <div class="row" style="margin:6px 0 8px"><div class="series-pills" id="pills"></div><span class="spacer"></span><a class="btn sm" id="open-charts" href="#/charts">${icon('chart')} Open in Charts</a></div>
        <div class="chart" id="chart"></div>
        <div id="no-readings" class="hidden small faint">This device reports no numeric readings.</div>
      </div>
      <div class="card hidden" id="energy-card"><div class="card-head"><h2>${icon('energy', 'style="width:16px;height:16px;vertical-align:-3px"')} Daily energy (last 100 days, from the device)</h2>
        ${canControl ? `<button class="btn sm" id="energy-get">${icon('download')} Get from device</button>` : ''}</div><div class="chart short" id="energy-chart"></div><div id="energy-empty" class="small faint"></div></div>
      <div class="card"><div class="card-head"><h2>Events</h2><span class="small faint">State changes recorded here and commands sent from this dashboard</span></div><div id="events"></div></div>
      <div class="card"><div class="card-head"><h2>eWeLink's own log</h2><button class="btn sm" id="cloud-btn">${icon('download')} Load from eWeLink</button></div>
        <p class="small faint" id="cloud-note">The last 30 operations eWeLink recorded, including those from the eWeLink app and the device itself. Loading uses one eWeLink API call.</p><div id="cloud"></div></div>
      <div class="card"><details id="raw"><summary class="card-head" style="cursor:pointer;margin:0"><h2>Everything eWeLink reports</h2></summary><div id="raw-body" style="margin-top:12px"></div></details></div>
    </div>`;

  const chart = createTimeChart($('#chart', root), { type: 'line', noSlider: false });
  let energyChart = null;

  function renderHead() {
    const facts = [
      d.kindLabel,
      d.model ? `${d.brand ? `${d.brand} ` : ''}${d.model}` : null,
      d.room,
      d.shared ? `shared with you${d.sharedBy && d.sharedBy.nickname ? ` by ${d.sharedBy.nickname}` : ''}` : null,
    ].filter(Boolean);
    const rssi = d.readings.find((r) => r.key === 'rssi');
    $('#head', root).innerHTML = `
      <div class="card-head"><span class="sc-icon kind-${esc(d.kind)}">${icon(KIND_ICONS[d.kind] || 'power')}</span><h2>${esc(d.name)}</h2>
        ${d.online === false ? '<span class="badge err">Offline</span>' : d.online ? '<span class="badge ok">Online</span>' : ''}
        ${canControl ? `<label class="check small"><input type="checkbox" id="hide" ${d.hidden ? 'checked' : ''}> Hide from the device list</label>` : ''}</div>
      <div class="row small muted">${facts.map((f) => `<span>${esc(f)}</span>`).join('<span class="faint">·</span>')}</div>
      <dl class="kv" style="margin-top:12px">
        <dt>Device ID</dt><dd class="mono">${esc(d.id)}</dd>
        <dt>Type</dt><dd>UIID ${esc(d.uiid ?? '—')}</dd>
        ${d.firmware ? `<dt>Firmware</dt><dd>${esc(d.firmware)}</dd>` : ''}
        ${rssi ? `<dt>Wi-Fi signal</dt><dd>${esc(fmtNumber(rssi.value, 0))} dBm</dd>` : ''}
        ${d.mac ? `<dt>MAC</dt><dd class="mono">${esc(d.mac)}</dd>` : ''}
        ${d.timers ? `<dt>Timers on the device</dt><dd>${d.timers} (set in the eWeLink app)</dd>` : ''}
        <dt>Last update</dt><dd>${d.updatedTs ? esc(`${fmtTime(d.updatedTs)} (${fmtAgo(d.updatedTs)})`) : '—'}</dd>
      </dl>`;
    const hide = $('#hide', root);
    if (hide) {
      hide.onchange = async () => {
        await api.put(`/api/ewelink/devices/${encodeURIComponent(d.id)}`, { hidden: hide.checked });
        toast(hide.checked ? 'Hidden from the device list' : 'Shown in the device list', 'ok');
      };
    }
  }

  function renderControls() {
    const dis = !canControl || d.online === false || st.busy;
    const c = d.controls;
    const parts = [];
    if (d.channels.length) {
      parts.push(`<div class="ch-list big">${d.channels
        .map((ch) => `<div class="ch-row"><span class="ch-name">${esc(ch.name)}</span><span class="small faint">${ch.state ? esc(ch.state) : 'unknown'}</span>${toggle(ch.state === 'on', `data-ch="${ch.index}"`, dis)}</div>`)
        .join('')}</div>`);
      if (d.channels.length > 1 && canControl) parts.push(`<div class="row"><button class="btn sm" data-all="on" ${dis ? 'disabled' : ''}>All on</button><button class="btn sm" data-all="off" ${dis ? 'disabled' : ''}>All off</button></div>`);
    }
    if (c.brightness) {
      parts.push(`<label class="field">Brightness <span class="hint" id="br-val">${c.brightness.value}%</span>
        <input type="range" id="brightness" min="${c.brightness.min}" max="${c.brightness.max}" value="${c.brightness.value}" ${dis ? 'disabled' : ''}></label>`);
    }
    if (c.startup) {
      const names = c.startup.perChannel ? d.channels.map((ch) => ch.name) : ['Power-on state'];
      parts.push(`<div class="form-grid">${c.startup.values
        .map((v, i) => `<label class="field">${esc(c.startup.perChannel ? `Power-on: ${names[i] || `channel ${i + 1}`}` : 'Power-on state')}
          <select data-startup="${i}" ${dis ? 'disabled' : ''}>${[['off', 'Off'], ['on', 'On'], ['stay', 'As before the power cut']].map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`)
        .join('')}</div>`);
    }
    if (c.inching) {
      const names = c.inching.perChannel ? d.channels.map((ch) => ch.name) : [''];
      parts.push(`<div class="stack" style="gap:8px">${c.inching.values
        .map((v, i) => (v ? `<div class="row small"><label class="check"><input type="checkbox" data-inch="${i}" ${v.on ? 'checked' : ''} ${dis ? 'disabled' : ''}> Inching${names[i] ? ` (${esc(names[i])})` : ''}: turn off again after</label>
          <input type="number" class="inline-input" style="width:90px" min="0.5" max="3600" step="0.5" data-inch-s="${i}" value="${v.ms / 1000}" ${dis ? 'disabled' : ''}> s</div>` : ''))
        .join('')}</div>`);
    }
    if (c.led) {
      parts.push(`<label class="check small"><input type="checkbox" id="led" ${c.led === 'on' ? 'checked' : ''} ${dis ? 'disabled' : ''}> Network indicator light on</label>`);
    }
    if (canControl) {
      parts.push(`<details class="small"><summary style="cursor:pointer" class="muted">Send other settings (advanced)</summary>
        <p class="faint" style="margin:8px 0">Params as in eWeLink's device protocol, e.g. <code>{"switch":"on"}</code>. Sent exactly as written.</p>
        <textarea id="raw-params" rows="3" class="mono" placeholder='{"switch":"on"}'></textarea>
        <div class="row" style="margin-top:8px"><button class="btn sm" id="send-raw" ${dis ? 'disabled' : ''}>Send</button></div></details>`);
    }
    if (!canControl) parts.push('<p class="small faint">Only admins can control devices.</p>');
    else if (d.online === false) parts.push('<p class="small faint">The device is offline; commands would fail.</p>');
    $('#controls', root).innerHTML = parts.join('') || '<p class="small faint">This device has nothing to control.</p>';
  }

  function renderNow() {
    const list = d.readings.filter((r) => r.key !== 'rssi');
    $('#now', root).innerHTML = list.length
      ? `<div class="grid readings-grid">${list.map((r) => `<div class="reading"><div class="small muted">${esc(r.label)}</div><div class="reading-value">${esc(val(r))}</div></div>`).join('')}</div>`
      : '<p class="small faint">No readings from this device.</p>';
    $('#updated', root).textContent = d.updatedTs ? `Updated ${fmtAgo(d.updatedTs)}` : '';
  }

  function renderRaw() {
    $('#raw-body', root).innerHTML = `<pre class="raw-json">${esc(JSON.stringify(d.params, null, 2))}</pre>`;
  }

  async function send(url, body) {
    st.busy = true;
    renderControls();
    try {
      const r = await api.post(url, body);
      if (r.device) d = { ...d, ...r.device };
      if (r.ok === false) toast(r.message, 'err');
      else if (r.summary) toast(r.summary, 'ok');
      renderAll();
      loadHistory().catch(() => {});
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      st.busy = false;
      renderControls();
    }
  }
  const base = `/api/ewelink/devices/${encodeURIComponent(d.id)}`;

  $('#controls', root).addEventListener('click', (e) => {
    const sw = e.target.closest('[data-ch]');
    if (sw) return send(`${base}/switch`, { channel: Number(sw.dataset.ch), state: 'toggle' });
    const all = e.target.closest('[data-all]');
    if (all) return send(`${base}/switch`, { channel: null, state: all.dataset.all });
    if (e.target.id === 'send-raw') {
      let params;
      try {
        params = JSON.parse($('#raw-params', root).value);
      } catch {
        return toast('That is not valid JSON', 'err');
      }
      return send(`${base}/params`, { params });
    }
  });
  $('#controls', root).addEventListener('input', (e) => {
    if (e.target.id === 'brightness') $('#br-val', root).textContent = `${e.target.value}%`;
  });
  $('#controls', root).addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'brightness') return send(`${base}/setting`, { setting: 'brightness', value: Number(t.value) });
    if (t.dataset.startup !== undefined) return send(`${base}/setting`, { setting: 'startup', value: t.value, channel: d.controls.startup.perChannel ? Number(t.dataset.startup) : null });
    const inch = t.dataset.inch ?? t.dataset.inchS;
    if (inch !== undefined) {
      const i = Number(inch);
      const on = $(`[data-inch="${i}"]`, root).checked;
      const ms = Math.round(Number($(`[data-inch-s="${i}"]`, root).value) * 1000);
      return send(`${base}/setting`, { setting: 'inching', value: { on, ms }, channel: d.controls.inching.perChannel ? i : null });
    }
    if (t.id === 'led') return send(`${base}/setting`, { setting: 'led', value: t.checked ? 'on' : 'off' });
  });

  // ---------- history ----------
  function rangeBounds() {
    const span = (RANGES.find((r) => r[0] === st.range) || RANGES[0])[2];
    const to = Math.floor(Date.now() / 1000);
    return { from: to - span, to };
  }

  function segmentsFor(metric, from, to) {
    const evs = st.hist.events.filter((e) => e.metricId === metric.id).sort((a, b) => a.ts - b.ts);
    const init = st.hist.initial.find((e) => e.metricId === metric.id);
    let cur = init ? init.value : null;
    let t = from;
    const segs = [];
    for (const e of evs) {
      if (cur !== null) segs.push({ from: t, to: e.ts, value: cur });
      cur = e.value;
      t = Math.max(from, e.ts);
    }
    if (cur !== null) segs.push({ from: t, to, value: cur });
    return segs.filter((s) => s.to > s.from);
  }

  function renderTimeline() {
    const { from, to } = st.bounds;
    const rows = st.hist.metrics.filter((m) => m.kind === 'text').sort((a, b) => (a.key === 'online') - (b.key === 'online') || a.key.localeCompare(b.key));
    if (!rows.length) {
      $('#timeline', root).innerHTML = '';
      return;
    }
    const span = to - from;
    const ticks = [];
    const step = span <= 86400 ? 6 * 3600 : span <= 7 * 86400 ? 86400 : 5 * 86400;
    for (let t = Math.ceil(from / step) * step; t < to; t += step) ticks.push(t);
    $('#timeline', root).innerHTML = `<div class="timeline">${rows
      .map((m) => {
        const segs = segmentsFor(m, from, to);
        const onSec = segs.filter((s) => ACTIVE.has(s.value)).reduce((a, s) => a + (s.to - s.from), 0);
        const label = m.key === 'online' ? 'Connection' : m.label;
        const summary = m.key === 'online' ? `${duration(segs.filter((s) => s.value === 'offline').reduce((a, s) => a + (s.to - s.from), 0))} offline` : /^switch/.test(m.key) ? `on ${duration(onSec)}` : `${segs.filter((s) => ACTIVE.has(s.value)).length}× ${STATE_WORDS[[...ACTIVE].find((v) => segs.some((s) => s.value === v))] || ''}`;
        return `<div class="tl-row"><div class="tl-label"><b>${esc(label)}</b><span class="small faint">${esc(summary)}</span></div>
          <div class="tl-track">${segs
            .map((s) => `<i class="tl-seg ${ACTIVE.has(s.value) ? `act ${m.key === 'online' ? 'ok' : /^switch/.test(m.key) ? '' : 'warn'}` : m.key === 'online' && s.value === 'offline' ? 'bad' : ''}" style="left:${((s.from - from) / span) * 100}%;width:${Math.max(0.2, ((s.to - s.from) / span) * 100)}%" title="${esc(`${label}: ${s.value} · ${fmtTime(s.from)} – ${fmtTime(s.to)} (${duration(s.to - s.from)})`)}"></i>`)
            .join('')}</div></div>`;
      })
      .join('')}
      <div class="tl-row tl-axis"><div></div><div class="tl-track">${ticks
        .map((t) => `<span style="left:${((t - from) / span) * 100}%">${esc(new Date(t * 1000).toLocaleString(undefined, span <= 86400 ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }))}</span>`)
        .join('')}</div></div></div>`;
  }

  function renderPills() {
    const nums = st.hist.metrics.filter((m) => m.kind === 'number');
    $('#pills', root).innerHTML = nums
      .map((m, i) => `<span class="series-pill ${st.selected.has(m.id) ? '' : 'off'}" data-metric="${m.id}"><span class="swatch" style="background:${slotColor(i)}"></span>${esc(m.label)}${m.unit ? ` (${esc(m.unit)})` : ''}</span>`)
      .join('');
    $('#open-charts', root).href = `#/charts?m=${[...st.selected].join(',')}&r=${st.range === '1d' ? '24h' : st.range}`;
  }

  async function loadChart() {
    const nums = st.hist.metrics.filter((m) => m.kind === 'number');
    $('#no-readings', root).classList.toggle('hidden', nums.length > 0);
    $('#chart', root).classList.toggle('hidden', !nums.length);
    if (!nums.length) return;
    const ids = nums.filter((m) => st.selected.has(m.id)).map((m) => m.id);
    if (!ids.length) return chart.setData([]);
    const res = await api.get('/api/series', { metrics: ids.join(','), from: st.bounds.from, to: st.bounds.to, bucket: 'auto', tz: new Date().getTimezoneOffset() });
    const byUnit = new Map();
    for (const s of res.series) {
      const i = nums.findIndex((m) => m.id === s.metric.id);
      const unit = s.metric.unit || '';
      if (!byUnit.has(unit)) byUnit.set(unit, { title: `${s.metric.label}${unit ? ` (${unit})` : ''}`, unit, series: [] });
      const p = byUnit.get(unit);
      if (p.series.length) p.title = unit ? `${unit}` : 'Value';
      p.series.push({ id: s.metric.id, name: s.metric.label, unit, color: slotColor(i), data: s.points });
    }
    chart.setData([...byUnit.values()], { keepZoom: true });
  }

  function renderEvents() {
    const metrics = new Map(st.hist.metrics.map((m) => [m.id, m]));
    const actions = st.hist.actions;
    const firstOf = new Map();
    for (const e of [...st.hist.events].sort((a, b) => a.ts - b.ts)) if (!firstOf.has(e.metricId)) firstOf.set(e.metricId, e.ts);
    const items = st.hist.events
      .map((e) => {
        const m = metrics.get(e.metricId);
        if (!m) return null;
        const label = m.key === 'online' ? d.name : m.label;
        const what = /^switch/.test(m.key) ? `${label} turned ${e.value}` : m.key === 'online' ? `${label} ${STATE_WORDS[e.value] || e.value}` : `${label}: ${STATE_WORDS[e.value] || e.value}`;
        // Who did it: a command sent from here moments before, otherwise something outside.
        let by = '';
        if (/^switch/.test(m.key)) {
          // Logged just before the state is stored; a slow device may report up to two minutes later.
          const a = actions.find((x) => x.status === 'ok' && x.sets && x.sets[m.key] === e.value && x.ts <= e.ts + 2 && x.ts >= e.ts - 120);
          by = a ? (a.automation ? `automation “${a.automation}”` : a.user ? `by ${a.user}` : '') : st.hist.initial.some((x) => x.metricId === e.metricId) || firstOf.get(e.metricId) !== e.ts ? 'outside this dashboard (eWeLink app, wall switch or timer)' : 'first recorded';
        }
        return { ts: e.ts, kind: 'event', html: `<b>${esc(what)}</b>${by ? ` <span class="small faint">${esc(by)}</span>` : ''}` };
      })
      .filter(Boolean)
      .concat(
        actions.map((a) => ({
          ts: a.ts,
          kind: 'cmd',
          html: `${icon(a.automation ? 'zap' : 'user', 'style="width:13px;height:13px;vertical-align:-2px"')} Sent “${esc(a.summary)}” ${a.automation ? `by automation <a href="#/automations">${esc(a.automation)}</a>` : `by ${esc(a.user || a.source)}`}
            ${a.status === 'ok' ? '' : `<span class="badge err">Failed</span> <span class="small faint">${esc(a.message || '')}</span>`}`,
        }))
      )
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 300);
    $('#events', root).innerHTML = items.length
      ? `<ul class="event-list">${items.map((x) => `<li class="${x.kind}"><span class="ev-time small" title="${esc(fmtTime(x.ts))}">${esc(fmtTime(x.ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span><span>${x.html}</span></li>`).join('')}</ul>`
      : '<div class="empty small">Nothing happened in this period.</div>';
  }

  function renderCloud() {
    const c = st.cloud;
    if (!c) return;
    if (c.error) {
      $('#cloud', root).innerHTML = `<div class="alert warn small">${icon('info')}<div class="grow">${esc(c.error)}</div></div>`;
      return;
    }
    $('#cloud', root).innerHTML = c.items.length
      ? `<div class="table-wrap" style="max-height:360px"><table class="table"><thead><tr><th>When</th><th>What</th><th>From</th></tr></thead><tbody>${c.items
          .map((h) => `<tr><td class="nowrap small">${esc(fmtTime(h.ts))}</td><td>${esc(h.summary)}</td><td class="small muted">${esc(h.by === 'device' ? 'the device (button or timer)' : h.by)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<div class="empty small">eWeLink has no operations recorded for this device.</div>';
  }

  async function loadHistory() {
    st.bounds = rangeBounds();
    st.hist = await api.get(`${base}/history`, st.bounds);
    if (!st.selected) {
      const nums = st.hist.metrics.filter((m) => m.kind === 'number');
      const pref = nums.filter((m) => !['rssi', 'battery', 'brightness', 'dayKwh', 'monthKwh', 'totalKwh'].includes(m.key) && !/^voltage/.test(m.key));
      st.selected = new Set((pref.length ? pref : nums).slice(0, 4).map((m) => m.id));
    }
    renderTimeline();
    renderPills();
    renderEvents();
    await loadChart();
  }

  async function renderEnergy() {
    const card = $('#energy-card', root);
    if (!d.controls.hundredDays) return;
    card.classList.remove('hidden');
    const days = d.hundredDays;
    if (!days || !days.length) {
      $('#energy-empty', root).textContent = canControl ? 'Press “Get from device” to load the daily energy the plug keeps.' : 'No daily energy loaded yet.';
      $('#energy-chart', root).classList.add('hidden');
      return;
    }
    $('#energy-empty', root).textContent = `Total ${fmtNumber(days.reduce((a, b) => a + b, 0), 1)} kWh over ${days.length} days.`;
    $('#energy-chart', root).classList.remove('hidden');
    if (!energyChart) energyChart = createBarChart($('#energy-chart', root));
    const today = new Date();
    const cats = days.map((_, i) => {
      const x = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      return x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }).reverse();
    energyChart.setData({ categories: cats, unit: 'kWh', series: [{ name: 'Energy', color: slotColor(1), data: [...days].reverse() }] });
  }

  function renderAll() {
    renderHead();
    renderControls();
    renderNow();
    renderRaw();
  }

  $('#ranges', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    st.range = b.dataset.v;
    try {
      localStorage.setItem('deye-smart-range', st.range);
    } catch {}
    $$('#ranges button', root).forEach((x) => x.classList.toggle('active', x.dataset.v === st.range));
    loadHistory().catch((err) => toast(err.message, 'err'));
  });
  $$('#ranges button', root).forEach((x) => x.classList.toggle('active', x.dataset.v === st.range));
  $('#pills', root).addEventListener('click', (e) => {
    const p = e.target.closest('[data-metric]');
    if (!p) return;
    const mid = Number(p.dataset.metric);
    if (st.selected.has(mid)) st.selected.delete(mid);
    else st.selected.add(mid);
    renderPills();
    loadChart().catch(() => {});
  });
  $('#cloud-btn', root).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const h = await api.get(`${base}/history`, { ...rangeBounds(), cloud: 1 });
      st.cloud = h.cloud;
      renderCloud();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  const eg = $('#energy-get', root);
  if (eg) {
    eg.onclick = async () => {
      eg.disabled = true;
      eg.innerHTML = '<span class="spinner sm"></span> Asking the device…';
      try {
        const r = await api.post(`${base}/hundred-days`);
        if (!r.ok) toast(r.message, 'err');
        d.hundredDays = r.days;
        renderEnergy();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        eg.disabled = false;
        eg.innerHTML = `${icon('download')} Get from device`;
      }
    };
  }

  renderAll();
  renderEnergy();
  await loadHistory();

  let n = 0;
  const timer = setInterval(async () => {
    if (st.busy) return;
    try {
      const r = await api.get(`/api/ewelink/devices/${encodeURIComponent(id)}`);
      d = r.device;
      renderHead();
      renderNow();
      renderRaw();
      if (!document.activeElement || !$('#controls', root).contains(document.activeElement)) renderControls();
      if (++n % 6 === 0) await loadHistory();
    } catch {}
  }, 10000);
  return () => {
    clearInterval(timer);
    chart.dispose();
    if (energyChart) energyChart.dispose();
  };
}

