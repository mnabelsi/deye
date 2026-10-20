import { api } from '../api.js';
import { $, icon } from '../util.js';

export function renderLogin(onSuccess) {
  $('#app').innerHTML = `
    <div class="login-wrap">
      <section class="login-hero">
        <div class="sun"></div>
        <div class="row" style="gap:12px">
          <img src="/img/icon.svg" alt="" width="40" height="40">
          <b style="font-size:16px">Deye Monitor</b>
        </div>
        <div>
          <h2>Every reading from your Deye inverter, kept forever.</h2>
          <p>Collects live data from DeyeCloud, stores the full history in your own MySQL database and lets you explore it with interactive charts.</p>
          <div class="features">
            <div>${icon('bolt')} Live power flow for PV, battery, grid and load</div>
            <div>${icon('chart')} Zoomable charts for any measure point</div>
            <div>${icon('history')} History import and automatic gap filling</div>
          </div>
        </div>
        <div class="small" style="color:rgba(255,255,255,.55)">Self-hosted · Your data stays yours</div>
      </section>
      <section class="login-panel">
        <div class="login-card">
          <h1>Sign in</h1>
          <p class="muted">Use your dashboard account to continue.</p>
          <form id="login-form" novalidate>
            <label class="field">Username
              <input type="text" name="username" autocomplete="username" required autofocus>
            </label>
            <label class="field">Password
              <input type="password" name="password" autocomplete="current-password" required>
            </label>
            <label class="check"><input type="checkbox" name="remember" checked> Keep me signed in for 30 days</label>
            <div class="form-error" id="login-error"></div>
            <button class="btn primary" type="submit">Sign in</button>
          </form>
        </div>
      </section>
    </div>`;

  const form = $('#login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const err = $('#login-error');
    err.textContent = '';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner sm"></span> Signing in…';
    try {
      const { user } = await api.post('/api/auth/login', {
        username: form.username.value,
        password: form.password.value,
        remember: form.remember.checked,
      });
      await onSuccess(user);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };
}
