import { api } from '../api.js';
import { $, $$, esc, icon, toast, fmtNumber, cssVar, modal, confirmDialog } from '../util.js';
import { createBarChart } from '../charts.js';
import { predictionCard, casesCard } from '../prediction.js';

// Events: when the grid and the generator came on and went off, when the battery crossed chosen
// levels and when custom conditions held, plus the patterns in them (the hours a source is usually
// on, how long the battery carries the home before the generator starts). The server works all of
// it out from the stored readings, so imported history counts too.

const PERIODS = [['1d', '24 hours', 1], ['7d', '7 days', 7], ['30d', '30 days', 30], ['90d', '90 days', 90], ['365d', '12 months', 365]];
const OPS = [['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥']];
const OP_TEXT = Object.fromEntries(OPS);
const SHOW = 200; // events shown before "Show more"
const pad = (n) => String(n).padStart(2, '0');

/** "3 h 20 min", "45 min", "2 d 4 h". */
function dur(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const h = Math.round(m / 60);
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}
const clock = (minute) => `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;
const hourRange = ([a, b]) => `${pad(a % 24)}:00–${pad(b % 24)}:00`;
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export async function mount(root, ctx) {
  const live = await api.get('/api/live').catch(() => ({ stations: [] }));
  const st = { station: ctx.params.get('station') || '', period: ctx.params.get('p') || '7d', filter: 'all', shown: SHOW };
  let data = null;
  let fc = null;
  let charts = [];
  let loading = 0;

  root.innerHTML = `
    <div class="stack">
      <div class="card" style="padding:12px 14px">
        <div class="row">
          <select id="station" class="inline-input hidden"></select>
          <div class="seg" id="periods">${PERIODS.map(([k, l]) => `<button data-p="${k}">${l}</button>`).join('')}</div>
          <span class="spacer"></span>
          <span class="small faint" id="zone"></span>
        </div>
      </div>
      <div id="notice"></div>
      <div class="grid kpis" id="now"></div>
      <div id="forecast"></div>
      <div id="cases"></div>
      <div class="ev-cols">
        <div class="card"><div class="card-head"><h2>${icon('history', 'style="width:16px;height:16px;vertical-align:-3px"')} What happened</h2></div>
          <div class="chips" id="filters" style="margin-bottom:10px"></div><div id="events"></div></div>
        <div class="stack" id="patterns"></div>
      </div>
      <div class="card" id="custom"></div>
    </div>`;

  // ---------- formatting in the zone the patterns use ----------
  const inZone = (ts, opts) => {
    try {
      return new Date(ts * 1000).toLocaleString(undefined, { timeZone: data.timeZone, ...opts });
    } catch {
      return new Date(ts * 1000).toLocaleString(undefined, opts);
    }
  };
  const timeOf = (ts) => inZone(ts, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayOf = (ts) => inZone(ts, { weekday: 'short', month: 'short', day: 'numeric' });
  const since = (now) => (now ? `${now.exact ? 'for' : 'for at least'} ${dur(Date.now() / 1000 - now.since)}` : '');

  const metrics = () => {
    const s = live.stations.find((x) => x.id === (data.station && data.station.id)) || live.stations[0];
    return s ? [...s.metrics, ...s.devices.flatMap((d) => d.metrics)].filter((m) => m.kind === 'number') : [];
  };
  function condText(c) {
    const node = (k) => ((data.powerNodes.find((n) => n.key === k) || {}).label || k).replace(/ \(.*\)$/, '').toLowerCase();
    switch (c.type) {
      case 'soc':
        return `battery ${OP_TEXT[c.op]} ${fmtNumber(c.value)}%`;
      case 'power':
        return `${node(c.node)} ${OP_TEXT[c.op]} ${fmtNumber(c.value)} W`;
      case 'battery':
        return `battery is ${c.state}`;
      case 'source':
        return `${c.source === 'grid' ? data.names.grid : data.names.generator} is ${c.state}`;
      case 'reading': {
        const m = metrics().find((x) => x.id === c.metricId);
        return `${m ? m.label : `reading #${c.metricId}`} ${OP_TEXT[c.op]} ${fmtNumber(c.value)}${m && m.unit ? ` ${m.unit}` : ''}`;
      }
      default:
        return c.type;
    }
  }

  // ---------- the list ----------
  function describe(e) {
    const gap = e.approx ? ' <span class="faint">(some time before this: there is a gap in the data)</span>' : '';
    const batt = e.soc === null || e.soc === undefined ? '' : `battery ${e.soc}%`;
    if (e.kind === 'grid' || e.kind === 'generator') {
      const name = data.names[e.kind];
      const verb = e.kind === 'generator' ? (e.on ? 'started' : 'stopped') : e.on ? 'came on' : 'went off';
      const before = e.prevFor ? `after ${dur(e.prevFor)} ${e.on ? 'off' : 'on'}` : '';
      return { cls: e.on ? 'on' : 'off', title: `${name} ${verb}`, sub: [before, batt].filter(Boolean).join(' · ') + gap };
    }
    if (e.kind === 'soc') {
      const title = e.dir === 'down' ? `Battery dropped to ${e.level}%` : e.level === 100 ? 'Battery full (100%)' : `Battery reached ${e.level}%`;
      return { cls: e.dir === 'down' ? 'down' : 'up', title, sub: gap };
    }
    const lasted = !e.on && e.prevFor ? `lasted ${dur(e.prevFor)}` : '';
    return { cls: e.on ? 'custom' : 'custom end', title: `${e.name} ${e.on ? 'started' : 'ended'}`, sub: [lasted, batt].filter(Boolean).join(' · ') + gap };
  }

  function renderEvents() {
    const kinds = [['all', 'All'], ...data.sources.map((s) => [s.kind, s.name]), ['soc', 'Battery'], ...(data.rules.length ? [['custom', 'Custom']] : [])];
    if (!kinds.some(([k]) => k === st.filter)) st.filter = 'all';
    $('#filters', root).innerHTML = kinds.map(([k, l]) => `<button class="chip ${st.filter === k ? 'active' : ''}" data-filter="${k}">${esc(l)}</button>`).join('');
    const all = data.events.filter((e) => st.filter === 'all' || e.kind === st.filter);
    if (!all.length) {
      $('#events', root).innerHTML = `<div class="empty" style="padding:36px 12px">${icon('history')}<h3>Nothing in this period</h3><p>${data.dataTo ? 'No changes were seen in the stored readings.' : 'There are no stored readings for this period yet.'}</p></div>`;
      return;
    }
    let day = '';
    const rows = [];
    for (const e of all.slice(0, st.shown)) {
      const d = dayOf(e.ts);
      if (d !== day) {
        rows.push(`<li class="ev-day">${esc(d)}</li>`);
        day = d;
      }
      const x = describe(e);
      rows.push(`<li><span class="ev-time">${esc(timeOf(e.ts))}</span><span class="ev-dot ${x.cls}"></span><span><b>${esc(x.title)}</b>${x.sub ? `<span class="small muted"> · ${x.sub}</span>` : ''}</span></li>`);
    }
    const more = all.length > st.shown ? `<button class="btn sm" id="more" style="margin-top:10px">Show ${Math.min(SHOW, all.length - st.shown)} more</button>` : '';
    $('#events', root).innerHTML = `<ul class="event-list ev-list">${rows.join('')}</ul>${more}
      ${data.truncated ? '<p class="small faint" style="margin:8px 0 0">Only the newest events of this period are listed; the patterns use all of it.</p>' : ''}`;
  }

  // ---------- now ----------
  function renderNow() {
    const tile = (color, ic, label, value, sub) => `<div class="card kpi" style="--c:var(${color})"><div class="kpi-top"><div class="kpi-icon">${icon(ic)}</div><div class="kpi-label">${esc(label)}</div></div>
      <div class="kpi-value">${value}</div><div class="kpi-sub">${esc(sub)}</div></div>`;
    const tiles = data.sources.map((s) => tile(s.kind === 'grid' ? '--grid' : '--generator', s.kind === 'grid' ? 'grid' : 'bolt', s.name, s.now ? (s.now.on ? 'On' : 'Off') : '—', s.now ? since(s.now) : 'No recent reading'));
    const b = data.battery;
    if (b) tiles.push(tile('--battery', 'battery', 'Battery', b.soc === null ? '—' : `${fmtNumber(b.soc, 0)}<small>%</small>`, b.now && b.now.on ? `Carrying the home ${since(b.now)}` : b.soc === null ? 'No recent reading' : ''));
    $('#now', root).innerHTML = tiles.join('');
  }

  // ---------- prediction and day cases ----------
  function renderForecast() {
    $('#forecast', root).innerHTML = predictionCard(fc);
    $('#cases', root).innerHTML = casesCard(fc);
  }

  // ---------- patterns ----------
  function sourceCard(s, i) {
    const days = s.knownSeconds / 86400;
    if (!s.knownSeconds) return `<div class="card"><div class="card-head"><h2>When ${esc(s.name)} is usually on</h2></div><p class="muted">No readings in this period.</p></div>`;
    const best = s.hourShare.reduce((a, v, h) => (v !== null && v > a.v ? { h, v } : a), { h: 0, v: -1 });
    const firstOn = s.hourStarts.reduce((a, v, h) => (v > a.v ? { h, v } : a), { h: 0, v: 0 });
    const usual = s.usual.length === 1 && s.usual[0][1] - s.usual[0][0] >= 24
      ? 'It is on at every hour of the day more often than not.'
      : s.usual.length
        ? `It is usually on ${list(s.usual.map(hourRange))}.`
        : s.share > 0
          ? `There is no hour when it is on most days; it is most likely around ${pad(best.h)}:00 (${fmtNumber(best.v * 100, 0)}% of days).`
          : '';
    const verb = s.kind === 'generator' ? 'Starts' : 'Comes on';
    return `<div class="card"><div class="card-head"><h2>When ${esc(s.name)} is usually on</h2></div>
      <p style="margin:0 0 4px"><b>On ${fmtNumber(s.share * 100, 0)}% of the time</b>, about ${fmtNumber(s.hoursPerDay, 1)} h a day. ${esc(usual)}</p>
      <div class="chart short" data-chart="${i}"></div>
      <dl class="kv" style="margin-top:6px">
        <dt>Stays on</dt><dd>${s.onStretch.n ? `${dur(s.onStretch.avg)} on average, ${dur(s.onStretch.max)} at most` : '—'}</dd>
        <dt>Stays off</dt><dd>${s.offStretch.n ? `${dur(s.offStretch.avg)} on average, ${dur(s.offStretch.max)} at most` : '—'}</dd>
        <dt>${verb}</dt><dd>${fmtNumber(s.startsPerDay, 1)} times a day${firstOn.v ? `, most often around ${pad(firstOn.h)}:00` : ''}</dd>
      </dl>
      <p class="small faint" style="margin:8px 0 0">From ${fmtNumber(days, days < 10 ? 1 : 0)} days of readings. Bars show the share of each hour it had power.</p></div>`;
  }

  function batteryCard() {
    const b = data.battery;
    const grid = data.names.grid;
    const gen = data.names.generator;
    const pct = (v) => (v === null ? '—' : `${fmtNumber(v, 0)}%`);
    const lines = [];
    if (!b.all.n) lines.push(`<p class="muted">${esc(grid)} did not go off and come back within this period, so there is nothing to measure yet.</p>`);
    else {
      if (b.hasGenerator && b.untilGenerator.n) {
        const g = b.untilGenerator;
        lines.push(`<p style="margin:0"><b>${dur(g.avg)} on average</b> between ${esc(grid)} going off and ${esc(gen)} starting (typically ${dur(g.median)}, at most ${dur(g.max)}; ${g.n} time${g.n === 1 ? '' : 's'}).
          The battery was at ${pct(g.socStart)} when ${esc(grid)} went off and ${pct(g.socEnd)} when ${esc(gen)} started.</p>`);
      } else if (b.hasGenerator) lines.push(`<p style="margin:0">${esc(gen)} never had to start after a cut in this period.</p>`);
      if (b.untilGrid.n) {
        const g = b.untilGrid;
        lines.push(`<p style="margin:0">${g.n} ${b.hasGenerator ? 'other ' : ''}time${g.n === 1 ? '' : 's'} ${esc(grid)} came back ${b.hasGenerator ? 'first' : ''} after ${dur(g.avg)} on average (at most ${dur(g.max)}), with the battery going from ${pct(g.socStart)} to ${pct(g.socEnd)}.</p>`);
      }
      lines.push('<p class="small faint" style="margin:0">These stretches include daytime, when solar helps the battery along.</p>');
    }
    const levels = data.levelStats
      .flatMap((l) => [
        l.up.days ? `<dt>Reaches ${l.level}%</dt><dd>on ${l.up.days} of ${l.daysWithData} days, usually around ${clock(l.up.medianMinute)}</dd>` : `<dt>Reaches ${l.level}%</dt><dd>never in this period</dd>`,
        l.down && l.down.days ? `<dt>Drops to ${l.level}%</dt><dd>on ${l.down.days} of ${l.daysWithData} days, usually around ${clock(l.down.medianMinute)}</dd>` : '',
      ])
      .join('');
    return `<div class="card"><div class="card-head"><h2>How long the battery holds</h2></div><div class="stack" style="gap:10px">${lines.join('')}
      ${levels ? `<dl class="kv">${levels}</dl>` : ''}</div></div>`;
  }

  function renderPatterns() {
    for (const c of charts) c.dispose();
    charts = [];
    $('#patterns', root).innerHTML = data.sources.map(sourceCard).join('') + (data.battery ? batteryCard() : '');
    $$('[data-chart]', root).forEach((el) => {
      const s = data.sources[Number(el.dataset.chart)];
      const chart = createBarChart(el, { noSlider: true });
      chart.setData({
        categories: s.hourShare.map((_, h) => `${pad(h)}:00`),
        series: [{ name: `${s.name} on`, color: cssVar(s.kind === 'grid' ? '--grid' : '--generator'), data: s.hourShare.map((v) => (v === null ? null : Math.round(v * 1000) / 10)) }],
        unit: '%',
      });
      charts.push(chart);
    });
  }

  // ---------- custom events ----------
  function renderCustom() {
    const rows = data.rules
      .map((r) => {
        const s = data.ruleStats.find((x) => x.id === r.id) || { times: 0, held: { n: 0 }, now: null };
        const state = s.now ? (s.now.on ? `<span class="badge ok">Now ${esc(since(s.now))}</span>` : '<span class="badge">Not now</span>') : '';
        return `<tr><td><b>${esc(r.name)}</b><div class="small muted">when ${esc(condText(r.condition))}</div></td>
          <td class="small">${s.times ? `${s.times} time${s.times === 1 ? '' : 's'}${s.held.n ? `, lasting ${dur(s.held.avg)} on average` : ''}` : 'Not in this period'}</td><td>${state}</td>
          <td class="nowrap" style="text-align:right">${data.canEdit ? `<button class="btn sm ghost" data-edit="${r.id}">${icon('edit')} Edit</button><button class="btn sm ghost danger" data-del="${r.id}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`;
      })
      .join('');
    $('#custom', root).innerHTML = `<div class="card-head"><h2>Your own events</h2><span class="spacer"></span>${data.canEdit ? `<button class="btn sm primary" id="add">${icon('plus')} New event</button>` : ''}</div>
      ${rows ? `<div class="table-wrap"><table class="table"><tbody>${rows}</tbody></table></div>` : `<p class="muted" style="margin:0">Watch anything the inverter reports, such as “load above 3000 W” or “battery below 30%”. Each event is listed above when it starts and ends${data.canEdit ? '' : '. Only admins can add them'}.</p>`}
      <div class="row" style="margin-top:14px"><span class="small muted">Battery levels to watch (%)</span>
        ${data.canEdit ? `<input type="text" id="levels" class="inline-input" style="width:150px" value="${esc(data.levels.join(', '))}"><button class="btn sm" id="save-levels">Save</button>` : `<b class="small">${esc(data.levels.join(', ') || 'none')}</b>`}</div>`;
  }

  async function editRule(rule) {
    const c = (rule && rule.condition) || { type: 'soc', op: 'lt', value: 30 };
    const ops = (name, cur) => `<select name="${name}">${OPS.map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const is = (t) => (c.type === t ? '' : 'hidden');
    const val = (t, d) => (c.type === t ? c.value : d);
    const ms = metrics();
    const p = modal({
      title: rule ? 'Edit event' : 'New event',
      body: `<label class="field">Name<input type="text" name="name" value="${esc(rule ? rule.name : '')}" placeholder="Heavy load" required></label>
        <label class="field">Watch<select name="type">
          <option value="soc" ${c.type === 'soc' ? 'selected' : ''}>Battery level</option>
          <option value="power" ${c.type === 'power' ? 'selected' : ''}>Power (solar, load, grid…)</option>
          <option value="battery" ${c.type === 'battery' ? 'selected' : ''}>Battery charging or discharging</option>
          <option value="reading" ${c.type === 'reading' ? 'selected' : ''}>Any inverter reading</option></select></label>
        <div class="row ${is('soc')}" data-for="soc"><span>Battery is</span>${ops('soc_op', c.op)}<input type="number" name="soc_value" min="0" max="100" value="${esc(val('soc', 30))}" style="width:90px"><span>%</span></div>
        <div class="row ${is('power')}" data-for="power"><select name="power_node">${data.powerNodes.map((n) => `<option value="${n.key}" ${c.node === n.key ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}</select>${ops('power_op', c.type === 'power' ? c.op : 'gt')}<input type="number" name="power_value" value="${esc(val('power', 3000))}" style="width:110px"><span>W</span></div>
        <div class="row ${is('battery')}" data-for="battery"><span>Battery is</span><select name="battery_state">${['charging', 'discharging', 'idle'].map((x) => `<option ${c.state === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div class="row ${is('reading')}" data-for="reading"><select name="reading_metric" style="max-width:260px">${ms.map((m) => `<option value="${m.id}" ${c.metricId === m.id ? 'selected' : ''}>${esc(m.label)}${m.unit ? ` (${esc(m.unit)})` : ''}</option>`).join('')}</select>${ops('reading_op', c.type === 'reading' ? c.op : 'gt')}<input type="number" name="reading_value" step="any" value="${esc(val('reading', 0))}" style="width:110px"></div>
        <p class="small faint" style="margin:0">The event starts when this becomes true and ends when it stops. It is looked up in the stored history, so past occurrences show straight away.</p>`,
    });
    const form = document.querySelector('.modal-backdrop:last-of-type form');
    form.elements.type.onchange = (e) => $$('[data-for]', form).forEach((el) => el.classList.toggle('hidden', el.dataset.for !== e.target.value));
    const v = await p;
    if (!v) return;
    const condition = { soc: { op: v.soc_op, value: v.soc_value }, power: { node: v.power_node, op: v.power_op, value: v.power_value }, battery: { state: v.battery_state }, reading: { metricId: v.reading_metric, op: v.reading_op, value: v.reading_value } }[v.type];
    const body = { name: v.name, condition: { type: v.type, ...condition } };
    if (rule) await api.put(`/api/event-log/rules/${rule.id}`, body);
    else await api.post('/api/event-log/rules', body);
    toast('Event saved', 'ok');
    await load();
  }

  // ---------- loading ----------
  function render() {
    const sel = $('#station', root);
    sel.classList.toggle('hidden', data.stations.length < 2);
    sel.innerHTML = data.stations.map((s) => `<option value="${esc(s.id)}" ${data.station && s.id === data.station.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    $$('#periods button', root).forEach((b) => b.classList.toggle('active', b.dataset.p === st.period));
    $('#zone', root).textContent = `Times in ${data.timeZone} time`;
    const days = PERIODS.find((p) => p[0] === st.period)[2];
    const have = data.dataFrom ? (data.dataTo - data.dataFrom) / 86400 : 0;
    $('#notice', root).innerHTML = !data.station
      ? `<div class="alert warn">${icon('warn')}<div class="grow">No inverter yet. Connect DeyeCloud in Settings first.</div></div>`
      : !data.dataFrom
        ? `<div class="alert warn">${icon('warn')}<div class="grow">There are no stored readings for this period.</div></div>`
        : have < days * 0.8 && days > 1
          ? `<div class="alert">${icon('info')}<div class="grow small">Readings for this period start on ${esc(dayOf(data.dataFrom))}. To see further back, import history in <a href="#/settings">Settings</a>.</div></div>`
          : '';
    renderNow();
    renderForecast();
    renderEvents();
    renderPatterns();
    renderCustom();
  }

  async function load() {
    const mine = ++loading;
    const days = PERIODS.find((p) => p[0] === st.period)[2];
    const to = Math.floor(Date.now() / 1000);
    root.style.opacity = data ? '0.6' : '';
    try {
      const [d, f] = await Promise.all([
        api.get('/api/event-log', { station: st.station, from: to - days * 86400, to }),
        api.get('/api/event-log/forecast', { station: st.station }).catch(() => null),
      ]);
      if (mine !== loading) return;
      data = d;
      fc = f;
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      root.style.opacity = '';
    }
  }

  root.addEventListener('change', (e) => {
    if (e.target.id !== 'station') return;
    st.station = e.target.value;
    st.shown = SHOW;
    load();
  });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t || !data) return;
    try {
      if (t.dataset.p) {
        st.period = t.dataset.p;
        st.shown = SHOW;
        await load();
      } else if (t.dataset.filter) {
        st.filter = t.dataset.filter;
        st.shown = SHOW;
        renderEvents();
      } else if (t.id === 'more') {
        st.shown += SHOW;
        renderEvents();
      } else if (t.id === 'add') {
        await editRule(null);
      } else if (t.dataset.edit) {
        await editRule(data.rules.find((r) => r.id === Number(t.dataset.edit)));
      } else if (t.dataset.del) {
        const r = data.rules.find((x) => x.id === Number(t.dataset.del));
        if (!(await confirmDialog('Delete event', `Delete “${r.name}”? Its past occurrences disappear from the list.`, 'Delete'))) return;
        await api.del(`/api/event-log/rules/${r.id}`);
        await load();
      } else if (t.id === 'save-levels') {
        await api.put('/api/event-log/levels', { levels: $('#levels', root).value });
        toast('Battery levels saved', 'ok');
        await load();
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  await load();
  // Keep short periods current; long ones are heavier to work out and change little.
  const timer = setInterval(() => {
    if (!document.hidden && ['1d', '7d'].includes(st.period) && !document.querySelector('.modal-backdrop')) load();
  }, 120000);
  return () => {
    clearInterval(timer);
    for (const c of charts) c.dispose();
  };
}
