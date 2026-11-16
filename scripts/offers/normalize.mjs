// Zet de ruwe gegevens van elke supermarktwebsite om naar rijen voor de tabel `offers`
// (en voor Lidl ook naar `store_products`, omdat Lidl in de gewone prijsbron ontbreekt).
import { parseOfferLabel, matchTerms } from '../../app/js/lib/offers.js';
import { parseSize, unitPrice } from '../../app/js/lib/units.js';

const TZ = 'Europe/Amsterdam';
export function toDate(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  if (isNaN(d)) return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const MONTHS = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
/** "17 nov" of "17 november" → YYYY-MM-DD (jaar zo gekozen dat de datum dichtbij vandaag ligt) */
export function dutchDate(text, today = new Date()) {
  const m = String(text || '').toLowerCase().match(/(\d{1,2})\s+([a-z]{3})[a-z]*/);
  if (!m || !MONTHS[m[2]]) return null;
  const y = today.getFullYear();
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const d = new Date(Date.UTC(yy, MONTHS[m[2]] - 1, +m[1]));
    if (!best || Math.abs(d - today) < Math.abs(best - today)) best = d;
  }
  return best.toISOString().slice(0, 10);
}

const firstNum = (s) => { const m = String(s ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const r2 = (n) => (n == null || isNaN(n) ? null : Math.round(n * 100) / 100);
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function row(store, o) {
  const from = o.valid_from || toDate(new Date());
  return {
    store, product_name: String(o.product_name).replace(/\s+/g, ' ').trim().slice(0, 300),
    offer_type: o.offer_type, params: o.params || {},
    regular_price: r2(o.regular_price), offer_price: r2(o.offer_price),
    size_text: o.size_text || null, valid_from: from, valid_to: o.valid_to || addDays(from, 6),
    link: o.link || null, ext_id: o.ext_id || null, category: o.category || null,
    match_terms: o.match_terms?.length ? o.match_terms : matchTerms(o.product_name),
    source: `website ${store}`,
  };
}

/** Bepaalt het actietype uit een label en/of oude en nieuwe prijs. */
function decide(label, { price = null, regular = null } = {}) {
  const parsed = parseOfferLabel(label);
  if (parsed) {
    if (parsed.offer_type === 'fixed' && regular && parsed.params.price >= regular) return null;
    return parsed;
  }
  if (price != null && regular != null && price < regular) return { offer_type: 'fixed', params: { price } };
  return null;
}

const SKIP_LABEL = /gratis bezorging|bezorgkosten|spaar|punten|zegel|air miles/i;

// ------------------------------------------------------------------ per winkel
export function normalizeAH(raw) {
  const out = [];
  for (const p of raw) {
    if (!['AH', 'FESTIVE_FAVOURITE'].includes(p.segmentType)) continue; // Etos, Gall & Gall, alleen-online overslaan
    const label = (p.labels || []).join(' ');
    if (SKIP_LABEL.test(label)) continue;
    let d = decide(label, { price: p.product?.now, regular: p.product?.was });
    if (!d && /per\s+\d+\s*(gram|g|kilo|kg)/i.test(label)) d = { offer_type: 'info', params: { label } };
    if (!d) continue;
    const pr = p.product;
    out.push(row('ah', {
      ...d, product_name: pr?.title || p.title, regular_price: pr?.was ?? null,
      offer_price: d.offer_type === 'fixed' ? d.params.price : pr?.now ?? null,
      size_text: pr?.size || p.salesUnitSize || null, valid_from: toDate(p.start), valid_to: toDate(p.end),
      link: pr?.webPath ? 'https://www.ah.nl' + pr.webPath : p.webPath ? 'https://www.ah.nl' + p.webPath : null,
      ext_id: pr?.id ? `wi${pr.id}` : null, category: p.category,
      match_terms: matchTerms(p.title, pr?.title ? [pr.title] : []),
    }));
  }
  return { offers: out };
}

export function normalizeJumbo(raw) {
  const out = [];
  for (const p of raw) {
    const tags = (p.tags || []).join(' ');
    if (/alleen online/i.test(tags) || SKIP_LABEL.test(tags)) continue;
    const d = decide(tags.replace(/alleen in de winkel/i, ''));
    if (!d) continue;
    out.push(row('jumbo', { ...d, product_name: p.title, offer_price: d.offer_type === 'fixed' ? d.params.price : null,
      valid_from: toDate(p.start), valid_to: toDate(p.end), link: p.href ? 'https://www.jumbo.com' + p.href : null }));
  }
  return { offers: out };
}

export function normalizeLidl(raw, checkedAt = new Date().toISOString()) {
  const offers = [], products = [];
  for (const p of raw) {
    if (p.category && !['Food', 'F+V'].includes(p.category)) continue; // non-food overslaan
    const size = parseSize(p.packaging);
    const regular = p.oldPrice ?? p.price;
    const link = p.url ? (p.url.startsWith('http') ? p.url : 'https://www.lidl.nl' + p.url) : null;
    products.push({ store: 'lidl', name: p.title, link, price: r2(regular), size_text: p.packaging, amount: size?.amount ?? null, unit: size?.unit ?? null,
      unit_price: size ? unitPrice(regular, size) : null, source: 'lidl-website', checked_at: checkedAt, ext_key: 'lidl-' + p.id });
    let d = null;
    if (p.plusPrice != null && p.plusPrice < p.price) d = { offer_type: 'card', params: { price: p.plusPrice }, offer_price: p.plusPrice };
    else if (p.oldPrice != null && p.price < p.oldPrice) d = { offer_type: 'fixed', params: { price: p.price }, offer_price: p.price };
    else d = { offer_type: 'fixed', params: { price: p.price }, offer_price: p.price };
    offers.push(row('lidl', { ...d, product_name: p.title, regular_price: regular, size_text: p.packaging,
      valid_from: toDate(p.start), valid_to: toDate(p.end), link, ext_id: 'lidl-' + p.id, match_terms: matchTerms(p.title, [p.title]) }));
  }
  return { offers, products };
}

export function normalizeAldi(raw) {
  const out = [];
  for (const p of raw) {
    if (p.price == null) continue;
    const isOffer = p.strike != null || /\d\s*voor/i.test(p.label || '') || p.category === 'offer';
    if (!isOffer) continue; // gewoon assortiment dat ook op de pagina staat
    const name = [p.brand ? titleCase(p.brand) : null, p.name].filter(Boolean).join(' ');
    const lab = String(p.label || '');
    let d;
    const multi = lab.match(/(\d+)\s*voor/i);
    if (multi) d = { offer_type: 'multibuy', params: { n: +multi[1], total: p.price } };
    else d = decide(/^-?\d+%$|^tot|^vanaf|op=op|^v\.a\./i.test(lab) ? '' : lab, { price: p.price, regular: p.strike })
      || { offer_type: 'fixed', params: { price: p.price } };
    out.push(row('aldi', { ...d, product_name: name, regular_price: p.strike ?? null, offer_price: multi ? null : p.price,
      size_text: p.salesUnit, valid_from: p.from || toDate(p.validFrom), valid_to: p.to || toDate(p.validUntil),
      link: p.slug ? `https://www.aldi.nl/product/${p.slug}.html` : null, match_terms: matchTerms(name, [name, p.name]) }));
  }
  return { offers: out };
}

/** Dirk en DekaMarkt hebben hetzelfde systeem. */
export function normalizeDetailresult(store, raw) {
  const out = [];
  for (const o of raw) {
    const label = String(o.sign || '').replace(/actie_?/i, '').trim();
    const items = o.products?.length ? o.products : [{ name: o.headerText, packaging: o.packaging, offerPrice: o.offerPrice, normalPrice: o.normalPrice }];
    for (const p of items) {
      if (!p.name) continue;
      const d = decide(label, { price: p.offerPrice, regular: p.normalPrice });
      if (!d) continue;
      out.push(row(store, { ...d, product_name: p.name, regular_price: p.normalPrice || null,
        offer_price: d.offer_type === 'fixed' ? d.params.price : null, size_text: p.packaging || null,
        valid_from: toDate(o.start), valid_to: toDate(o.end), category: null, match_terms: matchTerms(p.name, [p.name]) }));
    }
  }
  return { offers: out };
}

export function normalizePlus(raw, today = new Date()) {
  const out = [];
  for (const p of raw) {
    const text = `${p.label} ${p.text}`;
    if (SKIP_LABEL.test(text) || p.price == null) continue;
    const prev = firstNum(p.previous);
    const lab = p.label || (p.text.match(/^\d+\s*voor\s*\d+[.,]\d{2}|^\d\+\d\s*gratis|^2e halve prijs/i) || [])[0] || '';
    const d = decide(/op=op/i.test(lab) ? '' : lab, { price: p.price, regular: prev });
    if (!d) continue;
    const [hFrom, hTo] = String(p.header || '').split(/t\/m/i);
    const to = dutchDate((p.complementary.match(/t\/m\s+(\d{1,2}\s+\w+)/i) || [])[1], today) || dutchDate(hTo, today);
    const from = dutchDate(hFrom, today);
    const id = (p.href || '').match(/-(\d{4,})$/)?.[1] || null;
    out.push(row('plus', { ...d, product_name: p.name, regular_price: prev, offer_price: d.offer_type === 'fixed' ? d.params.price : null,
      size_text: (p.complementary.match(/per\s+[^t]+?(?=\s+t\/m|$)/i) || [])[0] || null, valid_from: from, valid_to: to,
      link: p.href ? 'https://www.plus.nl' + p.href : null, ext_id: id ? `-${id}` : null }));
  }
  return { offers: out };
}
