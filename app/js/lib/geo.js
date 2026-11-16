// Afstanden, kortste volgorde langs winkels, en open kaartdiensten (OpenStreetMap).

export function haversineKm(a, b) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function permutations(n) {
  const out = [], a = [...Array(n).keys()];
  const rec = (k) => {
    if (k === n) { out.push(a.slice()); return; }
    for (let i = k; i < n; i++) { [a[k], a[i]] = [a[i], a[k]]; rec(k + 1); [a[k], a[i]] = [a[i], a[k]]; }
  };
  rec(0);
  return out;
}

/** Kortste rondrit thuis → winkels → thuis (exact voor ≤ 6 winkels). */
export function bestRoute(home, points) {
  if (!points.length) return { km: 0, order: [] };
  let best = null;
  for (const perm of permutations(points.length)) {
    let km = 0, prev = home;
    for (const i of perm) { km += haversineKm(prev, points[i]); prev = points[i]; }
    km += haversineKm(prev, home);
    if (!best || km < best.km) best = { km, order: perm };
  }
  return best;
}

// Ketens zoals ze in OpenStreetMap heten (brand-tag)
export const CHAIN_BRANDS = {
  ah: ['Albert Heijn', 'AH', 'Albert Heijn XL', 'AH to go'],
  jumbo: ['Jumbo', 'Jumbo City'],
  lidl: ['Lidl'],
  aldi: ['Aldi', 'ALDI'],
  plus: ['PLUS', 'Plus'],
  dirk: ['Dirk', 'Dirk van den Broek'],
  vomar: ['Vomar', 'Vomar Voordeelmarkt'],
  hoogvliet: ['Hoogvliet'],
  dekamarkt: ['DekaMarkt', 'Dekamarkt'],
};

export function chainFromTags(tags = {}) {
  const v = [tags.brand, tags.name, tags.operator].filter(Boolean).map((s) => s.toLowerCase());
  for (const [code, names] of Object.entries(CHAIN_BRANDS)) {
    if (names.some((n) => v.some((x) => x === n.toLowerCase() || x.startsWith(n.toLowerCase() + ' ')))) return code;
  }
  return null;
}

/** Overpass-query: supermarkten binnen `radius` meter rond een punt. */
export function overpassQuery(lat, lng, radius = 6000) {
  return `[out:json][timeout:25];(node["shop"="supermarket"](around:${radius},${lat},${lng});way["shop"="supermarket"](around:${radius},${lat},${lng}););out center tags;`;
}

/** Kiest per keten de dichtstbijzijnde vestiging. */
export function nearestPerChain(home, elements) {
  const best = {};
  for (const el of elements || []) {
    const chain = chainFromTags(el.tags);
    if (!chain) continue;
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const d = haversineKm(home, { lat, lng });
    if (!best[chain] || d < best[chain].km) {
      const t = el.tags || {};
      best[chain] = { lat, lng, km: d, name: t.name || chain,
        address: [t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim(), t['addr:city']].filter(Boolean).join(', ') };
    }
  }
  return best;
}
