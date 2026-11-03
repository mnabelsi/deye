import { api } from '../api.js';
import { $, esc, icon, toast, fmtTime, fmtAgo, fmtNumber, confirmDialog } from '../util.js';

// Settings → Smart devices (eWeLink): the app's credentials from dev.ewelink.cc, connecting the
// eWeLink account (OAuth sign-in on eWeLink's page), and how often devices are synced.

const LIVE_STATES = {
  connected: ['ok', 'Connected'],
  connecting: ['info', 'Connecting…'],
  waiting: ['warn', 'Retrying'],
  standby: ['ok', 'Held by another app process'],
  off: ['', 'Off'],
};

export async function mountEwelinkSettings(card, ctx) {
  let s = await api.get('/api/ewelink/status');
  let timer = null;

  // Back from eWeLink's sign-in page.
  const back = ctx.params.get('ewelink');
  if (back === 'connected') toast(`eWeLink connected: found ${ctx.params.get('devices') || 0} device(s)`, 'ok');
  if (back || ctx.params.get('section') === 'ewelink') setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  const backError = back === 'error' ? ctx.params.get('message') || 'Connecting eWeLink failed' : null;
  if (back) history.replaceState(null, '', '#/settings');

  card.innerHTML = `
    <div class="card-head"><h2>${icon('smarthome', 'style="width:16px;height:16px;vertical-align:-3px"')} Smart devices (eWeLink)</h2><span id="ew-badge"></span></div>
    ${backError ? `<div class="alert err" style="margin-bottom:12px">${icon('warn')}<div class="grow">${esc(backError)}</div></div>` : ''}
    <ol class="small muted steps">
      <li>In the <a href="https://dev.ewelink.cc" target="_blank" rel="noopener">eWeLink developer center</a>, create an app (OAuth 2.0) and set its <b>redirect URL</b> to the address below.</li>
      <li>Enter the app's App ID and App Secret here and save.</li>
      <li>Press <b>Connect eWeLink account</b> and sign in with the account your devices are in.</li>
    </ol>
    <form id="ew-form" class="stack" autocomplete="off" novalidate>
      <label class="field">Redirect URL <span class="hint">(enter exactly this in the developer center; change it here only if your site has another address)</span>
        <div class="copy-field"><input type="text" name="redirectUrl" spellcheck="false"><button type="button" class="btn icon" id="ew-copy" title="Copy">${icon('copy')}</button></div></label>
      <div class="form-grid">
        <label class="field">App ID<input type="text" name="appId" spellcheck="false"></label>
        <label class="field">App Secret <span class="hint" id="ew-secret-hint"></span><input type="password" name="appSecret" autocomplete="new-password" placeholder="••••••••"></label>
        <label class="field">Server
          <select name="serverMode"><option value="">eWeLink (region of your account)</option><option value="custom">Custom URL (testing)…</option></select></label>
        <label class="field hidden" id="ew-custom">Custom server URL<input type="text" name="server" placeholder="http://localhost:4200"></label>
      </div>
      <div class="form-grid">
        <label class="field"><span>Sync every <span class="hint">minutes, while the live connection is down</span></span><input type="number" name="pollMinutes" min="2" max="60"></label>
      </div>
      <label class="check"><input type="checkbox" name="live"> Live connection: get device changes instantly over eWeLink's WebSocket (uses almost no API calls)</label>
      <label class="check"><input type="checkbox" name="powerReports"> Keep power-metering plugs reporting power, voltage and current (as the eWeLink app does while a device page is open)</label>
      <div class="row">
        <button type="submit" class="btn">${icon('save')} Save</button>
        <button type="button" class="btn primary" id="ew-connect">${icon('link')} Connect eWeLink account</button>
        <button type="button" class="btn" id="ew-sync">${icon('refresh')} Sync now</button>
        <button type="button" class="btn ghost danger" id="ew-disconnect">Disconnect</button>
      </div>
    </form>
    <dl class="kv" id="ew-status" style="margin-top:16px"></dl>`;

  const form = $('#ew-form', card);
  form.serverMode.onchange = () => $('#ew-custom', card).classList.toggle('hidden', form.serverMode.value !== 'custom');

  function fill() {
    form.redirectUrl.value = s.redirectUrl || '';
    form.appId.value = s.appId || '';
    form.appSecret.value = '';
    form.serverMode.value = s.server ? 'custom' : '';
    form.server.value = s.server || '';
    form.pollMinutes.value = s.pollMinutes;
    form.live.checked = s.liveEnabled;
    form.powerReports.checked = s.powerReports;
    $('#ew-custom', card).classList.toggle('hidden', !s.server);
    $('#ew-secret-hint', card).textContent = s.appSecretSet ? '(saved — leave empty to keep)' : '';
    renderStatus();
  }

  function renderStatus() {
    $('#ew-badge', card).innerHTML = s.reconnectNeeded
      ? '<span class="badge err">Sign-in expired</span>'
      : s.connected
        ? '<span class="badge ok">Connected</span>'
        : s.configured
          ? '<span class="badge warn">Not connected</span>'
          : '<span class="badge">Not set up</span>';
    $('#ew-connect', card).innerHTML = `${icon('link')} ${s.connected ? 'Reconnect' : 'Connect'} eWeLink account`;
    $('#ew-connect', card).disabled = !s.configured;
    $('#ew-sync', card).disabled = !s.connected;
    $('#ew-disconnect', card).classList.toggle('hidden', !s.connected);
    const u = s.usage || { calls: 0, quota: 50000 };
    const pct = Math.min(100, (u.calls / u.quota) * 100);
    const live = s.live || {};
    const [lc, ll] = LIVE_STATES[live.up && live.state !== 'connected' ? 'standby' : live.state] || ['', live.state];
    $('#ew-status', card).innerHTML = s.connected
      ? `${s.reconnectNeeded ? `<dt></dt><dd><div class="alert err small" style="margin:0">${icon('warn')}<div class="grow">eWeLink no longer accepts this sign-in. Press <b>Reconnect eWeLink account</b>.</div></div></dd>` : ''}
        <dt>Account</dt><dd>${esc(`region ${s.region || '—'}`)}${s.connectedBy ? ` · connected by ${esc(s.connectedBy)} ${esc(fmtAgo(s.connectedTs))}` : ''}</dd>
        <dt>Devices</dt><dd>${fmtNumber(s.devices, 0)} (${fmtNumber(s.onlineDevices, 0)} online)${s.totalOnAccount > s.devices ? ` · eWeLink lists ${s.totalOnAccount}; free App IDs only see authorised brands` : ''} · <a href="#/smart">open</a></dd>
        <dt>Last sync</dt><dd>${s.lastSyncTs ? esc(`${fmtTime(s.lastSyncTs)} (${fmtAgo(s.lastSyncTs)})`) : 'never'}${s.lastError ? ` <span class="badge err" title="${esc(s.lastError)}">${esc(s.lastError)}</span>` : ''}</dd>
        <dt>Live connection</dt><dd>${s.liveEnabled ? `<span class="badge ${lc}">${esc(ll)}</span>${live.error && live.state !== 'connected' ? ` <span class="small faint">${esc(live.error)}</span>` : ''}${live.retryAt ? ` <span class="small faint">next try ${esc(fmtTime(live.retryAt, { timeStyle: 'short' }))}</span>` : ''}${live.state === 'off' && !live.up ? ' <span class="small faint">starts within a minute (needs the built-in scheduler)</span>' : ''}` : 'Off'}</dd>
        <dt>API calls this month</dt><dd><div class="row" style="gap:8px"><div class="progress" style="flex:1;min-width:120px"><span style="width:${pct}%"></span></div><span>${fmtNumber(u.calls, 0)} / ${fmtNumber(u.quota, 0)}</span></div>
          ${u.pausedUntil ? `<span class="badge err">Paused until ${esc(fmtTime(u.pausedUntil, { dateStyle: 'medium' }))}</span>` : '<span class="small faint">Free eWeLink App IDs may make 50,000 calls a month.</span>'}</dd>
        <dt>Sign-in valid until</dt><dd>${s.refreshExpiresTs ? esc(fmtTime(s.refreshExpiresTs, { dateStyle: 'medium' })) : '—'} <span class="small faint">(renewed automatically while the app runs)</span></dd>`
      : '';
  }

  function payload() {
    return {
      appId: form.appId.value.trim(),
      appSecret: form.appSecret.value,
      server: form.serverMode.value === 'custom' ? form.server.value.trim() : '',
      redirectUrl: form.redirectUrl.value.trim() === `${location.origin}/api/ewelink/callback` ? '' : form.redirectUrl.value.trim(),
      pollMinutes: form.pollMinutes.value,
      live: form.live.checked,
      powerReports: form.powerReports.checked,
    };
  }

  async function save() {
    s = { ...s, ...(await api.put('/api/ewelink/config', payload())) };
    s = await api.get('/api/ewelink/status');
    fill();
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await save();
      toast('eWeLink settings saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#ew-copy', card).onclick = async () => {
    try {
      await navigator.clipboard.writeText(form.redirectUrl.value);
      toast('Redirect URL copied', 'ok');
    } catch {
      form.redirectUrl.select();
    }
  };
  $('#ew-connect', card).onclick = async () => {
    try {
      if (form.appId.value.trim() !== (s.appId || '') || form.appSecret.value) await save();
      const { url } = await api.post('/api/ewelink/connect');
      location.href = url; // eWeLink's sign-in page sends the browser back to the redirect URL
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#ew-sync', card).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.post('/api/ewelink/sync');
      toast(r.message, 'ok');
      s = await api.get('/api/ewelink/status');
      renderStatus();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  $('#ew-disconnect', card).onclick = async () => {
    if (!(await confirmDialog('Disconnect eWeLink', 'Automations stop switching devices until you connect again. Device history is kept.', 'Disconnect'))) return;
    s = await api.post('/api/ewelink/disconnect');
    s = await api.get('/api/ewelink/status');
    fill();
  };

  fill();
  timer = setInterval(async () => {
    try {
      s = await api.get('/api/ewelink/status');
      renderStatus();
    } catch {}
  }, 15000);
  return () => clearInterval(timer);
}
