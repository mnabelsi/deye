import { api } from '../api.js';
import { $, esc, icon, toast, modal, confirmDialog, fmtTime, fmtAgo, localDateStr } from '../util.js';

const REGIONS = [
  ['https://eu1-developer.deyecloud.com/v1.0', 'Europe / Asia / Africa (eu1)'],
  ['https://us1-developer.deyecloud.com/v1.0', 'Americas (us1)'],
];

function statusBadge(s) {
  const cls = { ok: 'ok', error: 'err', partial: 'warn', running: 'info', skipped: '' }[s] || '';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

export async function mount(root, ctx) {
  const isAdmin = ctx.user.isAdmin;
  let settings = null;
  let status = null;
  let timer = null;

  root.innerHTML = `
    <div class="stack">
      ${ctx.user.mustChangePassword ? `<div class="alert warn">${icon('warn')}<div class="grow"><b>You are still using the default password.</b> Change it below to keep your dashboard safe.</div></div>` : ''}
      ${isAdmin ? `
      <div class="card" id="deye-card">
        <div class="card-head"><h2>${icon('plug', 'style="width:16px;height:16px;vertical-align:-3px"')} DeyeCloud connection</h2><span id="conn-badge"></span></div>
        <p class="small muted">Create an application in the <a href="https://developer.deyecloud.com/app" target="_blank" rel="noopener">DeyeCloud developer portal</a> to get an App ID and App Secret, then sign in with the same account you use on deyecloud.com.</p>
        <form id="deye-form" class="stack" autocomplete="off" novalidate>
          <div class="form-grid">
            <label class="field">Data center
              <select name="baseUrl">${REGIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}<option value="custom">Custom URL…</option></select>
            </label>
            <label class="field hidden" id="custom-url-field">Custom base URL<input type="text" name="customUrl" placeholder="https://…/v1.0"></label>
            <label class="field">App ID<input type="text" name="appId" spellcheck="false"></label>
            <label class="field">App Secret <span class="hint" id="secret-hint"></span><input type="password" name="appSecret" autocomplete="new-password" placeholder="••••••••"></label>
          </div>
          <div class="form-grid">
            <label class="field">Sign in with
              <select name="loginType"><option value="email">Email</option><option value="username">Username</option><option value="mobile">Mobile number</option></select>
            </label>
            <label class="field" data-login="email">Email<input type="email" name="email" spellcheck="false"></label>
            <label class="field" data-login="username">Username<input type="text" name="username" spellcheck="false"></label>
            <label class="field" data-login="mobile">Mobile<input type="text" name="mobile" spellcheck="false"></label>
            <label class="field" data-login="mobile">Country code<input type="text" name="countryCode" placeholder="e.g. 961"></label>
            <label class="field">DeyeCloud password <span class="hint" id="pw-hint"></span><input type="password" name="password" autocomplete="new-password" placeholder="••••••••"></label>
            <label class="field"><span>Company ID <span class="hint">(optional, business accounts)</span></span><input type="text" name="companyId" placeholder="leave empty for personal"></label>
          </div>
          <p class="small faint">Your DeyeCloud password is stored only as the SHA-256 hash the API requires. Secrets are never sent back to the browser.</p>
          <div class="row">
            <button type="submit" class="btn primary">${icon('save')} Save connection</button>
            <button type="button" class="btn" id="test-btn">${icon('plug')} Test connection</button>
            <span id="test-result" class="small"></span>
          </div>
        </form>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h2>Data collection</h2></div>
          <form id="collect-form" class="stack" novalidate>
            <div class="form-grid">
              <label class="field"><span>Poll every <span class="hint">minutes</span></span><input type="number" name="pollIntervalMinutes" min="1" max="60"></label>
              <label class="field"><span>Refresh station list every <span class="hint">minutes</span></span><input type="number" name="stationRefreshMinutes" min="10" max="1440"></label>
              <label class="field"><span>Refresh daily energy every <span class="hint">minutes</span></span><input type="number" name="dailyRefreshMinutes" min="10" max="1440"></label>
              <label class="field"><span>Keep readings for <span class="hint">days, 0 = forever</span></span><input type="number" name="retentionDays" min="0"></label>
              <label class="field"><span>History import speed <span class="hint">downloads per run</span></span><input type="number" name="backfillPerTick" min="1" max="50"></label>
            </div>
            <label class="check"><input type="checkbox" name="autoGapFill"> Automatically re-import missed periods from DeyeCloud history (e.g. after the app was asleep)</label>
            <div class="row">
              <button class="btn primary" type="submit">${icon('save')} Save</button>
              <button class="btn" type="button" id="run-now">${icon('refresh')} Collect now</button>
              <button class="btn" type="button" id="discover">${icon('device')} Re-discover devices</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-head"><h2>${icon('history', 'style="width:16px;height:16px;vertical-align:-3px"')} Import history</h2></div>
          <p class="small muted">DeyeCloud keeps detailed history for every measure point. Import a date range and the collector downloads it day by day in the background — it resumes automatically after restarts.</p>
          <form id="backfill-form" class="row" novalidate>
            <label class="field" style="flex:1">From<input type="date" name="from" required></label>
            <label class="field" style="flex:1">To<input type="date" name="to" required></label>
            <button class="btn primary" type="submit" style="align-self:flex-end">Import</button>
          </form>
          <div id="backfill-status" style="margin-top:14px"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Collector activity</h2><span id="sched-info" class="small muted"></span></div>
        <div id="runs"></div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h2>Cron job (recommended on shared hosting)</h2></div>
          <p class="small muted">Shared hosting can put idle Node.js apps to sleep. Add a cron job in hPanel that calls this URL every 5 minutes so collection never stops:</p>
          <div class="copy-field"><input type="text" id="cron-url" readonly><button class="btn icon" id="copy-cron" title="Copy">${icon('copy')}</button></div>
          <p class="small faint" style="margin-top:8px">Command example: <code id="cron-cmd"></code></p>
          <button class="btn sm" id="rotate-key" style="margin-top:6px">Generate a new key</button>
        </div>
        <div class="card">
          <div class="card-head"><h2>${icon('database', 'style="width:16px;height:16px;vertical-align:-3px"')} Database</h2></div>
          <dl class="kv" id="db-stats"></dl>
        </div>
      </div>` : ''}

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h2>Change your password</h2></div>
          <form id="pw-form" class="stack" novalidate>
            <label class="field">Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label>
            <label class="field">New password<input type="password" name="newPassword" autocomplete="new-password" minlength="6" required></label>
            <label class="field">Confirm new password<input type="password" name="confirm" autocomplete="new-password" required></label>
            <div class="row"><button class="btn primary" type="submit">Update password</button></div>
          </form>
        </div>
        ${isAdmin ? `<div class="card">
          <div class="card-head"><h2>Users</h2><button class="btn sm" id="add-user">${icon('plus')} Add user</button></div>
          <div id="users"></div>
        </div>` : ''}
      </div>
    </div>`;

  // ---------- password ----------
  $('#pw-form', root).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.newPassword.value !== f.confirm.value) return toast('New passwords do not match', 'err');
    try {
      await api.post('/api/auth/password', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
      f.reset();
      ctx.user.mustChangePassword = false;
      toast('Password updated', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  if (!isAdmin) return;

  // ---------- DeyeCloud form ----------
  const form = $('#deye-form', root);
  function showLoginFields() {
    const type = form.loginType.value;
    root.querySelectorAll('[data-login]').forEach((el) => el.classList.toggle('hidden', el.dataset.login !== type));
    $('#custom-url-field', root).classList.toggle('hidden', form.baseUrl.value !== 'custom');
  }
  form.loginType.onchange = showLoginFields;
  form.baseUrl.onchange = showLoginFields;

  function fillDeye() {
    const d = settings.deye;
    const known = REGIONS.some(([v]) => v === d.baseUrl);
    form.baseUrl.value = known ? d.baseUrl : 'custom';
    form.customUrl.value = known ? '' : d.baseUrl;
    form.appId.value = d.appId || '';
    form.appSecret.value = '';
    form.loginType.value = d.loginType || 'email';
    form.email.value = d.email || '';
    form.username.value = d.username || '';
    form.mobile.value = d.mobile || '';
    form.countryCode.value = d.countryCode || '';
    form.password.value = '';
    form.companyId.value = d.companyId || '';
    $('#secret-hint', root).textContent = d.appSecretSet ? '(saved — leave empty to keep)' : '';
    $('#pw-hint', root).textContent = d.passwordSet ? '(saved — leave empty to keep)' : '';
    $('#conn-badge', root).innerHTML = d.configured ? '<span class="badge ok">Configured</span>' : '<span class="badge warn">Not configured</span>';
    showLoginFields();

    const c = settings.collection;
    const cf = $('#collect-form', root);
    cf.pollIntervalMinutes.value = c.pollIntervalMinutes;
    cf.stationRefreshMinutes.value = c.stationRefreshMinutes;
    cf.dailyRefreshMinutes.value = c.dailyRefreshMinutes;
    cf.retentionDays.value = c.retentionDays;
    cf.backfillPerTick.value = c.backfillPerTick;
    cf.autoGapFill.checked = c.autoGapFill;

    $('#cron-url', root).value = settings.cronUrl;
    $('#cron-cmd', root).textContent = `wget -q -O /dev/null "${settings.cronUrl}"`;
  }

  function deyePayload() {
    return {
      baseUrl: form.baseUrl.value === 'custom' ? form.customUrl.value.trim() : form.baseUrl.value,
      appId: form.appId.value.trim(),
      appSecret: form.appSecret.value,
      loginType: form.loginType.value,
      email: form.email.value.trim(),
      username: form.username.value.trim(),
      mobile: form.mobile.value.trim(),
      countryCode: form.countryCode.value.trim(),
      password: form.password.value,
      companyId: form.companyId.value.trim(),
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      settings = await api.put('/api/settings', { deye: deyePayload() });
      fillDeye();
      toast('Connection saved. Collecting data…', 'ok');
      api.post('/api/collector/run', { discover: true }).then(() => {
        ctx.store.sources(true);
        ctx.store.refreshStatus();
        loadStatus();
      }).catch((err) => toast(err.message, 'err'));
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#test-btn', root).onclick = async () => {
    const out = $('#test-result', root);
    out.innerHTML = '<span class="spinner sm" style="display:inline-block;vertical-align:middle"></span> Testing…';
    try {
      const r = await api.post('/api/settings/test', { deye: deyePayload() });
      out.innerHTML = `<span class="badge ok">${icon('check', 'style="width:12px;height:12px"')} Connected</span> ${esc(r.message)}`;
    } catch (err) {
      out.innerHTML = `<span class="badge err">Failed</span> ${esc(err.message)}`;
    }
  };

  // ---------- collection ----------
  $('#collect-form', root).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      settings = await api.put('/api/settings', {
        collection: {
          pollIntervalMinutes: f.pollIntervalMinutes.value,
          stationRefreshMinutes: f.stationRefreshMinutes.value,
          dailyRefreshMinutes: f.dailyRefreshMinutes.value,
          retentionDays: f.retentionDays.value,
          backfillPerTick: f.backfillPerTick.value,
          autoGapFill: f.autoGapFill.checked,
        },
      });
      fillDeye();
      toast('Collection settings saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  async function runAction(btn, url, body, okMsg) {
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = '<span class="spinner sm"></span> Working…';
    try {
      const r = await api.post(url, body);
      toast(r.message || okMsg, r.status === 'error' ? 'err' : 'ok');
      await ctx.store.sources(true);
      ctx.store.refreshStatus();
      loadStatus();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
  $('#run-now', root).onclick = (e) => runAction(e.currentTarget, '/api/collector/run', {}, 'Collection finished');
  $('#discover', root).onclick = (e) => runAction(e.currentTarget, '/api/collector/run', { discover: true }, 'Discovery finished');

  // ---------- backfill ----------
  const bf = $('#backfill-form', root);
  const today = new Date();
  bf.to.value = localDateStr(today);
  bf.from.value = localDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7));
  bf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/collector/backfill', { from: bf.from.value, to: bf.to.value });
      toast(r.message, 'ok');
      loadStatus();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  function renderBackfill(b) {
    const total = b.pending + b.done + b.error + b.running;
    const pct = total ? Math.round(((b.done + b.error) / total) * 100) : 0;
    $('#backfill-status', root).innerHTML = total
      ? `<div class="row small" style="margin-bottom:6px"><b>${b.done.toLocaleString()} / ${total.toLocaleString()} downloads done</b>
          ${b.error ? `<span class="badge err">${b.error} failed</span>` : ''}${b.pending ? `<span class="badge info">${b.pending} queued</span>` : ''}
          <span class="spacer"></span>
          ${b.error ? '<button class="btn sm" id="bf-retry">Retry failed</button>' : ''}
          ${b.pending || b.error || b.done ? '<button class="btn sm ghost" id="bf-clear">Clear list</button>' : ''}</div>
         <div class="progress"><span style="width:${pct}%"></span></div>
         ${b.lastError ? `<p class="small faint" style="margin-top:6px">Last error: ${esc(b.lastError)}</p>` : ''}
         ${b.pending ? `<p class="small faint" style="margin-top:6px">Runs in the background, up to ${esc(settings.collection.backfillPerTick)} download(s) per minute — one per day for each station and device.</p>` : ''}`
      : '<p class="small faint">No imports yet.</p>';
    const retry = $('#bf-retry', root);
    if (retry) retry.onclick = () => api.post('/api/collector/backfill/retry').then(loadStatus);
    const clear = $('#bf-clear', root);
    if (clear) clear.onclick = async () => {
      if (await confirmDialog('Clear import list', 'Remove queued and finished import entries? Imported readings are kept.', 'Clear')) {
        await api.post('/api/collector/backfill/clear');
        loadStatus();
      }
    };
  }

  // ---------- status ----------
  async function loadStatus() {
    status = await api.get('/api/collector/status');
    renderBackfill(status.backfill);
    $('#sched-info', root).textContent = status.schedulerEnabled
      ? `Built-in scheduler on · every ${status.pollIntervalMinutes} min${status.nextRunTs ? ` · next ${fmtTime(status.nextRunTs, { timeStyle: 'short' })}` : ''}`
      : 'Built-in scheduler disabled — relying on cron';
    $('#runs', root).innerHTML = status.runs.length
      ? `<div class="table-wrap" style="max-height:340px"><table class="table">
          <thead><tr><th>Started</th><th>Job</th><th>Trigger</th><th>Status</th><th class="num">Readings</th><th class="num">Duration</th><th>Details</th></tr></thead>
          <tbody>${status.runs
            .map(
              (r) => `<tr><td class="nowrap small" title="${esc(fmtTime(r.startedTs))}">${esc(fmtAgo(r.startedTs))}</td><td>${esc(r.kind)}</td><td class="small muted">${esc(r.trigger || '')}</td>
                <td>${statusBadge(r.status)}</td><td class="num">${r.readingsAdded.toLocaleString()}</td>
                <td class="num small">${r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)} s` : '—'}</td>
                <td class="small muted" style="max-width:420px;overflow-wrap:anywhere">${esc(r.message || '')}</td></tr>`
            )
            .join('')}</tbody></table></div>`
      : '<div class="empty small">No collector runs yet</div>';
    const d = status.db;
    $('#db-stats', root).innerHTML = `
      <dt>Numeric readings</dt><dd>${d.readings.toLocaleString()}</dd>
      <dt>State changes</dt><dd>${d.textReadings.toLocaleString()}</dd>
      <dt>Measure points</dt><dd>${d.metrics.toLocaleString()}</dd>
      <dt>Stations / devices</dt><dd>${d.stations} / ${d.devices}</dd>
      <dt>Oldest reading</dt><dd>${d.oldestTs ? esc(fmtTime(d.oldestTs)) : '—'}</dd>
      <dt>Size on disk</dt><dd>${d.sizeMb !== null ? `${d.sizeMb.toLocaleString()} MB` : '—'}</dd>`;
  }

  $('#copy-cron', root).onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#cron-url', root).value);
      toast('Cron URL copied', 'ok');
    } catch {
      $('#cron-url', root).select();
    }
  };
  $('#rotate-key', root).onclick = async () => {
    if (!(await confirmDialog('New cron key', 'The old cron URL will stop working. Continue?', 'Generate'))) return;
    settings = await api.post('/api/settings/rotate-cron-key');
    fillDeye();
    toast('New cron URL generated — update your cron job', 'ok');
  };

  // ---------- users ----------
  async function loadUsers() {
    const { users } = await api.get('/api/users');
    $('#users', root).innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead>
      <tbody>${users
        .map(
          (u) => `<tr><td><b>${esc(u.username)}</b>${u.id === ctx.user.id ? ' <span class="badge info">you</span>' : ''}</td>
            <td>${u.isAdmin ? 'Admin' : 'Viewer'}</td>
            <td class="small muted">${u.lastLoginAt ? esc(new Date(`${u.lastLoginAt.replace(' ', 'T')}Z`).toLocaleString()) : 'never'}</td>
            <td class="num nowrap"><button class="btn sm ghost" data-reset="${u.id}" data-name="${esc(u.username)}">Reset password</button>
            ${u.id !== ctx.user.id ? `<button class="btn sm ghost danger" data-del="${u.id}" data-name="${esc(u.username)}">${icon('trash')}</button>` : ''}</td></tr>`
        )
        .join('')}</tbody></table></div>`;
  }
  $('#users', root).onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    const reset = e.target.closest('[data-reset]');
    try {
      if (del && (await confirmDialog('Delete user', `Delete user "${del.dataset.name}"?`, 'Delete'))) {
        await api.del(`/api/users/${del.dataset.del}`);
        toast('User deleted', 'ok');
        loadUsers();
      } else if (reset) {
        const r = await modal({ title: `Reset password for ${reset.dataset.name}`, body: '<label class="field">New password<input type="password" name="password" minlength="6" required autocomplete="new-password"></label>' });
        if (r) {
          await api.post(`/api/users/${reset.dataset.reset}/password`, { password: r.password });
          toast('Password changed', 'ok');
        }
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#add-user', root).onclick = async () => {
    const r = await modal({
      title: 'Add user',
      submitLabel: 'Create user',
      body: `<label class="field">Username<input type="text" name="username" required autocomplete="off"></label>
        <label class="field">Password<input type="password" name="password" minlength="6" required autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" name="isAdmin"> Administrator (can change settings and users)</label>`,
    });
    if (!r) return;
    try {
      await api.post('/api/users', r);
      toast('User created', 'ok');
      loadUsers();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  settings = await api.get('/api/settings');
  fillDeye();
  await Promise.all([loadStatus(), loadUsers()]);
  timer = setInterval(() => loadStatus().catch(() => {}), 15000);
  return () => clearInterval(timer);
}
