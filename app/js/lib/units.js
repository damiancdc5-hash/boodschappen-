// Eenheden: alles wordt teruggebracht naar g, ml of st (stuks).

const UNIT_MAP = {
  g: ['g', 'gr', 'gram', 'grams', 'grammen'],
  kg: ['kg', 'kilo', 'kilogram', 'kilo\'s'],
  mg: ['mg', 'milligram'],
  ml: ['ml', 'milliliter', 'mililiter'],
  cl: ['cl', 'centiliter'],
  dl: ['dl', 'deciliter'],
  l: ['l', 'lt', 'ltr', 'liter', 'liters'],
  el: ['el', 'eetlepel', 'eetlepels', 'eetl', 'tbsp'],
  tl: ['tl', 'theelepel', 'theelepels', 'thl', 'tsp'],
  kop: ['kop', 'kopje', 'kopjes', 'cup', 'cups'],
  st: ['st', 'stk', 'stuk', 'stuks', 'x', 'st.', 'pcs'],
};

// naar basiseenheid
const FACTORS = { g: ['g', 1], kg: ['g', 1000], mg: ['g', 0.001], ml: ['ml', 1], cl: ['ml', 10], dl: ['ml', 100],
  l: ['ml', 1000], el: ['ml', 15], tl: ['ml', 5], kop: ['ml', 240], st: ['st', 1] };

// Telbare verpakkings-/stukseenheden die als 'st' tellen
export const COUNT_WORDS = ['teen', 'teentje', 'teentjes', 'tenen', 'blik', 'blikje', 'blikken', 'pak', 'pakje', 'pakken',
  'zak', 'zakje', 'zakjes', 'bos', 'bosje', 'bosjes', 'plak', 'plakken', 'plakjes', 'takje', 'takjes', 'stengel', 'stengels',
  'bol', 'bollen', 'krop', 'kropje', 'pot', 'potje', 'potten', 'fles', 'flessen', 'flesje', 'doos', 'doosje', 'bakje', 'bakjes',
  'stuk', 'stuks', 'snee', 'sneetjes', 'sneden', 'handje', 'handvol', 'mespunt', 'snufje', 'snuf', 'scheut', 'scheutje', 'blad', 'blaadjes',
  'rol', 'rollen', 'tros', 'trosje', 'netje', 'kuipje', 'beker', 'bekertje', 'bekers', 'ei', 'eieren'];

const LOOKUP = new Map();
for (const [k, arr] of Object.entries(UNIT_MAP)) for (const a of arr) LOOKUP.set(a, k);

export function canonicalUnit(word) {
  if (!word) return null;
  const w = String(word).toLowerCase().replace(/\.$/, '');
  return LOOKUP.get(w) || LOOKUP.get(word.toLowerCase()) || null;
}

/** Zet een hoeveelheid + eenheid om naar {amount, unit} met unit in g|ml|st */
export function toBase(amount, unit) {
  if (amount == null || isNaN(amount)) return null;
  const u = canonicalUnit(unit) || (unit && COUNT_WORDS.includes(String(unit).toLowerCase()) ? 'st' : null) || (unit ? null : 'st');
  if (!u) return null;
  const [base, f] = FACTORS[u];
  return { amount: round(amount * f, 3), unit: base };
}

export function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

/** Parseert een getal met NL-notatie: "1,5" "½" "1 1/2" "1½" "2-3" (neemt bovenste) */
export function parseNumber(str) {
  if (str == null) return null;
  let s = String(str).trim().replace(/,/g, '.');
  const frac = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
  for (const [k, v] of Object.entries(frac)) {
    if (s.includes(k)) {
      const pre = s.split(k)[0].trim();
      return (pre ? parseFloat(pre) || 0 : 0) + v;
    }
  }
  let m = s.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/); // bereik
  if (m) return parseFloat(m[2]);
  m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); // 1 1/2
  if (m) return +m[1] + (+m[2] / +m[3]);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return +m[1] / +m[2];
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Parseert een verpakkingsgrootte zoals supermarkten die tonen:
 * "1 l", "500 g", "6 x 330 ml", "per stuk", "4 stuks", "1,5 kg", "ca. 400 g", "2 x 125g"
 */
export function parseSize(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().replace(/,/g, '.').replace(/ca\.?|circa|±|per\s+(?=\d)/g, '').trim();
  if (/^(per\s+)?(stuk|st|stuks)$/.test(s)) return { amount: 1, unit: 'st' };
  let m = s.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-z]+)/);
  if (m) {
    const b = toBase(parseFloat(m[1]) * parseFloat(m[2]), m[3]);
    if (b) return b;
  }
  m = s.match(/(\d+(?:\.\d+)?)\s*([a-z']+)/);
  if (m) {
    const b = toBase(parseFloat(m[1]), m[2]);
    if (b) return b;
  }
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return { amount: parseFloat(m[1]), unit: 'st' };
  return null;
}

/** Prijs per kg / liter / stuk. */
export function unitPrice(price, size) {
  if (!size || !size.amount || price == null) return null;
  if (size.unit === 'g') return round(price / (size.amount / 1000), 4);
  if (size.unit === 'ml') return round(price / (size.amount / 1000), 4);
  return round(price / size.amount, 4);
}

export function unitPriceLabel(unit) {
  return unit === 'g' ? 'per kg' : unit === 'ml' ? 'per liter' : 'per stuk';
}

const fmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
export function euro(n) {
  if (n == null || isNaN(n)) return '–';
  return fmt.format(n);
}

export function formatQty(amount, unit) {
  if (amount == null) return '';
  const n = (x) => (Math.round(x * 100) / 100).toString().replace('.', ',');
  if (unit === 'g' && amount >= 1000) return `${n(amount / 1000)} kg`;
  if (unit === 'ml' && amount >= 1000) return `${n(amount / 1000)} l`;
  if (unit === 'st' || !unit) return `${n(amount)}×`;
  return `${n(amount)} ${unit}`;
}

/** Zijn twee eenheden met elkaar op te tellen? */
export function compatible(a, b) {
  return a && b && a === b;
}
