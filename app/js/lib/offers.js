// Acties: labels herkennen ("2 voor 4,99", "1+1 gratis", "-30%"…), koppelen aan producten en doorrekenen.
import { round } from './units.js';

export const OFFER_TYPES = {
  percent: 'Korting %',
  amount_off: 'Bedrag korting',
  '1+1': '1+1 gratis',
  '2+1': '2+1 gratis',
  nplusm: 'X+Y gratis',
  '2e_half': '2e halve prijs',
  multibuy: 'Meerdere voor vaste prijs',
  fixed: 'Actieprijs',
  card: 'Klantenkaartprijs',
  info: 'Overige actie',
};

const eur = (n) => '€' + Number(n).toFixed(2).replace('.', ',');

export function describeOffer(o) {
  if (!o) return '';
  const p = o.params || {};
  switch (o.offer_type) {
    case 'percent': return `${p.pct}% korting`;
    case 'amount_off': return `${eur(p.amount)} korting`;
    case 'nplusm': return `${p.n}+${p.m} gratis`;
    case 'multibuy': return `${p.n} voor ${eur(p.total)}`;
    case 'fixed': return `actieprijs ${eur(p.price)}`;
    case 'card': return `met klantenkaart ${eur(p.price)}`;
    case 'info': return p.label || 'actie';
    default: return OFFER_TYPES[o.offer_type] || o.offer_type;
  }
}

export function offerActive(o, today = new Date()) {
  const d = today.toISOString().slice(0, 10);
  return (!o.valid_from || o.valid_from <= d) && (!o.valid_to || o.valid_to >= d);
}

const num = (s) => parseFloat(String(s).replace(',', '.'));

/**
 * Herkent een actielabel zoals supermarkten die tonen. Geeft {offer_type, params} of null.
 * "1+1 gratis", "2+1 GRATIS", "2+3 gratis", "2e halve prijs", "2 voor 4.99", "3 voor €5,00", "voor 0.89",
 * "30% korting", "-47%", "€1 korting", "1 euro korting".
 */
export function parseOfferLabel(label) {
  const s = String(label || '').toLowerCase().replace(/\s+/g, ' ').replace(/€\s?/g, '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/(\d+)\s*\+\s*(\d+)\s*gratis/))) {
    const n = +m[1], k = +m[2];
    if (n === 1 && k === 1) return { offer_type: '1+1', params: {} };
    if (n === 2 && k === 1) return { offer_type: '2+1', params: {} };
    return { offer_type: 'nplusm', params: { n, m: k } };
  }
  if (/2e\s*(product\s*)?halve\s*prijs|tweede\s*halve\s*prijs/.test(s)) return { offer_type: '2e_half', params: {} };
  if ((m = s.match(/(\d+)\s*(?:voor|for)\s*(\d+(?:[.,]\d{1,2})?)/))) return { offer_type: 'multibuy', params: { n: +m[1], total: num(m[2]) } };
  // "2 stuks 17.99" (AH) — "1 stuk 9.99" alleen als er geen meerstuksactie is
  if ((m = s.match(/([2-9])\s*stuks\s*(\d+[.,]\d{2})/))) return { offer_type: 'multibuy', params: { n: +m[1], total: num(m[2]) } };
  if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*%\s*(korting|voordeel)?/))) return { offer_type: 'percent', params: { pct: num(m[1]) } };
  if ((m = s.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:euro\s*)?korting/))) return { offer_type: 'amount_off', params: { amount: num(m[1]) } };
  if ((m = s.match(/^(?:nu\s*)?voor\s*(\d+(?:[.,]\d{1,2})?)$/))) return { offer_type: 'fixed', params: { price: num(m[1]) } };
  return null;
}

// --- koppelen aan producten ------------------------------------------------------------------
const STOP = new Set(['alle', 'en', 'of', 'met', 'de', 'het', 'een', 'van', 'per', 'voor', 'in', 'à', 'a', 'stuk', 'stuks', 'verpakking',
  'gram', 'kilo', 'liter', 'pak', 'zak', 'fles', 'blik', 'pot', 'rollen', 'op', 'schaal', 'net', 'bakje', 'doos', 'tray', 'diverse', 'soorten', 'smaken', 'varianten', 'combineren', 'mogelijk']);

