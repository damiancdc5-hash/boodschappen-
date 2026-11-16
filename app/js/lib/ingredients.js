// Ingrediënten herkennen, schalen, ontdubbelen en verrekenen met de voorraad.
import { canonicalUnit, COUNT_WORDS, parseNumber, toBase, round } from './units.js';

const NUM = '(\\d+(?:[.,]\\d+)?(?:\\s*[-–]\\s*\\d+(?:[.,]\\d+)?)?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+|\\d*\\s*[½¼¾⅓⅔⅛])';
const LINE_RE = new RegExp(`^\\s*${NUM}?\\s*([a-zA-Zë'.]+)?\\s*(.*)$`);

const FILLER = /^(ongeveer|circa|ca\.?|een|wat|beetje|paar)\s+/i;

export function cleanName(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s*,\s*(fijngesneden|gesneden|in blokjes|in reepjes|geraspt|gehakt fijn|fijngehakt|uitgeperst|geperst|in stukjes|in ringen|naar smaak).*$/i, '')
    .replace(/\b(naar smaak|optioneel)\b/gi, '')
    .replace(/^(van\s+de|van|de|het)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "200 g gehakt" → {quantity:200, unit:'g', name:'gehakt'} (eenheid zoals herkend, nog niet omgerekend) */
export function parseIngredientLine(line) {
  const raw = String(line || '').replace(/^[\s•\-*·–]+/, '').trim();
  if (!raw) return null;
  const optional = /optioneel|naar smaak/i.test(raw);
  let s = raw.replace(FILLER, '');
  const m = s.match(LINE_RE);
  let quantity = null, unit = null, name = s;
  if (m && m[1]) {
    quantity = parseNumber(m[1].replace(/\s+/g, ' '));
    const word = m[2];
    const rest = (m[3] || '').trim();
    if (word && canonicalUnit(word)) {
      unit = canonicalUnit(word);
      name = rest;
    } else if (word && COUNT_WORDS.includes(word.toLowerCase())) {
      unit = 'st';
      // "2 teentjes knoflook" → naam "knoflook"; "3 eieren" → naam "eieren"
      name = rest || word;
      if (/^eieren$|^ei$/i.test(word)) name = 'eieren';
    } else {
      unit = 'st';
      name = [word, rest].filter(Boolean).join(' ');
    }
  }
  name = cleanName(name.replace(/^(gram|g)\s+/i, ''));
  if (!name) return null;
  return { quantity, unit, name, raw, optional };
}

const SERVINGS_RE = /(?:voor|serves|porties?|personen|pers\.?|aantal personen|recept voor)\s*[:\-]?\s*(\d{1,2})|(\d{1,2})\s*(?:personen|porties|pers\.?|people|servings)/i;

export function detectServings(text) {
  const m = String(text || '').match(SERVINGS_RE);
  if (!m) return null;
  const n = parseInt(m[1] || m[2], 10);
  return n > 0 && n < 50 ? n : null;
}

/** Zet vrije tekst (geplakt of OCR/PDF) om naar een recept. */
export function parseRecipeText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const title = (nonEmpty[0] || 'Nieuw recept').replace(/^#+\s*/, '').slice(0, 120);
  const servings = detectServings(text) || 4;
  let section = 'unknown';
  const ingredients = [];
  const steps = [];
  for (const l of nonEmpty.slice(1)) {
    if (/^(ingredi[eë]nten|benodigdheden|boodschappen|wat heb je nodig)\b/i.test(l)) { section = 'ing'; continue; }
    if (/^(bereiding|bereidingswijze|werkwijze|instructies|zo maak je het|methode|stappen)\b/i.test(l)) { section = 'steps'; continue; }
    if (section === 'steps') { steps.push(l); continue; }
    const looksLikeIngredient = /^[\s•\-*·–]*(\d|[½¼¾⅓]|een |snufje|mespunt|scheutje)/i.test(l) && l.length < 90;
    if (section === 'ing' || (section === 'unknown' && looksLikeIngredient)) {
      if (section === 'ing' && l.length > 120) { steps.push(l); continue; }
      const p = parseIngredientLine(l);
      if (p) ingredients.push(p);
    } else if (section === 'unknown' && l.length > 40) {
      steps.push(l);
    }
  }
  return { title, servings, ingredients, instructions: steps.join('\n') };
}

/** Schaalt hoeveelheden van `from` naar `to` personen. Stukken worden naar boven afgerond op halven. */
export function scaleIngredients(ings, from, to) {
  const f = to / (from || to || 1);
  return ings.map((i) => {
    if (i.quantity == null) return { ...i };
    let q = i.quantity * f;
    if (!i.unit || i.unit === 'st') q = Math.ceil(q * 2 - 1e-9) / 2;
    else q = round(q, 1);
    return { ...i, quantity: q };
  });
}

// --- namen normaliseren voor ontdubbelen ------------------------------------------------
const SYNONYMS = {
  'uien': 'ui', 'gele uien': 'ui', 'gele ui': 'ui', 'rode uien': 'rode ui', 'knoflookteen': 'knoflook', 'knoflookteentjes': 'knoflook',
  'teentjes knoflook': 'knoflook', 'eieren': 'ei', 'eitje': 'ei', 'eitjes': 'ei', 'tomaten': 'tomaat', 'aardappelen': 'aardappel',
  'aardappels': 'aardappel', 'wortelen': 'wortel', 'wortels': 'wortel', 'citroenen': 'citroen', 'paprika\'s': 'paprika',
  'champignons': 'champignon', 'courgettes': 'courgette', 'prei': 'prei', 'preien': 'prei', 'bananen': 'banaan', 'appels': 'appel',
  'rundergehakt': 'rundergehakt', 'half-om-half gehakt': 'gehakt', 'gehakt h-o-h': 'gehakt', 'olijfolie extra vierge': 'olijfolie',
};

export function nameKey(name) {
  let k = cleanName(name).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim();
  if (SYNONYMS[k]) return SYNONYMS[k];
  // eenvoudige meervoudsregels
  if (k.length > 5 && /[^aeiou]en$/.test(k) && !/(ingen|ten|den)$/.test(k)) {
    const base = k.slice(0, -2);
    // verdubbelde medeklinker: "kippen" → "kip"
    k = /(.)\1$/.test(base) ? base.slice(0, -1) : base;
  } else if (k.length > 4 && /[^s]s$/.test(k) && !/(is|us|as|os|ss)$/.test(k)) {
    k = k.slice(0, -1);
  }
  return SYNONYMS[k] || k;
}

/**
 * Voegt nieuwe ingrediënten samen met een bestaande lijst. Gelijke producten (op naam-sleutel en
 * compatibele eenheid) worden opgeteld in plaats van dubbel toegevoegd.
 * items: [{name, quantity, unit, ...}] — geeft {merged:[...], updates:[{index, quantity, unit}], additions:[...]}
 */
export function mergeItems(existing, incoming) {
  const result = existing.map((e) => ({ ...e }));
  const updates = new Map();
  const additions = [];
  const idx = new Map();
  result.forEach((e, i) => { if (!e.checked) idx.set(nameKey(e.name), i); });
  for (const inc of incoming) {
    const key = nameKey(inc.name);
    const addBase = toBase(inc.quantity ?? 1, inc.unit);
    if (idx.has(key)) {
      const i = idx.get(key);
      const cur = result[i];
      const curBase = toBase(cur.quantity ?? 1, cur.unit);
      if (curBase && addBase && curBase.unit === addBase.unit) {
        result[i] = { ...cur, quantity: round(curBase.amount + addBase.amount, 3), unit: curBase.unit };
        updates.set(i, { index: i, id: cur.id, quantity: result[i].quantity, unit: result[i].unit });
        continue;
      }
      if (!curBase || !addBase) continue; // onbekende hoeveelheid: niet nog eens toevoegen
      // verschillende soorten eenheden (bijv. 'st' en 'g'): hou het bestaande item, voeg niets dubbel toe
      continue;
    }
    const norm = addBase ? { quantity: addBase.amount, unit: addBase.unit } : { quantity: inc.quantity ?? 1, unit: inc.unit || 'st' };
    const item = { ...inc, ...norm };
    result.push(item);
    idx.set(key, result.length - 1);
    additions.push(item);
  }
  // updates die op toevoegingen slaan, horen bij de toevoeging zelf
  const addSet = new Set(additions);
  return { merged: result, updates: [...updates.values()].filter((u) => !addSet.has(result[u.index])), additions };
}

/**
 * Trekt aanwezige voorraad af van wat nodig is. Geeft per ingrediënt {...need, toBuy, fromPantry}.
 */
export function subtractPantry(needs, pantry) {
  const stock = new Map();
  for (const p of pantry) {
    const b = toBase(p.quantity ?? 1, p.unit);
    if (!b) continue;
    const k = nameKey(p.name) + '|' + b.unit;
    stock.set(k, (stock.get(k) || 0) + b.amount);
    stock.set(nameKey(p.name) + '|any', true);
  }
  return needs.map((n) => {
    const b = toBase(n.quantity ?? 1, n.unit);
    const key = nameKey(n.name);
    if (!b) return { ...n, toBuy: n.quantity, fromPantry: 0, inPantry: stock.has(key + '|any') };
    const k = key + '|' + b.unit;
    const have = stock.get(k) || 0;
    const used = Math.min(have, b.amount);
    if (used) stock.set(k, have - used);
    return { ...n, quantity: b.amount, unit: b.unit, toBuy: round(b.amount - used, 3), fromPantry: round(used, 3),
      inPantry: stock.has(key + '|any') };
  });
}

// --- productcategorieën ------------------------------------------------------------------
export const CATEGORIES = ['Groente & fruit', 'Brood & bakkerij', 'Zuivel & eieren', 'Kaas & vleeswaren', 'Vlees, vis & vega',
  'Pasta, rijst & wereld', 'Conserven & sauzen', 'Ontbijt & beleg', 'Snoep & koek', 'Dranken', 'Diepvries',
  'Huishouden', 'Verzorging', 'Baby & dier', 'Overig'];

const CAT_WORDS = [
  ['Groente & fruit', 'appel peer banaan sinaasappel citroen limoen druif aardbei framboos bes mango ananas kiwi meloen tomaat komkommer paprika ui sjalot knoflook prei wortel aardappel broccoli bloemkool spinazie sla andijvie courgette aubergine champignon paddenstoel kool spruit boon bonen sperzie avocado gember peterselie basilicum koriander bieslook munt rucola biet radijs selderij venkel pompoen zoete aardappel lente-ui'],
  ['Brood & bakkerij', 'brood bolletje bol pistolet croissant wrap tortilla stokbrood baguette beschuit cracker krentenbol pita naan ciabatta'],
  ['Zuivel & eieren', 'melk karnemelk yoghurt kwark vla room slagroom kookroom boter roomboter margarine ei eieren crème fraîche zure room skyr'],
  ['Kaas & vleeswaren', 'kaas mozzarella parmezaan feta geitenkaas brie ham salami rookvlees kipfilet beleg cervelaat leverworst'],
  ['Vlees, vis & vega', 'gehakt kip kipfilet kippendij rundvlees varkens biefstuk spek spekjes worst rookworst schnitzel zalm tonijn kabeljauw garnaal vis tofu tempeh vegetarisch vega burger shoarma lam'],
  ['Pasta, rijst & wereld', 'pasta spaghetti penne macaroni lasagne rijst noedel noodles couscous bulgur quinoa taco nasi bami kokosmelk sojasaus curry'],
  ['Conserven & sauzen', 'tomatenblokjes blokjes pesto tomatenpuree passata saus ketchup mayonaise mosterd bouillon blik bonen in blik mais olie olijfolie azijn pesto'],
  ['Ontbijt & beleg', 'hagelslag pindakaas jam muesli cornflakes havermout granola honing appelstroop chocopasta'],
  ['Snoep & koek', 'koek koekjes chocolade snoep chips nootjes noten drop'],
  ['Dranken', 'water frisdrank cola sap jus thee koffie bier wijn limonade'],
  ['Diepvries', 'diepvries ijs friet patat pizza diepvriesgroente'],
  ['Huishouden', 'wasmiddel afwasmiddel vaatwas tabletten wc-papier toiletpapier keukenrol schoonmaak allesreiniger vuilniszak aluminiumfolie bakpapier'],
  ['Verzorging', 'shampoo douchegel tandpasta deodorant zeep scheer maandverband tampons'],
  ['Baby & dier', 'luiers babyvoeding kattenvoer hondenvoer kattenbak'],
];
const CAT_INDEX = [];
for (const [cat, words] of CAT_WORDS) for (const w of words.split(' ')) CAT_INDEX.push([w, cat]);
CAT_INDEX.sort((a, b) => b[0].length - a[0].length);

export function guessCategory(name) {
  const n = ' ' + String(name || '').toLowerCase() + ' ';
  for (const [w, cat] of CAT_INDEX) {
    if (n.includes(' ' + w) || n.includes(w + ' ')) return cat;
  }
  return 'Overig';
}
