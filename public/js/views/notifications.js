import { api } from '../api.js';
import { $, esc, icon, toast, fmtAgo, fmtTime, debounce, confirmDialog } from '../util.js';
import { sourceNames } from '../flow.js';
import { CONDITION_TYPES, DAYS, conditionKit, sel } from '../conditions.js';

// Notifications: WhatsApp messages sent through your WAHA server when things happen — the grid or
// the generator coming on or going off, battery levels, your own conditions, a daily summary, and
// trouble (no inverter data, collection failing, smart devices offline, automations failing).

const KINDS = [
  ['source', 'Grid or generator on / off', 'When grid power comes or goes, or the generator starts or stops.'],
  ['soc', 'Battery level', 'When the battery reaches or drops to levels you choose.'],
  ['summary', 'Daily summary', 'Every day at a set time: energy, grid and generator hours, battery and tomorrow’s grid forecast.'],
  ['condition', 'My own condition', 'Any mix of conditions, like in automations: load above 3 kW, battery under 30% at night…'],
  ['stale', 'Inverter stops reporting', 'When no new readings arrive from DeyeCloud for a while.'],
  ['collector', 'Data collection fails', 'When polling DeyeCloud fails several times in a row.'],
  ['device', 'Smart device offline', 'When eWeLink devices go offline or come back.'],
  ['automation', 'Automation ran or failed', 'When automations fail, or every time they switch something.'],
  ['inverter', 'Inverter setting changed', 'When someone changes an inverter setting, or the change fails.'],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));
const LOG_STATUS = { sent: ['ok', 'Sent'], partial: ['warn', 'Partly sent'], failed: ['err', 'Failed'], pending: ['info', 'Sending'], held: ['info', 'Held (quiet hours)'], skipped: ['', 'Not sent'] };
const QUIET = [['hold', 'Hold and send when quiet hours end'], ['skip', 'Don’t send'], ['send', 'Send anyway (urgent)']];
// The custom message boxes each kind has: [label, shown?] for the first way it reports and, for kinds
// that report two ways (on / off, reached / dropped…), the second.
const MESSAGES = {
  source: (r) => [['When it comes on', r.on], ['When it goes off', r.off]],
  soc: (r) => [['When it reaches a level', r.up], ['When it drops to a level', r.down]],
  condition: (r) => [['When the conditions start holding', true], ['When they stop', r.whenStops]],
  stale: (r) => [['When data stops', true], ['When data is back', r.whenBack]],
  collector: (r) => [['When collection fails', true], ['When it works again', r.whenBack]],
  device: (r) => [['When a device goes offline', r.offline], ['When it is back online', r.online]],
};
const SESSION = { WORKING: ['ok', 'Connected'], SCAN_QR_CODE: ['warn', 'Needs QR scan'], STARTING: ['info', 'Starting'], STOPPED: ['err', 'Stopped'], FAILED: ['err', 'Failed'] };

