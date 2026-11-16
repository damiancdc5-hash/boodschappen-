// Service worker: app-schil offline beschikbaar; gegevens altijd live via Supabase.
const VERSION = 'v3';
const SHELL = `bs-shell-${VERSION}`;
const CDN = `bs-cdn-${VERSION}`;
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/config.js', 'js/ui.js', 'js/pricing.js',
  'js/lib/units.js', 'js/lib/ingredients.js', 'js/lib/offers.js', 'js/lib/optimizer.js', 'js/lib/menu.js', 'js/lib/geo.js', 'js/lib/recipes.js',
  'js/views/dashboard.js', 'js/views/list.js', 'js/views/prices.js', 'js/views/offers.js', 'js/views/recipes.js', 'js/views/planner.js', 'js/views/pantry.js',
  'js/lib/offers.js', 'js/views/budget.js', 'js/views/route.js', 'js/views/settings.js', 'js/views/more.js', 'js/views/auth.js', 'js/views/onboarding.js', 'js/views/setup.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, CDN].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Supabase, kaarttegels en routering nooit cachen
  if (/supabase\.(co|in)|openstreetmap|overpass|nominatim/.test(url.hostname)) return;
  if (url.origin === location.origin) {
    // eigen bestanden: eerst netwerk (altijd nieuwste versie), anders cache
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
    return;
  }
  if (/esm\.sh|unpkg\.com|jsdelivr\.net/.test(url.hostname)) {
    // bibliotheken: cache, op de achtergrond verversen
    e.respondWith(caches.open(CDN).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
