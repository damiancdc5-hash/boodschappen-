// App-schil: inloggen, huishouden kiezen, navigatie en routering.
import { sb, state, initAuth, loadHouseholds, loadMembers, onChange, emit, outboxCount, flushOutbox, getConfig } from './api.js';
import { html, setHTML, $, toast, errorText } from './ui.js';

export const NAV = [
  { id: 'dashboard', label: 'Overzicht', icon: '🏠' },
  { id: 'lijst', label: 'Lijst', icon: '🛒' },
  { id: 'aanbiedingen', label: 'Aanbiedingen', icon: '🏷️' },
  { id: 'prijzen', label: 'Prijzen', icon: '€' },
  { id: 'recepten', label: 'Recepten', icon: '📖' },
  { id: 'weekmenu', label: 'Weekmenu', icon: '🗓️' },
  { id: 'voorraad', label: 'Voorraad', icon: '🥫' },
  { id: 'budget', label: 'Budget', icon: '📊' },
  { id: 'route', label: 'Route', icon: '🗺️' },
  { id: 'instellingen', label: 'Huishouden', icon: '⚙️' },
];
const BOTTOM = ['dashboard', 'lijst', 'aanbiedingen', 'prijzen', 'meer'];

const VIEWS = {
  dashboard: () => import('./views/dashboard.js'),
  lijst: () => import('./views/list.js'),
  aanbiedingen: () => import('./views/offers.js'),
  prijzen: () => import('./views/prices.js'),
  recepten: () => import('./views/recipes.js'),
  weekmenu: () => import('./views/planner.js'),
  voorraad: () => import('./views/pantry.js'),
  budget: () => import('./views/budget.js'),
  route: () => import('./views/route.js'),
  instellingen: () => import('./views/settings.js'),
  meer: () => import('./views/more.js'),
  login: () => import('./views/auth.js'),
  'nieuw-wachtwoord': () => import('./views/auth.js'),
  start: () => import('./views/onboarding.js'),
  setup: () => import('./views/setup.js'),
};

let cleanup = null;
let renderToken = 0;

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [route, ...rest] = h.split('/');
  return { route: route || 'dashboard', params: rest.map(decodeURIComponent) };
}

export function go(route) { location.hash = '#/' + route; }

async function render() {
  const token = ++renderToken;
  let { route, params } = parseHash();
  if (route === 'join' && params[0]) { sessionStorage.setItem('bs.joinCode', params[0].toUpperCase()); route = state.user ? 'start' : 'login'; }
  if (!sb) route = 'setup';
  else if (!state.user && route !== 'nieuw-wachtwoord') route = 'login';
  else if (state.user && !state.household && !['nieuw-wachtwoord', 'start'].includes(route)) route = 'start';
  else if (state.user && route === 'login') route = 'dashboard';
  if (!VIEWS[route]) route = 'dashboard';

  // open dialogen horen bij de vorige pagina
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  document.body.classList.remove('no-scroll');
  renderChrome(route);
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  const view = $('#view');
  try {
    const mod = await VIEWS[route]();
    if (token !== renderToken) return;
    // Elke weergave krijgt een eigen container: late updates van een vorige weergave komen in een losgekoppeld element terecht.
    view.innerHTML = '';
    const container = document.createElement('div');
    view.appendChild(container);
    const off = (await mod.render(container, { route, params, go })) || null;
    if (token !== renderToken) { if (off) off(); return; }
    cleanup = off;
    view.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    setHTML(view, html`<div class="card error"><h2>Er ging iets mis</h2><p>${errorText(e)}</p><button class="btn" onclick="location.reload()">Opnieuw laden</button></div>`);
  }
}

function renderChrome(route) {
  const inApp = state.user && state.household;
  document.body.classList.toggle('bare', !inApp);
  if (!inApp) return;
  const active = NAV.some((n) => n.id === route) ? route : (route === 'meer' ? 'meer' : 'dashboard');
  setHTML($('#sidenav'), html`<div class="brand"><img src="icons/icon-192.png" alt=""><span>Boodschappen</span></div>
    ${NAV.map((n) => html`<a href="#/${n.id}" class="${active === n.id ? 'active' : ''}"><span class="ni">${n.icon}</span>${n.label}</a>`)}`);
  const bottom = BOTTOM.map((id) => id === 'meer' ? { id, label: 'Meer', icon: '☰' } : NAV.find((n) => n.id === id));
  const isMore = !BOTTOM.includes(active) || active === 'meer';
  setHTML($('#bottomnav'), html`${bottom.map((n) => html`<a href="#/${n.id}" class="${(n.id === active || (n.id === 'meer' && isMore)) ? 'active' : ''}">
    <span class="ni">${n.icon}</span><span>${n.label}</span></a>`)}`);
  $('#hh-switch').textContent = state.household.name + (state.households.length > 1 ? ' ▾' : '');
  $('#hh-switch').onclick = () => go('instellingen');
  renderBanner();
}

function renderBanner() {
  const n = outboxCount();
  const b = $('#banner');
  if (!navigator.onLine) setHTML(b, html`<div class="banner warn">Offline — je ziet de laatst bekende lijst. Afvinken en toevoegen wordt verstuurd zodra je weer verbinding hebt${n ? ` (${n} wachtend)` : ''}.</div>`);
  else if (n) setHTML(b, html`<div class="banner">${n} wijziging(en) worden gesynchroniseerd…</div>`);
  else b.innerHTML = '';
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (sb) {
    try {
      await initAuth();
      if (state.user) await loadHouseholds();
    } catch (e) { toast(errorText(e), 'error'); }
    onChange('auth', async ({ event }) => {
      if (event === 'PASSWORD_RECOVERY') { go('nieuw-wachtwoord'); return; }
      if (state.user) { try { await loadHouseholds(); } catch (e) { toast(errorText(e), 'error'); } }
      render();
    });
    onChange('household', () => renderChrome(parseHash().route));
    onChange(['online', 'outbox'], renderBanner);
    onChange('realtime', ({ status }) => {
      const dot = $('#sync-dot');
      dot.className = 'sync-dot ' + (status === 'SUBSCRIBED' ? 'ok' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'bad' : '');
      dot.title = status === 'SUBSCRIBED' ? 'Live gesynchroniseerd' : 'Verbinding met live-sync: ' + status;
    });
    onChange('household_members', async (e) => {
      // eigen lidmaatschap verwijderd? opnieuw laden
      if (e.type === 'DELETE' && e.old?.user_id === state.user?.id) { await loadHouseholds(); render(); return; }
      // nieuw gezinslid of gewijzigde rol: namen en rechten bijwerken
      try { await loadMembers(); emit('refresh'); } catch { /* */ }
    });
    flushOutbox();
  }
  window.addEventListener('hashchange', render);
  render();
}

// Installatieknop (Android/desktop); iOS krijgt uitleg in het dashboard
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = e; document.body.classList.add('can-install'); });

export { getConfig, render };
boot();
