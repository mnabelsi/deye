import { api } from '../api.js';
import { $, $$, esc, icon, fmtValue, fmtTime, fmtAgo, debounce } from '../util.js';

function typeLabel(t) {
  if (!t) return 'Device';
  return t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ');
}

function statusBadge(status) {
  const s = String(status || '').toUpperCase();
  if (!s) return '';
  if (['1', 'NORMAL', 'ONLINE', 'CONNECTED', 'ALL_ONLINE'].includes(s)) return '<span class="badge ok">Online</span>';
  if (['0', 'OFFLINE', 'ALL_OFFLINE', 'DISCONNECTED'].includes(s)) return '<span class="badge err">Offline</span>';
  if (['2', 'ALARM', 'WARNING', 'PARTIAL_OFFLINE'].includes(s)) return '<span class="badge warn">Alert</span>';
  return `<span class="badge">${esc(status)}</span>`;
}

export async function mount(root, ctx) {
  const sources = await ctx.store.sources(true);
  const allSources = [];
  for (const s of sources.stations) {
    allSources.push({ type: 'station', id: s.id, title: s.name, sub: s.address || `Station ${s.id}`, lastTs: s.lastTs, status: s.connectionStatus, extra: s.installedCapacity ? `${s.installedCapacity} kWp` : '' });
    // Inverters first: they carry most readings; loggers and meters follow.
    const devs = [...s.devices].sort((a, b) => (a.type === 'INVERTER' ? 0 : 1) - (b.type === 'INVERTER' ? 0 : 1));
    for (const d of devs) allSources.push({ type: 'device', id: d.sn, title: d.sn, sub: `${typeLabel(d.type)}${d.productId ? ` · ${d.productId}` : ''}`, lastTs: d.lastTs, status: d.connectStatus, station: s.name });
  }
  for (const d of sources.unassignedDevices || []) allSources.push({ type: 'device', id: d.sn, title: d.sn, sub: typeLabel(d.type), lastTs: d.lastTs, status: d.connectStatus });

  if (!allSources.length) {
    root.innerHTML = `<div class="card empty">${icon('device')}<h3>No stations or devices yet</h3>
      <p>Add your DeyeCloud API credentials in Settings. Stations and devices are discovered automatically.</p>
      <a class="btn primary" href="#/settings">Open settings</a></div>`;
    return;
  }

  const sel = ctx.params.get('id');
  const st = {
    current: allSources.find((s) => s.id === sel) || allSources.find((s) => s.type === 'device') || allSources[0],
    search: '',
    category: '',
    metrics: [],
  };

  root.innerHTML = `
    <div class="stack">
      <div class="device-cards" id="cards"></div>
      <div class="card">
        <div class="card-head">
          <h2 id="readings-title">Readings</h2>
          <input type="search" id="search" placeholder="Search readings…" style="max-width:260px">
        </div>
        <div class="chips" id="cats" style="margin-bottom:12px"></div>
        <div id="readings"></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>State changes</h2><span class="small faint">Text readings (modes, statuses, faults) are logged whenever they change · last 7 days</span></div>
        <div id="events"></div>
      </div>
    </div>`;

  function renderCards() {
    $('#cards', root).innerHTML = allSources
      .map(
        (s) => `<div class="card device-card ${s === st.current ? 'active' : ''}" data-id="${esc(s.id)}" tabindex="0">
          <div class="dc-top">${icon(s.type === 'station' ? 'home' : 'device', 'style="width:16px;height:16px;color:var(--text-3)"')}
            <span class="${s.type === 'device' ? 'dc-sn' : ''}" style="font-weight:700">${esc(s.title)}</span><span class="spacer"></span>${statusBadge(s.status)}</div>
          <div class="small muted">${esc(s.sub)}</div>
          <div class="small faint">${s.station ? `${esc(s.station)} · ` : ''}${s.extra ? `${esc(s.extra)} · ` : ''}updated ${esc(fmtAgo(s.lastTs))}</div>
        </div>`
      )
      .join('');
  }
  $('#cards', root).onclick = (e) => {
    const c = e.target.closest('.device-card');
    if (!c) return;
    st.current = allSources.find((s) => s.id === c.dataset.id);
    st.category = '';
    history.replaceState(null, '', `#/devices?id=${encodeURIComponent(st.current.id)}`);
    renderCards();
    loadReadings();
  };
  $('#cards', root).onkeydown = (e) => {
    if (e.key === 'Enter') e.target.click();
  };

  function renderReadings() {
    const cats = [...new Set(st.metrics.map((m) => m.category))].sort();
    $('#cats', root).innerHTML = `<button class="chip ${!st.category ? 'active' : ''}" data-c="">All (${st.metrics.length})</button>${cats
      .map((c) => `<button class="chip ${st.category === c ? 'active' : ''}" data-c="${esc(c)}">${esc(c)} (${st.metrics.filter((m) => m.category === c).length})</button>`)
      .join('')}`;
    const list = st.metrics.filter(
      (m) => (!st.category || m.category === st.category) && (!st.search || `${m.label} ${m.key}`.toLowerCase().includes(st.search))
    );
    $('#readings', root).innerHTML = list.length
      ? `<div class="table-wrap tall"><table class="table">
          <thead><tr><th>Reading</th><th>Key</th><th>Category</th><th class="num">Value</th><th>Updated</th><th></th></tr></thead>
          <tbody>${list
            .map(
              (m) => `<tr>
                <td><b>${esc(m.label)}</b></td>
                <td class="mono faint">${esc(m.key)}</td>
                <td><span class="badge">${esc(m.category)}</span></td>
                <td class="num nowrap"><b>${esc(fmtValue(m.lastValue, m.unit))}</b></td>
                <td class="small muted nowrap" title="${esc(fmtTime(m.lastTs))}">${esc(fmtAgo(m.lastTs))}</td>
                <td class="num">${m.kind === 'number' ? `<a class="btn sm ghost" href="#/charts?m=${m.id}&r=24h" title="Open in charts">${icon('chart')}</a>` : ''}</td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : `<div class="empty">${st.metrics.length ? 'No readings match' : 'No readings collected for this source yet'}</div>`;
  }
  $('#cats', root).onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    st.category = b.dataset.c;
    renderReadings();
  };
  $('#search', root).oninput = debounce((e) => {
    st.search = e.target.value.trim().toLowerCase();
    renderReadings();
  }, 120);

  async function loadReadings() {
    $('#readings-title', root).textContent = `${st.current.type === 'station' ? 'Station' : 'Device'} ${st.current.title} · readings`;
    const [m, ev] = await Promise.all([
      api.get('/api/metrics', { sourceType: st.current.type, sourceId: st.current.id }),
      api.get('/api/events', { sourceId: st.current.id }),
    ]);
    st.metrics = m.metrics;
    renderReadings();
    $('#events', root).innerHTML = ev.events.length
      ? `<div class="table-wrap" style="max-height:360px"><table class="table"><thead><tr><th>Time</th><th>Reading</th><th>New value</th></tr></thead>
          <tbody>${ev.events.map((e) => `<tr><td class="nowrap small">${esc(fmtTime(e.ts))}</td><td>${esc(e.label)}</td><td><b>${esc(e.value)}</b></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty small">No state changes recorded in the last 7 days</div>';
  }

  renderCards();
  await loadReadings();
}
