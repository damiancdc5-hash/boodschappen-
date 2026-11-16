// Prijzen ophalen, acties koppelen, winkellocaties en scenario's berekenen.
import { sb, q, state, hid, cacheGet, cacheSet } from './api.js';
import { computeScenarios } from './lib/optimizer.js';
import { nearestPerChain, overpassQuery } from './lib/geo.js';
import { nameKey } from './lib/ingredients.js';
import { costForPacks, offerActive, offerMatches } from './lib/offers.js';
import { isoDate } from './ui.js';

export const STORES = {
  ah: { name: 'Albert Heijn', color: '#00a0e2' },
  jumbo: { name: 'Jumbo', color: '#f5c400' },
  lidl: { name: 'Lidl', color: '#0050aa' },
  aldi: { name: 'Aldi', color: '#00205b' },
  plus: { name: 'PLUS', color: '#5a9a1e' },
  dirk: { name: 'Dirk', color: '#e30613' },
  vomar: { name: 'Vomar', color: '#e2001a' },
  hoogvliet: { name: 'Hoogvliet', color: '#ef7d00' },
  dekamarkt: { name: 'DekaMarkt', color: '#c8102e' },
};
export const storeName = (c) => STORES[c]?.name || c;

export function enabledStores() {
  return state.household?.stores_enabled?.length ? state.household.stores_enabled : Object.keys(STORES);
}

export async function priceStatus() {
  const rows = await q(sb.from('price_status').select('*'));
  const lastRun = await q(sb.from('price_sync_runs').select('*').eq('source', 'checkjebon').order('started_at', { ascending: false }).limit(1));
  return { stores: Object.fromEntries(rows.map((r) => [r.store, r])), lastRun: lastRun[0] || null };
}

let offersCache = null;
/** Actieve acties: van de supermarktwebsites (household_id leeg) + door het huishouden ingevoerd. */
export async function loadOffers({ fresh = false } = {}) {
  if (!fresh && offersCache && Date.now() - offersCache.t < 120000 && offersCache.hid === hid()) return offersCache.rows;
  const today = isoDate();
  const rows = await q(sb.from('offers').select('*').gte('valid_to', today).lte('valid_from', today)
    .or(`household_id.is.null,household_id.eq.${hid()}`).order('store').limit(5000));
  const active = rows.filter((o) => offerActive(o));
  offersCache = { t: Date.now(), hid: hid(), rows: active };
  return active;
}

/** Status van de aanbiedingensync per winkel (laatste run). */
export async function offerSyncStatus() {
  const runs = await q(sb.from('price_sync_runs').select('*').like('source', 'aanbiedingen:%').order('started_at', { ascending: false }).limit(60));
  const by = {};
  for (const r of runs) { const s = r.source.split(':')[1]; if (!by[s]) by[s] = r; }
  return by;
}

function offerFor(c, offers) {
  // eigen invoer van het huishouden gaat voor, daarna de website-actie
  const mine = offers.filter((o) => o.household_id && o.store === c.store);
  const pub = offers.filter((o) => !o.household_id && o.store === c.store);
  return mine.find((o) => o.store_product_id === c.id || offerMatches({ ...o, match_terms: o.match_terms?.length ? o.match_terms : null }, c))
    || pub.find((o) => offerMatches(o, c)) || null;
}

/** Zoekt kandidaten voor een lijst namen. Geeft {naam: [kandidaten]} */
export async function matchNames(names, perStore = 3) {
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const out = {};
  const stores = enabledStores();
  const [offers] = await Promise.all([loadOffers().catch(() => [])]);
  for (let i = 0; i < uniq.length; i += 60) {
    const chunk = uniq.slice(i, i + 60);
    const res = await q(sb.rpc('match_products', { p_names: chunk, p_stores: stores, p_per_store: perStore }));
    for (const [name, hits] of Object.entries(res || {})) {
      out[name] = hits.map((c) => ({ ...c, price: Number(c.price), amount: c.amount != null ? Number(c.amount) : null,
        unit_price: c.unit_price != null ? Number(c.unit_price) : null, offer: offerFor(c, offers) }));
    }
  }
  return out;
}

export async function candidatesForItems(items) {
  const byName = await matchNames(items.map((i) => i.name));
  const map = {};
  for (const it of items) map[it.id] = byName[it.name.trim()] || [];
  return map;
}

/** Map(nameKey → goedkoopste kandidaat per eenheid) voor de weekplanner */
export async function priceIndexFor(names) {
  const byName = await matchNames(names, 2);
  const idx = new Map();
  for (const [name, cands] of Object.entries(byName)) {
    let best = null;
    for (const c of cands) {
      if (c.score != null && c.score < 0.35) continue; // te slechte match
      const one = costForPacks(c.price, 1, c.offer);
      const per = c.amount ? one.total / c.amount : one.total;
      if (!best || per < best.per) best = { per, c };
    }
    if (best) idx.set(nameKey(name), { price: best.c.price, amount: best.c.amount, unit: best.c.unit, offer: best.c.offer, store: best.c.store, product: best.c });
  }
  return idx;
}

// ------------------------------------------------------------------ winkellocaties via OpenStreetMap
export async function storeLocations(force = false) {
  const h = state.household;
  if (h?.home_lat == null) return null;
  const key = `loc.${h.home_lat.toFixed(3)},${h.home_lng.toFixed(3)}`;
  const cached = !force && cacheGet(key, 7 * 86400e3);
  if (cached) return cached;
  const home = { lat: h.home_lat, lng: h.home_lng };
  let elements = [];
  for (const radius of [5000, 12000]) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(overpassQuery(h.home_lat, h.home_lng, radius)),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) throw new Error('Winkellocaties konden niet worden opgehaald (OpenStreetMap). Probeer het later opnieuw.');
    elements = (await res.json()).elements || [];
    const found = nearestPerChain(home, elements);
    if (enabledStores().every((s) => found[s]) || radius === 12000) { cacheSet(key, found); return found; }
  }
  return {};
}

export async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'nl' } });
  if (!res.ok) throw new Error('Adres zoeken mislukt');
  const [r] = await res.json();
  if (!r) throw new Error('Adres niet gevonden');
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: r.display_name };
}

/** Alles in één: open items van een lijst → kandidaten → drie scenario's */
export async function scenariosForList(listId) {
  const items = await q(sb.from('list_items').select('*').eq('list_id', listId).eq('checked', false));
  const candMap = await candidatesForItems(items);
  let locations = null, locError = null;
  try { locations = await storeLocations(); } catch (e) { locError = e.message; }
  const h = state.household;
  const result = computeScenarios(items, candMap, {
    stores: enabledStores(), maxStores: h.max_stores || 3,
    home: h.home_lat != null ? { lat: h.home_lat, lng: h.home_lng } : null,
    locations: locations || {}, mode: h.travel_mode, costPerKm: Number(h.cost_per_km), timeValue: Number(h.time_value_per_hour),
  });
  const payload = { listId, at: Date.now(), items, candMap, result, locations, locError };
  sessionStorage.setItem('bs.scenarios', JSON.stringify({ listId, at: payload.at, result, locations }));
  return payload;
}
