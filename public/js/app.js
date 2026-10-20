import { api, setUnauthorizedHandler } from './api.js';
import { $, esc, icon, toast, fmtAgo } from './util.js';
import { refreshAllCharts } from './charts.js';
import { renderLogin } from './views/login.js';
import * as overview from './views/overview.js';
import * as explorer from './views/explorer.js';
import * as energy from './views/energy.js';
import * as devices from './views/devices.js';
import * as settingsView from './views/settings.js';

const ROUTES = {
  overview: { view: overview, title: 'Overview', icon: 'overview' },
  charts: { view: explorer, title: 'Charts', icon: 'chart' },
  energy: { view: energy, title: 'Energy', icon: 'energy' },
  devices: { view: devices, title: 'Devices & Readings', icon: 'device' },
  settings: { view: settingsView, title: 'Settings', icon: 'settings' },
};

const state = {
  user: null,
  sources: null,
  status: null,
  cleanup: null,
  statusTimer: null,
};

export const store = {
  get user() {
    return state.user;
  },
  async sources(force) {
    if (!state.sources || force) state.sources = await api.get('/api/sources');
    return state.sources;
  },
  get status() {
    return state.status;
  },
  refreshStatus: () => refreshStatus(),
};

export function navigate(route, params) {
  const q = params ? new URLSearchParams(params).toString() : '';
  location.hash = `#/${route}${q ? `?${q}` : ''}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, query] = raw.split('?');
  return { name: ROUTES[name] ? name : 'overview', params: new URLSearchParams(query || '') };
}

function applyThemeIcon() {
  const btn = $('#theme-btn');
  if (!btn) return;
  const dark = document.documentElement.getAttribute('data-theme')
    ? document.documentElement.getAttribute('data-theme') === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  btn.innerHTML = icon(dark ? 'sun' : 'moon');
  btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('deye-theme', next);
  } catch {}
  applyThemeIcon();
  refreshAllCharts();
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyThemeIcon();
  refreshAllCharts();
});

function renderLayout() {
  $('#app').innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <img src="/img/icon.svg" alt="">
          <div><div class="brand-name">Deye Monitor</div><div class="brand-sub">Solar · Battery · Grid</div></div>
        </div>
        <nav class="nav">
          ${Object.entries(ROUTES)
            .map(([k, r]) => `<a href="#/${k}" data-route="${k}">${icon(r.icon)}<span>${esc(r.title)}</span></a>`)
            .join('')}
        </nav>
        <div class="sidebar-foot">
          <div class="collector-pill" id="collector-pill" title="Data collector status">
            <span class="dot"></span><span class="label">Collector…</span>
          </div>
          <div class="row" style="padding:0 4px">
            <span class="small muted">${icon('user', 'style="width:14px;height:14px;vertical-align:-2px"')} ${esc(state.user.username)}</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" id="logout-btn" title="Sign out">${icon('logout')}</button>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn icon ghost menu-btn" id="menu-btn" aria-label="Menu">${icon('menu')}</button>
          <h1 id="page-title"></h1>
          <div class="actions">
            <div id="page-actions" class="row"></div>
            <button class="btn icon ghost" id="theme-btn"></button>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>`;
  applyThemeIcon();
  $('#theme-btn').onclick = toggleTheme;
  $('#menu-btn').onclick = () => $('.layout').classList.toggle('nav-open');
  // Mobile drawer: close after picking a page or when tapping outside it.
  $('.layout').addEventListener('click', (e) => {
    const layout = $('.layout');
    if (!layout.classList.contains('nav-open')) return;
    if (e.target.closest('.nav a') || (!e.target.closest('.sidebar') && !e.target.closest('#menu-btn'))) {
      layout.classList.remove('nav-open');
    }
  });
  $('#logout-btn').onclick = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    location.hash = '';
    location.reload();
  };
}

async function refreshStatus() {
  try {
    state.status = await api.get('/api/collector/status', { brief: 1 });
  } catch {
    return;
  }
  const pill = $('#collector-pill');
  if (!pill) return;
  const s = state.status;
  const dot = pill.querySelector('.dot');
  const label = pill.querySelector('.label');
  dot.className = 'dot';
  if (!s.configured) {
    dot.classList.add('warn');
    label.textContent = 'DeyeCloud not configured';
  } else if (s.lastPoll && s.lastPoll.status === 'error') {
    dot.classList.add('err');
    label.textContent = `Error ${fmtAgo(s.lastPoll.finishedTs)}`;
  } else if (s.lastPoll) {
    const stale = Date.now() / 1000 - (s.lastPoll.finishedTs || 0) > Math.max(3 * 60 * s.pollIntervalMinutes, 1800);
    dot.classList.add(stale ? 'warn' : 'ok');
    label.textContent = `Updated ${fmtAgo(s.lastPoll.finishedTs)}`;
  } else {
    dot.classList.add('warn');
    label.textContent = 'Waiting for first run';
  }
  if (s.backfillPending) label.textContent += ` · importing ${s.backfillPending}`;
}

async function route() {
  if (!state.user) return;
  const { name, params } = parseHash();
  const r = ROUTES[name];
  if (state.cleanup) {
    try {
      state.cleanup();
    } catch (e) {
      console.error(e);
    }
    state.cleanup = null;
  }
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#page-title').textContent = r.title;
  $('#page-actions').innerHTML = '';
  document.title = `${r.title} · Deye Monitor`;
  const content = $('#content');
  content.innerHTML = '<div class="boot" style="min-height:40vh"><div class="spinner"></div></div>';
  const ctx = {
    params,
    user: state.user,
    actions: $('#page-actions'),
    setTitle: (t) => ($('#page-title').textContent = t),
    navigate,
    store,
  };
  try {
    state.cleanup = (await r.view.mount(content, ctx)) || null;
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="alert err">${icon('warn')}<div class="grow"><b>Could not load this page.</b><br>${esc(err.message)}</div></div>`;
  }
}

async function start(user) {
  state.user = user;
  renderLayout();
  window.addEventListener('hashchange', route);
  await refreshStatus();
  state.statusTimer = setInterval(refreshStatus, 60000);
  if (!location.hash) location.hash = '#/overview';
  else route();
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  state.user = null;
  clearInterval(state.statusTimer);
  toast('Your session has expired. Please sign in again.', 'err');
  renderLogin(start);
});

(async function boot() {
  try {
    const { user } = await api.get('/api/auth/me');
    if (!user) return renderLogin(start);
    await start(user);
  } catch {
    renderLogin(start);
  }
})();
