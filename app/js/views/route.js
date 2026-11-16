// Winkelroute: kaart met geselecteerde supermarkten en de handigste route (OpenStreetMap).
import { html, setHTML, toast, errorText, loading } from '../ui.js';
import { state } from '../api.js';
import { STORES, storeName, enabledStores, storeLocations, scenariosForList } from '../pricing.js';
import { bestRoute } from '../lib/geo.js';
import { euro } from '../lib/units.js';
import { defaultListId } from './list.js';

let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = () => res(window.L); s.onerror = () => rej(new Error('Kaart kon niet worden geladen'));
    document.head.appendChild(s);
  });
  return leafletLoading;
}

const PROFILE = { car: 'routed-car', bike: 'routed-bike', walk: 'routed-foot' };
const GMODE = { car: 'driving', bike: 'bicycling', walk: 'walking' };

export async function render(el) {
  const h = state.household;
  if (h.home_lat == null) {
    setHTML(el, html`<h1>Winkelroute</h1><div class="card"><p>Stel eerst jullie adres in, dan kan de app de dichtstbijzijnde supermarkten en de handigste route berekenen.</p>
      <a class="btn" href="#/instellingen">Adres instellen</a></div>`);
    return;
  }
  setHTML(el, html`<h1>Winkelroute</h1><div id="sel" class="card">${loading('Supermarkten in de buurt zoeken…')}</div>
    <div id="map"></div><div id="info" class="card" style="margin-top:1rem"></div>`);
  let selected;
  try { selected = JSON.parse(sessionStorage.getItem('bs.routeStores') || 'null'); } catch { selected = null; }
  let scenario = null;
  if (selected) {
    try {
      const r = JSON.parse(sessionStorage.getItem('bs.scenarios') || 'null')?.result;
      const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      scenario = [r?.balanced, r?.cheapest, ...(r?.single || [])].find((p) => p && same(p.stores, selected)) || null;
    } catch { scenario = null; }
  } else {
    try {
      const s = await scenariosForList(await defaultListId());
      scenario = s.result.balanced;
      selected = scenario?.stores || [];
    } catch { selected = []; }
  }
  let locations;
  try { locations = await storeLocations(); } catch (e) { setHTML(el.querySelector('#sel'), html`<p class="notice danger">${errorText(e)}</p>`); return; }
  const L = await loadLeaflet();
  const home = { lat: h.home_lat, lng: h.home_lng };
  const map = L.map(el.querySelector('#map')).setView([home.lat, home.lng], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-bijdragers' }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let mode = h.travel_mode || 'car';

  const drawSel = () => setHTML(el.querySelector('#sel'), html`<div class="row between"><b>Winkels op de route</b>
      <div class="tabs" style="margin:0">${[['car', '🚗'], ['bike', '🚲'], ['walk', '🚶']].map(([k, i]) => html`<button data-mode="${k}" class="${mode === k ? 'active' : ''}">${i}</button>`)}</div></div>
    <div class="row" style="margin-top:.5rem">${enabledStores().map((s) => html`<button class="chip ${selected.includes(s) ? 'active' : ''}" data-s="${s}" ${locations[s] ? '' : 'disabled title="Niet in de buurt gevonden"'}>
      ${storeName(s)}${locations[s] ? ` · ${locations[s].km.toFixed(1)} km` : ' · –'}</button>`)}</div>`);

  async function update() {
    drawSel();
    layer.clearLayers();
    const icon = (color, label) => L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
      html: `<div style="background:${color};color:#fff;border:2px solid #fff;border-radius:50%;width:30px;height:30px;display:grid;place-items:center;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.4)">${label}</div>` });
    L.marker([home.lat, home.lng], { icon: icon('#1f8a5b', '⌂') }).addTo(layer).bindPopup('Thuis');
    for (const s of enabledStores()) {
      const loc = locations[s]; if (!loc || selected.includes(s)) continue;
      L.circleMarker([loc.lat, loc.lng], { radius: 6, color: STORES[s].color, weight: 2, fillOpacity: .3 }).addTo(layer).bindPopup(`${loc.name}<br>${loc.address || ''}`);
    }
    const stops = selected.filter((s) => locations[s]);
    const info = el.querySelector('#info');
    if (!stops.length) { setHTML(info, html`<p class="muted">Kies hierboven één of meer winkels.</p>`); map.setView([home.lat, home.lng], 13); return; }
    const pts = stops.map((s) => locations[s]);
    const order = bestRoute(home, pts).order.map((i) => stops[i]);
    order.forEach((s, i) => L.marker([locations[s].lat, locations[s].lng], { icon: icon(STORES[s].color, i + 1) }).addTo(layer)
      .bindPopup(`<b>${i + 1}. ${locations[s].name}</b><br>${locations[s].address || ''}`));
    const coords = [home, ...order.map((s) => locations[s]), home].map((p) => `${p.lng},${p.lat}`).join(';');
    setHTML(info, loading('Route berekenen…'));
    let km, min, line;
    try {
      const r = await fetch(`https://routing.openstreetmap.de/${PROFILE[mode]}/route/v1/driving/${coords}?overview=full&geometries=geojson`);
      const j = await r.json();
      if (j.code !== 'Ok') throw new Error(j.message || 'route');
      km = j.routes[0].distance / 1000; min = j.routes[0].duration / 60;
      line = j.routes[0].geometry.coordinates.map(([x, y]) => [y, x]);
    } catch {
      line = [home, ...order.map((s) => locations[s]), home].map((p) => [p.lat, p.lng]);
      km = null;
    }
    const poly = L.polyline(line, { color: '#1f8a5b', weight: 4, opacity: .85 }).addTo(layer);
    map.fitBounds(poly.getBounds(), { padding: [30, 30] });
    const cost = km != null && mode === 'car' ? km * Number(h.cost_per_km) : 0;
    const timeCost = min != null ? (min / 60) * Number(h.time_value_per_hour || 0) : 0;
    const last = order[order.length - 1];
    const gm = `https://www.google.com/maps/dir/?api=1&origin=${home.lat},${home.lng}&destination=${home.lat},${home.lng}&travelmode=${GMODE[mode]}&waypoints=${order.map((s) => `${locations[s].lat},${locations[s].lng}`).join('|')}`;
    const am = `https://maps.apple.com/?saddr=${home.lat},${home.lng}&daddr=${locations[order[0]].lat},${locations[order[0]].lng}&dirflg=${mode === 'walk' ? 'w' : mode === 'bike' ? 'b' : 'd'}`;
    setHTML(info, html`<div class="grid three">
        <div class="stat"><span class="v">${km != null ? km.toFixed(1) + ' km' : '–'}</span><span class="l">totale afstand (heen en terug)</span></div>
        <div class="stat"><span class="v">${min != null ? Math.round(min) + ' min' : '–'}</span><span class="l">reistijd (zonder winkelen)</span></div>
        <div class="stat"><span class="v">${euro(cost + timeCost)}</span><span class="l">reiskosten${timeCost ? ' incl. tijd' : ''}</span></div></div>
      ${km == null ? html`<p class="notice warn small">Routeservice niet bereikbaar; lijn op de kaart is hemelsbreed.</p>` : ''}
      ${scenario ? html`<p class="small">Verwachte boodschappen: <b>${euro(scenario.total)}</b>, besparing t.o.v. gemiddelde prijs ${euro(scenario.savingsVsAverage)} → netto voordeel ${euro(scenario.savingsVsAverage - cost - timeCost)}.</p>` : ''}
      <ol>${order.map((s) => html`<li><b>${locations[s].name}</b> <span class="muted small">${locations[s].address || ''}</span></li>`)}</ol>
      <div class="row"><a class="btn" href="${gm}" target="_blank" rel="noopener">Open in Google Maps</a>
        ${order.length === 1 ? html`<a class="btn ghost" href="${am}" target="_blank" rel="noopener">Apple Kaarten</a>` : ''}</div>
      <p class="small muted">Vestigingen en route uit OpenStreetMap. Kies in de Prijsvergelijker een scenario om de winkels automatisch te selecteren.</p>`);
    void last;
  }

  el.querySelector('#sel').onclick = (e) => {
    const c = e.target.closest('[data-s]'), m = e.target.closest('[data-mode]');
    if (c) { const s = c.dataset.s; selected = selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s]; sessionStorage.setItem('bs.routeStores', JSON.stringify(selected)); update().catch((er) => toast(errorText(er), 'error')); }
    if (m) { mode = m.dataset.mode; update().catch((er) => toast(errorText(er), 'error')); }
  };
  await update();
  return () => map.remove();
}