function words(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\d+(?:[.,]\d+)?\s*(g|gr|gram|kg|kilo|ml|cl|l|liter|stuks?|rollen|x)\b/g, ' ')
    .replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
}

/**
 * Zoektermen voor een actietitel. "Page Compleet Schoon, Kussenzacht of Sensitive" →
 * ["page compleet schoon", "page kussenzacht", "page sensitive"]. Elke term = woorden die allemaal in de productnaam moeten staan.
 */
export function matchTerms(title, productNames = []) {
  const out = new Set();
  for (const p of productNames) { const w = words(p); if (w.length) out.add(w.join(' ')); }
  if (out.size) return [...out];
  const t = String(title || '').replace(/\([^)]*\)/g, ' ');
  const parts = t.split(/\s*,\s*|\s+of\s+|\s+en\s+(?=[A-Z])/).map(words).filter((w) => w.length);
  if (!parts.length) return [];
  const brand = /^[A-Z]/.test(t.trim()) && parts.length > 1 ? parts[0][0] : null;
  for (const w of parts) {
    const arr = brand && !w.includes(brand) && w.length < 3 ? [brand, ...w] : w;
    out.add(arr.join(' '));
  }
  return [...out];
}

/** Hoort deze actie bij dit product? */
export function offerMatches(offer, product) {
  if (offer.store !== product.store) return false;
  if (offer.store_product_id && offer.store_product_id === product.id) return true;
  if (offer.link && product.link && offer.link === product.link) return true;
  if (offer.ext_id && product.link) {
    const re = new RegExp(offer.ext_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])');
    if (re.test(product.link)) return true;
  }
  const name = ' ' + words(product.name).join(' ') + ' ';
  const terms = offer.match_terms?.length ? offer.match_terms : matchTerms(offer.product_name);
  return terms.some((t) => t && t.split(' ').every((w) => name.includes(' ' + w + ' ') || (w.length > 4 && name.includes(' ' + w))));
}

/**
 * Totale kosten om `packs` verpakkingen te kopen met (optioneel) een actie.
 * Geeft {total, regular, savings, packsTaken} — packsTaken kan hoger zijn dan packs (bijv. 1+1: je krijgt er 2 mee).
 */
export function costForPacks(price, packs, offer, { useCard = true } = {}) {
  const regular = round(price * packs, 2);
  if (!offer || packs <= 0) return { total: regular, regular, savings: 0, packsTaken: packs };
  const p = offer.params || {};
  let total = regular, taken = packs;
  const nplusm = (n, m) => {
    const set = n + m, sets = Math.floor(packs / set), rest = packs % set;
    total = price * (sets * n + Math.min(rest, n));
    taken = sets * set + (rest >= n ? set : rest);
  };
  switch (offer.offer_type) {
    case 'percent': total = price * packs * (1 - (Number(p.pct) || 0) / 100); break;
    case 'amount_off': total = Math.max(0, price - (Number(p.amount) || 0)) * packs; break;
    case '1+1': nplusm(1, 1); break;
    case '2+1': nplusm(2, 1); break;
    case 'nplusm': nplusm(Number(p.n) || 1, Number(p.m) || 1); break;
    case '2e_half': total = price * (Math.floor(packs / 2) * 1.5 + (packs % 2)); break;
    case 'multibuy': {
      const n = Number(p.n) || 1, t = Number(p.total) || price * n;
      const sets = Math.floor(packs / n), rest = packs % n;
      total = sets * t + rest * price;
      // als aanvullen tot een set goedkoper is, doe dat
      if (rest && t < rest * price) { total = (sets + 1) * t; taken = (sets + 1) * n; }
      break;
    }
    case 'fixed': total = (Number(p.price) || price) * packs; break;
    case 'card': total = useCard ? (Number(p.price) || price) * packs : regular; break;
    default: break; // 'info': geen prijseffect
  }
  total = round(total, 2);
  if (total > regular) return { total: regular, regular, savings: 0, packsTaken: packs };
  return { total, regular, savings: round(regular - total, 2), packsTaken: taken };
}