export async function mount(root, ctx) {
  if (!ctx.user.isAdmin) {
    root.innerHTML = `<div class="alert">${icon('info')}<div class="grow">Only admins can set up WhatsApp notifications.</div></div>`;
    return null;
  }
  const [first, devs, live] = await Promise.all([
    api.get('/api/notifications'),
    api.get('/api/ewelink/devices').catch(() => ({ devices: [], status: { connected: false } })),
    api.get('/api/live').catch(() => ({ stations: [] })),
  ]);
  let data = first;
  let session = null; // last WAHA check: { ok, session, version } | { error }
  const stations = live.stations;
  const names = sourceNames(stations[0]);
  const metrics = [];
  for (const s of stations) for (const m of [...s.metrics, ...s.devices.flatMap((d) => d.metrics)]) if (m.kind === 'number') metrics.push({ ...m, station: s.name });
  const kit = conditionKit({ devices: devs.devices, metrics, names, powerNodes: data.powerNodes, timeZone: () => data.timeZone });
  let editing = null; // { id|null, draft }
  let preview = null; // { texts } | { error }

  function defaults(type) {
    const all = [1, 2, 3, 4, 5, 6, 7];
    const base = { recipients: [], message: '', messageEnd: '', cooldownMinutes: 0, quiet: 'hold', stationId: null };
    switch (type) {
      case 'source':
        return { ...base, type, name: `${names.grid} on / off`, source: 'grid', on: true, off: true, holdMinutes: 1 };
      case 'soc':
        return { ...base, type, name: 'Battery low or full', levels: [20, 100], up: true, down: true };
      case 'condition':
        return { ...base, type, name: '', match: 'all', conditions: [kit.defaults('soc')], holdMinutes: 5, whenStops: false };
      case 'stale':
        return { ...base, type, name: 'Inverter stopped reporting', minutes: 30, whenBack: true, quiet: 'send' };
      case 'collector':
        return { ...base, type, name: 'Data collection failing', errors: 3, whenBack: true };
      case 'device':
        return { ...base, type, name: 'Smart device offline', deviceId: null, offline: true, online: true, holdMinutes: 5 };
      case 'automation':
        return { ...base, type, name: 'Automation failed', automationId: null, only: 'failed' };
      case 'inverter':
        return { ...base, type, name: 'Inverter setting changed', only: 'all' };
      case 'summary':
        return { ...base, type, name: 'Daily summary', at: '21:00', days: all, energy: true, sources: true, battery: true, forecast: true };
      default:
        return { ...base, type };
    }
  }

  const PRESETS = [
    { key: 'grid', title: `${names.grid} on / off`, text: `A message when ${names.grid} comes and when it goes, with how long it was off or on.`, build: () => defaults('source') },
    ...(stations.some((s) => s.metrics.concat(s.devices.flatMap((d) => d.metrics)).some((m) => /gen/i.test(m.key))) ? [{ key: 'gen', title: `${names.generator} on / off`, text: `When ${names.generator} starts and stops.`, build: () => ({ ...defaults('source'), name: `${names.generator} on / off`, source: 'generator' }) }] : []),
    { key: 'low', title: 'Battery low', text: 'When the battery drops to 30% and to 15%.', build: () => ({ ...defaults('soc'), name: 'Battery low', levels: [15, 30], up: false, down: true }) },
    { key: 'full', title: 'Battery full', text: 'When the battery reaches 100%.', build: () => ({ ...defaults('soc'), name: 'Battery full', levels: [100], up: true, down: false }) },
    { key: 'summary', title: 'Daily summary', text: 'At 21:00: today’s energy, grid and generator hours, battery and tomorrow’s grid.', build: () => defaults('summary') },
    { key: 'stale', title: 'Inverter offline', text: 'When no new data arrives for 30 minutes, and when it is back.', build: () => defaults('stale') },
    { key: 'heavy', title: 'Heavy load on battery', text: `When the home uses over 3 kW for 5 minutes while ${names.grid} is off.`, build: () => ({ ...defaults('condition'), name: 'Heavy load on battery', conditions: [{ type: 'power', node: 'load', op: 'gt', value: 3000 }, { type: 'source', source: 'grid', state: 'off' }] }) },
    { key: 'trouble', title: 'Automation failures', text: 'When an automation can’t switch its devices.', build: () => defaults('automation') },
  ];

  // ---------- describing ----------
  const recipientNames = (ids) => {
    const on = data.recipients.filter((r) => r.enabled);
    if (!ids || !ids.length) return on.length ? `everyone (${on.map((r) => r.name).join(', ')})` : 'everyone (no recipients yet)';
    const list = data.recipients.filter((r) => ids.includes(r.id));
    return list.length ? list.map((r) => `${r.name}${r.enabled ? '' : ' (off)'}`).join(', ') : 'nobody (the chosen recipients were removed)';
  };
  const or = (a, b, x, y) => (a && b ? `${x} or ${y}` : a ? x : y);
  function describe(r) {
    const after = (m) => (m ? ` <span class="muted">(after ${m} min)</span>` : '');
    switch (r.type) {
      case 'source':
        return `When <b>${esc(r.source === 'grid' ? names.grid : names.generator)}</b> ${or(r.on, r.off, 'comes on', 'goes off')}${after(r.holdMinutes)}`;
      case 'soc':
        return `When the battery ${or(r.up, r.down, 'reaches', 'drops to')} <b>${esc(r.levels.map((l) => `${l}%`).join(', '))}</b>`;
      case 'condition':
        return `When ${r.conditions.map((x) => esc(kit.condText(x))).join(r.match === 'any' ? ' <b>or</b> ' : ' <b>and</b> ')}${r.holdMinutes ? ` <span class="muted">for ${r.holdMinutes} min</span>` : ''}${r.whenStops ? ', and when it stops' : ''}`;
      case 'stale':
        return `When no new inverter data arrives for <b>${r.minutes} min</b>${r.whenBack ? ', and when it is back' : ''}`;
      case 'collector':
        return `When <b>${r.errors === 1 ? 'a poll' : `${r.errors} polls in a row`}</b> of DeyeCloud fail${r.errors === 1 ? 's' : ''}${r.whenBack ? ', and when it works again' : ''}`;
      case 'device': {
        const d = r.deviceId ? kit.devById.get(r.deviceId) : null;
        return `When <b>${esc(r.deviceId ? (d ? d.name : r.deviceId) : 'any smart device')}</b> ${or(r.offline, r.online, 'goes offline', 'comes back online')}${after(r.holdMinutes)}`;
      }
      case 'automation': {
        const a = r.automationId ? data.automations.find((x) => x.id === r.automationId) : null;
        return `When ${esc(r.automationId ? `“${a ? a.name : `#${r.automationId}`}”` : 'any automation')} ${r.only === 'all' ? 'runs or fails' : 'fails'}`;
      }
      case 'inverter':
        return r.only === 'all' ? 'When an inverter setting is changed (or the change fails)' : 'When changing an inverter setting fails';
      case 'summary': {
        const parts = [r.energy && 'energy', r.sources && `${names.grid} and ${names.generator} hours`, r.battery && 'battery', r.forecast && `tomorrow’s ${names.grid}`].filter(Boolean);
        return `${r.days.length === 7 ? 'Every day' : r.days.map((d) => DAYS[d - 1]).join(', ')} at <b>${esc(r.at)}</b>: ${esc(parts.join(', '))}`;
      }
      default:
        return esc(r.type);
    }
  }

  // ---------- page ----------
  ctx.actions.innerHTML = `<button class="btn sm" id="test-msg">${icon('send')} Send a test message</button><button class="btn sm primary" id="new-rule">${icon('plus')} New notification</button>`;
  root.innerHTML = `
    <div class="stack">
      <div id="banner"></div>
      <div class="grid cols-2">
        <div class="card" id="waha-card"></div>
        <div class="card" id="recipients-card"></div>
      </div>
      <div class="card" id="options-card"></div>
      <div id="editor"></div>
      <div id="rules" class="stack"></div>
      <div class="card"><div class="card-head"><h2>${icon('history', 'style="width:16px;height:16px;vertical-align:-3px"')} Messages</h2><button class="btn sm ghost" id="clear-log">Clear</button></div><div id="log"></div></div>
    </div>`;

  function renderBanner() {
    const parts = [];
    if (!data.waha.configured) parts.push(`<div class="alert warn">${icon('warn')}<div class="grow"><b>Connect your WAHA server to send WhatsApp messages.</b> Enter its address, API key and session below. Rules still watch for events until then.</div></div>`);
    else if (session && session.error) parts.push(`<div class="alert err">${icon('warn')}<div class="grow"><b>The WAHA server can’t be used right now.</b> ${esc(session.error)} Messages wait for up to an hour and are sent when it is back.</div></div>`);
    else if (session && session.session && session.session.status !== 'WORKING') parts.push(`<div class="alert warn">${icon('warn')}<div class="grow"><b>The WhatsApp session “${esc(session.session.name)}” is ${esc(session.session.status)}.</b> Open the WAHA dashboard and ${session.session.status === 'SCAN_QR_CODE' ? 'scan the QR code with WhatsApp on your phone' : 'start the session'}.</div></div>`);
    if (!data.options.enabled) parts.push(`<div class="alert warn">${icon('warn')}<div class="grow"><b>Notifications are turned off.</b> Rules keep watching but send nothing.</div><button class="btn sm" id="turn-on">Turn on</button></div>`);
    if (data.waha.configured && !data.recipients.length) parts.push(`<div class="alert warn">${icon('warn')}<div class="grow"><b>Add who should get the messages</b> under Recipients.</div></div>`);
    parts.push(`<div class="alert">${icon('info')}<div class="grow small">Notifications are checked every minute with the automations. The inverter’s readings come from DeyeCloud every few minutes, so a grid cut can take that long to be noticed. A new or changed rule first notes how things are, then tells you when they change. Times are in ${esc(data.timeZone)} time.</div></div>`);
    $('#banner', root).innerHTML = parts.join('');
  }

  // ---------- WAHA ----------
  function renderWaha() {
    const w = data.waha;
    const s = session && session.session;
    const [cls, label] = session && session.error ? ['err', 'Can’t connect'] : s ? SESSION[s.status] || ['warn', s.status] : w.configured ? ['', 'Checking…'] : ['', 'Not set up'];
    $('#waha-card', root).innerHTML = `
      <div class="card-head"><h2>${icon('send', 'style="width:16px;height:16px;vertical-align:-3px"')} WhatsApp (WAHA)</h2><span class="badge ${cls}">${esc(label)}</span></div>
      <p class="small muted">Messages are sent from the WhatsApp account signed in on your <a href="https://waha.devlike.pro" target="_blank" rel="noopener">WAHA</a> server. Use its address as this app’s server can reach it.</p>
      <form id="waha-form" class="stack" autocomplete="off" novalidate>
        <label class="field">Server address<input type="text" name="url" value="${esc(w.url)}" placeholder="http://192.168.1.20:3000" spellcheck="false"></label>
        <div class="form-grid">
          <label class="field">API key <span class="hint">${w.apiKeySet ? '(saved — leave empty to keep)' : '(WHATSAPP_API_KEY / WAHA_API_KEY)'}</span><input type="password" name="apiKey" autocomplete="new-password" placeholder="${w.apiKeySet ? '••••••••' : ''}"></label>
          <label class="field">Session<input type="text" name="session" value="${esc(w.session)}" spellcheck="false"></label>
        </div>
        ${w.apiKeySet ? '<label class="check small"><input type="checkbox" name="clearApiKey"> Remove the saved API key</label>' : ''}
        <div class="row">
          <button type="submit" class="btn primary">${icon('save')} Save</button>
          <button type="button" class="btn" id="waha-test">${icon('plug')} Test connection</button>
        </div>
      </form>
      <dl class="kv" style="margin-top:14px">${s ? `<dt>Session</dt><dd>${esc(s.name)} · ${esc(s.status)}${s.engine ? ` · ${esc(s.engine)}` : ''}</dd>
        <dt>Sends as</dt><dd>${s.me ? esc(`${s.me.pushName ? `${s.me.pushName} ` : ''}(${String(s.me.id || '').replace(/@.*/, '').replace(/^/, '+')})`) : '—'}</dd>${session.version ? `<dt>WAHA</dt><dd>${esc(session.version)}</dd>` : ''}` : ''}</dl>`;
  }

  const wahaPayload = () => {
    const f = $('#waha-form', root);
    return { url: f.url.value.trim(), apiKey: f.apiKey.value, session: f.session.value.trim(), clearApiKey: f.clearApiKey ? f.clearApiKey.checked : false };
  };

  async function checkWaha(payload) {
    if (!payload && !data.waha.configured) {
      session = null;
      return;
    }
    try {
      session = await api.post('/api/notifications/waha/test', payload || {});
    } catch (err) {
      session = { error: err.message };
    }
  }

  // ---------- recipients ----------
  function renderRecipients() {
    const list = data.recipients;
    $('#recipients-card', root).innerHTML = `
      <div class="card-head"><h2>${icon('user', 'style="width:16px;height:16px;vertical-align:-3px"')} Recipients</h2></div>
      ${list.length ? `<div class="recipient-list">${list
        .map(
          (r) => `<div class="recipient ${r.enabled ? '' : 'off'}">
            <button type="button" class="toggle ${r.enabled ? 'on' : ''}" role="switch" aria-checked="${r.enabled}" data-r-toggle="${r.id}" title="${r.enabled ? 'Stop sending to' : 'Send to'} ${esc(r.name)}"><span></span></button>
            <div class="grow"><b>${esc(r.name)}</b><div class="small muted">${esc(chatLabel(r.chatId))}</div></div>
            <button type="button" class="btn sm ghost" data-r-test="${r.id}" title="Send a test message">${icon('send')}</button>
            <button type="button" class="btn sm ghost danger" data-r-del="${r.id}" title="Remove">${icon('trash')}</button></div>`
        )
        .join('')}</div>` : '<p class="small muted">Nobody yet. Add your own number to start.</p>'}
      <form id="recipient-form" class="stack" style="margin-top:12px" novalidate>
        <div class="form-grid">
          <label class="field">Name<input type="text" name="name" maxlength="60" placeholder="e.g. Me"></label>
          <label class="field">WhatsApp number <span class="hint">with country code, or a group</span><input type="text" name="number" placeholder="+961 70 123 456" spellcheck="false"></label>
        </div>
        <div class="row">
          <button type="submit" class="btn">${icon('plus')} Add</button>
          <button type="button" class="btn ghost" id="load-groups" ${data.waha.configured ? '' : 'disabled'}>Pick a WhatsApp group…</button>
          <select id="group-pick" class="hidden" style="width:auto"></select>
        </div>
      </form>`;
  }
  const chatLabel = (id) => (/@g\.us$/.test(id) ? `Group ${id}` : /^\d+@c\.us$/.test(id) ? `+${id.replace(/@.*/, '')}` : id);

  async function saveRecipients(list) {
    const r = await api.put('/api/notifications/recipients', { recipients: list });
    data.recipients = r.recipients;
    renderRecipients();
    renderBanner();
    if (editing) renderEditor();
  }

  // ---------- options ----------
  function renderOptions() {
    const o = data.options;
    $('#options-card', root).innerHTML = `
      <div class="card-head"><h2>${icon('bell', 'style="width:16px;height:16px;vertical-align:-3px"')} Delivery</h2></div>
      <form id="options-form" class="row" style="align-items:flex-end;gap:16px" novalidate>
        <label class="check"><input type="checkbox" name="enabled" ${o.enabled ? 'checked' : ''}> Send notifications</label>
        <label class="field" style="width:auto">Quiet hours from<input type="time" name="quietFrom" value="${esc(o.quietFrom)}"></label>
        <label class="field" style="width:auto">to<input type="time" name="quietTo" value="${esc(o.quietTo)}"></label>
        <label class="field" style="flex:1;min-width:180px">Heading on each message <span class="hint">optional, e.g. your home’s name</span><input type="text" name="title" value="${esc(o.title)}" maxlength="60" placeholder="Home solar"></label>
        <button type="submit" class="btn">${icon('save')} Save</button>
      </form>
      <p class="small faint" style="margin:8px 0 0">During quiet hours each notification is held and sent together when they end, skipped, or sent anyway, as set on it. Leave both times empty for no quiet hours.</p>`;
  }

  // ---------- rules ----------
  function stateLine(n) {
    if (!n.enabled) return '<span class="badge">Off</span>';
    const err = n.note && /^Error/.test(n.note);
    return `<span class="dot ${err ? 'err' : n.checkedTs ? 'ok' : ''}"></span><span class="small">${n.note ? esc(n.note) : 'Not checked yet'}${n.sentTs ? ` · <b>last sent ${esc(fmtAgo(n.sentTs))}</b>` : ''}${n.checkedTs ? ` <span class="faint">(checked ${esc(fmtAgo(n.checkedTs))})</span>` : ''}</span>`;
  }

  function renderRules() {
    const el = $('#rules', root);
    const presets = `<div class="grid templates">${PRESETS.map((t) => `<button class="template" data-preset="${t.key}"><b>${esc(t.title)}</b><span class="small muted">${esc(t.text)}</span></button>`).join('')}</div>`;
    if (!data.rules.length) {
      el.innerHTML = editing ? '' : `<div class="card"><div class="card-head"><h2>What do you want to hear about?</h2></div>${presets}</div>`;
      return;
    }
    el.innerHTML = data.rules
      .map(
        (n) => `<div class="card rule-card ${n.enabled ? '' : 'disabled'}">
        <div class="card-head"><button type="button" class="toggle ${n.enabled ? 'on' : ''}" role="switch" aria-checked="${n.enabled}" data-enable="${n.id}" title="${n.enabled ? 'Turn off' : 'Turn on'}"><span></span></button>
          <h2>${esc(n.name)}</h2><span class="badge">${esc(KIND_LABEL[n.rule.type] || n.rule.type)}</span>
          <span class="spacer"></span>
          <button class="btn sm ghost" data-test="${n.id}" title="Send this message now as a test">${icon('send')} Test</button>
          <button class="btn sm ghost" data-edit="${n.id}">${icon('edit')} Edit</button>
          <button class="btn sm ghost danger" data-del="${n.id}" title="Delete">${icon('trash')}</button></div>
        <div class="rule-summary"><div>${describe(n.rule)}</div>
          <div class="small"><span class="muted">To</span> ${esc(recipientNames(n.rule.recipients))}${n.rule.cooldownMinutes ? ` <span class="muted">· at most every ${n.rule.cooldownMinutes} min</span>` : ''}${data.options.quietFrom && data.options.quietTo ? ` <span class="muted">· quiet hours: ${esc({ hold: 'held', skip: 'not sent', send: 'sent anyway' }[n.rule.quiet])}</span>` : ''}</div>
          ${n.rule.message || n.rule.messageEnd ? `<div class="small faint">Own message: ${esc([n.rule.message, n.rule.messageEnd].filter(Boolean).join(' / ').slice(0, 140))}</div>` : ''}</div>
        <div class="row rule-state">${stateLine(n)}</div>
      </div>`
      )
      .join('');
    el.insertAdjacentHTML('beforeend', `<details class="card"><summary class="small" style="cursor:pointer"><b>More ideas</b></summary><div style="margin-top:12px">${presets}</div></details>`);
  }

  function renderLog() {
    $('#log', root).innerHTML = data.log.length
      ? `<div class="table-wrap" style="max-height:520px"><table class="table"><thead><tr><th>When</th><th>Notification</th><th>To</th><th>Message</th><th>Result</th></tr></thead><tbody>${data.log
          .map((l) => {
            const [cls, label] = LOG_STATUS[l.status] || ['', l.status];
            return `<tr><td class="nowrap small" title="${esc(fmtTime(l.ts))}">${esc(fmtTime(l.ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
              <td class="small">${esc(l.kind === 'test' ? `Test${l.ruleName ? `: ${l.ruleName}` : ''}` : l.ruleName || '—')}</td>
              <td class="small">${esc(l.to.join(', ') || '—')}</td>
              <td class="small"><div class="log-text">${esc(l.text)}</div></td>
              <td><span class="badge ${cls}">${esc(label)}</span>${l.message ? `<div class="small faint" style="margin-top:4px">${esc(l.message)}</div>` : ''}${l.sentTs && l.sentTs - l.ts > 90 ? `<div class="small faint">sent ${esc(fmtTime(l.sentTs, { hour: '2-digit', minute: '2-digit' }))}</div>` : ''}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : '<div class="empty small">No messages yet.</div>';
  }

  // ---------- editor ----------
  const check = (field, value, label) => `<label class="check small"><input type="checkbox" data-f="${field}" ${value ? 'checked' : ''}> ${label}</label>`;
  const numIn = (field, value, min, max) => `<input type="number" data-f="${field}" value="${esc(value)}" min="${min}" max="${max}" class="num inline-input">`;

  function typeFields(r) {
    switch (r.type) {
      case 'source':
        return `<div class="edit-row">${sel('source', r.source, [['grid', names.grid], ['generator', names.generator]])}${check('on', r.on, 'comes on')}${check('off', r.off, 'goes off')}</div>
          <label class="check small" style="margin-top:8px">Only after it stays that way for ${numIn('holdMinutes', r.holdMinutes, 0, 240)} minutes, so short blips are ignored</label>`;
      case 'soc':
        return `<div class="edit-row"><span>Battery levels</span><input type="text" data-f="levels" value="${esc(r.levels.join(', '))}" placeholder="20, 50, 100" style="width:160px"><span class="small faint">% — up to 8, separated by commas</span></div>
          <div class="row" style="margin-top:8px;gap:16px">${check('up', r.up, 'when it <b>reaches</b> a level (charging)')}${check('down', r.down, 'when it <b>drops to</b> a level (discharging)')}</div>
          <p class="small faint" style="margin:6px 0 0">Once crossed, a level counts again after the battery moves 2% back.</p>`;
      case 'condition':
        return `<h3 class="edit-h">When ${sel('match', r.match, [['all', 'all of these hold'], ['any', 'any of these holds']])}</h3>
          <div class="edit-list">${r.conditions.map((x, i) => `<div class="edit-row" data-kind="cond" data-i="${i}">${sel('type', x.type, CONDITION_TYPES)}${kit.condFields(x)}<button type="button" class="btn icon sm ghost" data-remove="cond" data-i="${i}" title="Remove">${icon('trash')}</button></div>`).join('')}</div>
          <div class="row"><button type="button" class="btn sm" data-add="cond">${icon('plus')} Add condition</button></div>
          <label class="check small" style="margin-top:10px">Notify after the conditions hold for ${numIn('holdMinutes', r.holdMinutes, 0, 1440)} minutes</label>
          <div style="margin-top:8px">${check('whenStops', r.whenStops, 'Also notify when they stop holding')}</div>`;
      case 'stale':
        return `<label class="check small">Notify when no new reading arrives for ${numIn('minutes', r.minutes, 10, 1440)} minutes</label><div style="margin-top:8px">${check('whenBack', r.whenBack, 'Also notify when data is back')}</div>`;
      case 'collector':
        return `<label class="check small">Notify when ${numIn('errors', r.errors, 1, 50)} polls of DeyeCloud in a row fail</label><div style="margin-top:8px">${check('whenBack', r.whenBack, 'Also notify when it works again')}</div>`;
      case 'device':
        return `<div class="edit-row"><select data-f="deviceId"><option value="">Any smart device</option>${kit.deviceOptions(r.deviceId || '')}</select>${check('offline', r.offline, 'goes offline')}${check('online', r.online, 'comes back online')}</div>
          <label class="check small" style="margin-top:8px">Only after ${numIn('holdMinutes', r.holdMinutes, 0, 240)} minutes, so short drop-outs are ignored</label>
          ${devs.status.connected ? '' : '<p class="small faint">eWeLink is not connected, so there are no devices to watch.</p>'}`;
      case 'automation':
        return `<div class="edit-row"><select data-f="automationId"><option value="">Any automation</option>${data.automations.map((a) => `<option value="${a.id}" ${a.id === r.automationId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          ${sel('only', r.only, [['failed', 'fails (or partly fails)'], ['all', 'runs, and when it fails']])}</div>`;
      case 'inverter':
        return `<div class="edit-row">${sel('only', r.only, [['all', 'Every change, and failed ones'], ['failed', 'Only changes that fail']])}</div>`;
      case 'summary':
        return `<div class="edit-row"><span>Send at</span><input type="time" data-f="at" value="${esc(r.at)}"><span class="small faint">(${esc(data.timeZone)} time)</span>
            <span class="day-picks">${DAYS.map((d, i) => `<label class="check small"><input type="checkbox" data-sday="${i + 1}" ${r.days.includes(i + 1) ? 'checked' : ''}>${d}</label>`).join('')}</span></div>
          <div class="row" style="margin-top:8px;gap:16px">${check('energy', r.energy, 'Today’s energy')}${check('sources', r.sources, `${esc(names.grid)} and ${esc(names.generator)} hours`)}${check('battery', r.battery, 'Battery')}${check('forecast', r.forecast, `Tomorrow’s ${esc(names.grid)} forecast`)}</div>`;
      default:
        return '';
    }
  }

  function messageFields(r) {
    const ways = MESSAGES[r.type] ? MESSAGES[r.type](r) : [['', true]];
    const box = (field, label, value) => `<label class="field" style="margin-bottom:8px">${label ? esc(label) : ''}<textarea data-f="${field}" rows="3" maxlength="1000" placeholder="e.g. {event}&#10;Solar {solar}, load {load}">${esc(value)}</textarea></label>`;
    return [ways[0] && ways[0][1] ? box('message', ways[0][0], r.message) : '', ways[1] && ways[1][1] ? box('messageEnd', ways[1][0], r.messageEnd || '') : ''].join('');
  }

  function renderPreview() {
    const el = $('#preview', root);
    if (!el) return;
    if (!preview) el.innerHTML = '<div class="small faint">Working out the message…</div>';
    else if (preview.error) el.innerHTML = `<div class="small" style="color:var(--danger)">${esc(preview.error)}</div>`;
    else el.innerHTML = `${preview.texts.map((t) => `<div class="wa-bubble">${waFormat(t)}</div>`).join('')}${preview.quietNow ? '<div class="small faint">It is quiet hours now.</div>' : ''}`;
  }

  function renderEditor() {
    const el = $('#editor', root);
    if (!editing) {
      el.innerHTML = '';
      return;
    }
    const r = editing.draft;
    el.innerHTML = `<form class="card editor" novalidate>
      <div class="card-head"><h2>${editing.id ? 'Edit notification' : 'New notification'}</h2></div>
      <div class="notify-editor">
        <div>
          <div class="form-grid">
            <label class="field">Notify me about${sel('type', r.type, KINDS.map(([k, l]) => [k, l]))}</label>
            <label class="field">Name<input type="text" data-f="name" value="${esc(r.name)}" maxlength="120" placeholder="e.g. Grid is back"></label>
            ${stations.length > 1 && !['collector', 'device', 'automation', 'inverter'].includes(r.type) ? `<label class="field">Inverter / station${sel('stationId', r.stationId || '', stations.map((s) => [s.id, s.name]))}</label>` : ''}
          </div>
          <p class="small faint" style="margin:6px 0 12px">${esc((KINDS.find((k) => k[0] === r.type) || [])[2] || '')}</p>
          ${typeFields(r)}
          <h3 class="edit-h">Send to</h3>
          ${data.recipients.length ? `<div class="row" style="gap:6px 16px">${data.recipients.map((x) => `<label class="check small"><input type="checkbox" data-recipient="${x.id}" ${r.recipients.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}${x.enabled ? '' : ' <span class="faint">(off)</span>'}</label>`).join('')}</div>
            <p class="small faint" style="margin:4px 0 0">${r.recipients.length ? '' : 'None ticked: everyone who is turned on.'}</p>` : '<p class="small muted">Add recipients first (above).</p>'}
          <h3 class="edit-h">Message <span class="small muted" style="font-weight:400">optional — leave empty for the standard one</span></h3>
          ${messageFields(r)}
          <div class="chips" style="margin-top:6px"><span class="small faint">Insert:</span>${Object.entries(data.placeholders).map(([k, d]) => `<button type="button" class="chip" data-ph="${k}" title="${esc(d)}">{${k}}</button>`).join('')}</div>
          <div class="edit-options">
            <label class="check small">Send at most once every ${numIn('cooldownMinutes', r.cooldownMinutes, 0, 1440)} minutes <span class="faint">(0 = no limit)</span></label>
            <label class="check small">During quiet hours: ${sel('quiet', r.quiet, QUIET)}</label>
            ${check('enabled', r.enabled, 'Notification on')}
          </div>
        </div>
        <div class="notify-preview"><div class="small muted" style="margin-bottom:6px">Preview <span class="faint">(with today’s values)</span></div><div id="preview"></div></div>
      </div>
      <div class="form-error" id="edit-error"></div>
      <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">${icon('save')} Save</button></div>
    </form>`;
    renderPreview();
  }

  const runPreview = debounce(async () => {
    if (!editing) return;
    try {
      preview = await api.post('/api/notifications/preview', editing.draft);
    } catch (err) {
      preview = { error: err.message };
    }
    renderPreview();
  }, 500);

  function openEditor(id, draft) {
    const n = id ? data.rules.find((x) => x.id === id) : null;
    const base = n ? { ...n.rule, name: n.name, enabled: n.enabled } : { ...defaults('source'), enabled: true };
    editing = { id: id || null, draft: JSON.parse(JSON.stringify({ ...base, ...(draft || {}) })) };
    preview = null;
    renderEditor();
    renderRules();
    $('#editor', root).scrollIntoView({ behavior: 'smooth', block: 'start' });
    runPreview();
  }

  function readValue(el) {
    const f = el.dataset.f;
    if (el.type === 'checkbox') return el.checked;
    const v = el.value;
    if (['value', 'holdMinutes', 'minutes', 'errors', 'cooldownMinutes'].includes(f)) return v === '' ? '' : Number(v);
    if (['channel', 'metricId', 'automationId'].includes(f)) return v === '' ? null : Number(v);
    if (f === 'levels') return v.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (f === 'deviceId' || f === 'stationId') return v || null;
    return v;
  }

  function onEdit(e) {
    if (!editing) return;
    const el = e.target;
    const r = editing.draft;
    const row = el.closest('.edit-row[data-kind="cond"]');
    let rerender = false;
    if (el.dataset.recipient) {
      const id = el.dataset.recipient;
      r.recipients = el.checked ? [...new Set([...r.recipients, id])] : r.recipients.filter((x) => x !== id);
      rerender = true;
    } else if (el.dataset.sday) {
      const d = Number(el.dataset.sday);
      r.days = el.checked ? [...new Set([...r.days, d])].sort() : r.days.filter((x) => x !== d);
    } else if (row && el.dataset.day) {
      const x = r.conditions[Number(row.dataset.i)];
      const d = Number(el.dataset.day);
      x.days = el.checked ? [...new Set([...x.days, d])].sort() : x.days.filter((y) => y !== d);
    } else if (!el.dataset.f) return;
    else if (row) {
      const i = Number(row.dataset.i);
      const f = el.dataset.f;
      const v = f === 'type' ? el.value : readValue(el);
      r.conditions[i] = kit.changed(r.conditions[i], f, f === 'deviceId' ? el.value : v);
      rerender = f === 'type' || f === 'deviceId';
    } else if (el.dataset.f === 'type') {
      // A new kind of rule: its own fields, and its standard name unless one was typed.
      const keepName = r.name && !KINDS.some(([k]) => defaults(k).name === r.name);
      editing.draft = { ...defaults(el.value), name: keepName ? r.name : defaults(el.value).name, enabled: r.enabled, recipients: r.recipients, message: r.message, messageEnd: r.messageEnd, cooldownMinutes: r.cooldownMinutes };
      rerender = true;
    } else {
      r[el.dataset.f] = readValue(el);
      rerender = ['source', 'on', 'off', 'up', 'down', 'whenStops', 'whenBack', 'offline', 'online'].includes(el.dataset.f);
    }
    if (rerender && e.type === 'change') renderEditor();
    runPreview();
  }

  let lastBox = null; // the message box placeholders go into
  root.addEventListener('focusin', (e) => {
    if (e.target.tagName === 'TEXTAREA' && e.target.closest('.editor')) lastBox = e.target;
  });
  root.addEventListener('input', (e) => {
    if (e.target.closest('.editor') && (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox'))) onEdit(e);
  });
  root.addEventListener('change', (e) => {
    if (e.target.closest('.editor')) onEdit(e);
    else if (e.target.id === 'group-pick') {
      const opt = e.target.selectedOptions[0];
      const f = $('#recipient-form', root);
      if (opt && opt.value) {
        f.number.value = opt.value;
        if (!f.name.value) f.name.value = opt.textContent;
      }
    }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      if (form.closest('.editor')) {
        if (editing.id) await api.put(`/api/notifications/rules/${editing.id}`, editing.draft);
        else await api.post('/api/notifications/rules', editing.draft);
        toast('Notification saved. It is checked within a minute.', 'ok');
        editing = null;
        preview = null;
        await reload();
      } else if (form.id === 'waha-form') {
        const r = await api.put('/api/notifications/waha', wahaPayload());
        data.waha = r.waha;
        await checkWaha();
        renderWaha();
        renderRecipients();
        renderBanner();
        toast(session && session.ok ? 'WAHA saved and connected' : 'WAHA settings saved', session && session.error ? 'err' : 'ok');
      } else if (form.id === 'recipient-form') {
        const name = form.name.value.trim();
        const number = form.number.value.trim();
        if (!number) return toast('Enter a WhatsApp number or pick a group', 'err');
        if (data.waha.configured && !number.includes('@')) {
          const c = await api.post('/api/notifications/waha/check', { number }).catch(() => null);
          if (c && !c.exists && !(await confirmDialog('Not on WhatsApp?', `WAHA says ${number} is not on WhatsApp. Add it anyway?`, 'Add anyway'))) return;
        }
        await saveRecipients([...data.recipients, { name, chatId: number, enabled: true }]);
        toast(`${name || number} added`, 'ok');
      } else if (form.id === 'options-form') {
        const r = await api.put('/api/notifications/options', { enabled: form.enabled.checked, quietFrom: form.quietFrom.value, quietTo: form.quietTo.value, title: form.title.value });
        data.options = r.options;
        renderOptions();
        renderBanner();
        renderRules();
        toast('Saved', 'ok');
      }
    } catch (err) {
      if (form.closest('.editor')) $('#edit-error', root).textContent = err.message;
      else toast(err.message, 'err');
    }
  });

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.preset) {
        const p = PRESETS.find((x) => x.key === t.dataset.preset);
        openEditor(null, { ...p.build(), enabled: true });
      } else if (t.dataset.ph) {
        const ta = (lastBox && lastBox.isConnected && lastBox) || $('.editor textarea', root);
        if (!ta) return;
        const ins = `{${t.dataset.ph}}`;
        const at = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd ?? at);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = at + ins.length;
        editing.draft[ta.dataset.f] = ta.value;
        runPreview();
      } else if (t.dataset.add === 'cond') {
        const r = editing.draft;
        r.conditions.push(kit.defaults(r.conditions.some((x) => x.type === 'time') ? 'soc' : 'time'));
        renderEditor();
        runPreview();
      } else if (t.dataset.remove === 'cond') {
        editing.draft.conditions.splice(Number(t.dataset.i), 1);
        renderEditor();
        runPreview();
      } else if (t.hasAttribute('data-cancel')) {
        editing = null;
        preview = null;
        renderEditor();
        renderRules();
      } else if (t.dataset.edit) {
        openEditor(Number(t.dataset.edit));
      } else if (t.dataset.enable) {
        const n = data.rules.find((x) => x.id === Number(t.dataset.enable));
        await api.post(`/api/notifications/rules/${n.id}/enabled`, { enabled: !n.enabled });
        await reload();
      } else if (t.dataset.test) {
        t.disabled = true;
        const r = await api.post(`/api/notifications/rules/${t.dataset.test}/test`).finally(() => (t.disabled = false));
        toast(r.status === 'sent' ? `Test sent to ${r.recipients} recipient${r.recipients > 1 ? 's' : ''}` : r.message, r.status === 'sent' ? 'ok' : 'err');
        await reload();
      } else if (t.dataset.del) {
        const n = data.rules.find((x) => x.id === Number(t.dataset.del));
        if (!(await confirmDialog('Delete notification', `Delete “${n.name}”?`, 'Delete'))) return;
        await api.del(`/api/notifications/rules/${n.id}`);
        await reload();
      } else if (t.dataset.rToggle) {
        await saveRecipients(data.recipients.map((x) => (x.id === t.dataset.rToggle ? { ...x, enabled: !x.enabled } : x)));
      } else if (t.dataset.rDel) {
        const x = data.recipients.find((y) => y.id === t.dataset.rDel);
        if (!(await confirmDialog('Remove recipient', `Stop sending messages to ${x.name}?`, 'Remove'))) return;
        await saveRecipients(data.recipients.filter((y) => y.id !== x.id));
      } else if (t.dataset.rTest) {
        t.disabled = true;
        const r = await api.post('/api/notifications/test', { recipientIds: [t.dataset.rTest] }).finally(() => (t.disabled = false));
        toast(r.status === 'sent' ? 'Test message sent' : r.message, r.status === 'sent' ? 'ok' : 'err');
        await reload();
      } else if (t.id === 'waha-test') {
        t.disabled = true;
        await checkWaha(wahaPayload()).finally(() => (t.disabled = false));
        renderWaha();
        renderBanner();
        if (session.error) toast(session.error, 'err');
        else toast(session.ok ? `Connected: session ${session.session.name} is working` : `Reached WAHA, but the session is ${session.session.status}`, session.ok ? 'ok' : 'err');
      } else if (t.id === 'load-groups') {
        t.disabled = true;
        const r = await api.get('/api/notifications/waha/groups').finally(() => (t.disabled = false));
        const pick = $('#group-pick', root);
        pick.innerHTML = `<option value="">${r.groups.length ? 'Choose a group…' : 'No groups found'}</option>${r.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}`;
        pick.classList.remove('hidden');
      } else if (t.id === 'turn-on') {
        data.options = (await api.put('/api/notifications/options', { enabled: true })).options;
        renderOptions();
        renderBanner();
      } else if (t.id === 'clear-log') {
        if (!(await confirmDialog('Clear messages', 'Remove the list of sent messages? Messages still waiting to be sent are kept.', 'Clear'))) return;
        await api.del('/api/notifications/log');
        await reload();
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#new-rule', ctx.actions).onclick = () => openEditor(null);
  $('#test-msg', ctx.actions).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.post('/api/notifications/test', {});
      toast(r.status === 'sent' ? `Test sent to ${r.recipients} recipient${r.recipients > 1 ? 's' : ''}` : r.message, r.status === 'sent' ? 'ok' : 'err');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };

  async function reload() {
    data = await api.get('/api/notifications');
    renderBanner();
    renderEditor();
    renderRules();
    renderLog();
  }

  renderBanner();
  renderWaha();
  renderRecipients();
  renderOptions();
  renderRules();
  renderLog();
  checkWaha().then(() => {
    renderWaha();
    renderBanner();
  });
  const timer = setInterval(async () => {
    try {
      const d = await api.get('/api/notifications');
      data = { ...d };
      if (!editing) renderRules();
      renderLog();
    } catch {}
  }, 20000);
  return () => clearInterval(timer);
}

/** WhatsApp's *bold* and _italic_, on escaped text. */
function waFormat(text) {
  return esc(text)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>');
}
