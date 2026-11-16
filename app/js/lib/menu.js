// Automatisch goedkoop weekmenu: kiest recepten die samen zo weinig mogelijk kosten,
// ingrediënten delen (minder restjes) en de voorraad gebruiken.
import { nameKey, scaleIngredients, subtractPantry } from './ingredients.js';
import { toBase, round } from './units.js';
import { costForPacks } from './offers.js';

const IGNORE = new Set(['water', 'kraanwater', 'heet water', 'koud water', 'ijsblokjes']);

/** Alle (niet-optionele) ingrediënten van een set recepten, geschaald naar `persons` en samengevoegd per naam+eenheid. */
export function aggregateNeeds(recipes, persons) {
  const acc = new Map();
  for (const r of recipes) {
    const scaled = scaleIngredients(r.ingredients || [], r.servings || persons, persons);
    for (const ing of scaled) {
      if (ing.optional) continue;
      const key = nameKey(ing.name);
      if (IGNORE.has(key)) continue;
      const b = toBase(ing.quantity ?? 1, ing.unit || 'st') || { amount: 1, unit: 'st' };
      const k = key + '|' + b.unit;
      const cur = acc.get(k) || { key, name: ing.name, quantity: 0, unit: b.unit, recipes: new Set() };
      cur.quantity = round(cur.quantity + b.amount, 3);
      cur.recipes.add(r.id);
      acc.set(k, cur);
    }
  }
  return [...acc.values()].map((x) => ({ ...x, recipes: [...x.recipes] }));
}

/** priceIndex: Map(nameKey → {price, amount, unit, offer, store, product}) */
export function costNeeds(needs, priceIndex, pantry = []) {
  const afterPantry = subtractPantry(needs, pantry);
  let total = 0, regular = 0, leftoverValue = 0;
  const lines = [], unpriced = [];
  for (const n of afterPantry) {
    if (n.toBuy <= 0) { lines.push({ ...n, cost: 0, packs: 0, covered: true }); continue; }
    const p = priceIndex.get(n.key);
    if (!p) { unpriced.push(n); lines.push({ ...n, cost: null }); continue; }
    let packs = 1;
    if (p.amount && p.unit === n.unit) packs = Math.max(1, Math.ceil(n.toBuy / p.amount - 1e-9));
    else if (n.unit === 'st') packs = Math.max(1, Math.ceil(n.toBuy - 1e-9));
    const c = costForPacks(Number(p.price), packs, p.offer);
    const bought = p.amount && p.unit === n.unit ? c.packsTaken * p.amount : null;
    const leftover = bought != null ? round(bought - n.toBuy, 3) : null;
    if (leftover && p.amount) leftoverValue += (leftover / p.amount) * (c.total / c.packsTaken);
    total += c.total; regular += c.regular;
    lines.push({ ...n, cost: c.total, regular: c.regular, packs: c.packsTaken, leftover, store: p.store, product: p.product, offer: p.offer });
  }
  return { total: round(total, 2), regular: round(regular, 2), leftoverValue: round(leftoverValue, 2), lines, unpriced };
}

/** Voorkeuren als tekst: tags die verplicht zijn (bijv. "vegetarisch") en "geen X" uitsluitingen. */
export function parsePreferences(prefs = []) {
  const require = [], exclude = [];
  for (const raw of prefs) {
    const p = String(raw).trim().toLowerCase();
    if (!p) continue;
    const m = p.match(/^(geen|zonder|niet)\s+(.+)$/);
    if (m) exclude.push(m[2]); else require.push(p);
  }
  return { require, exclude };
}

export function recipeAllowed(r, { require, exclude }) {
  const tags = (r.tags || []).map((t) => t.toLowerCase());
  if (require.some((t) => !tags.includes(t))) return false;
  const text = (r.ingredients || []).map((i) => i.name.toLowerCase()).join(' | ') + ' | ' + r.title.toLowerCase();
  if (exclude.some((x) => text.includes(x))) return false;
  return true;
}

/**
 * Stelt het menu samen.
 * opts: {recipes, persons, days, budget, preferences, pantry, priceIndex}
 */
export function buildMenu({ recipes, persons = 2, days = 7, budget = null, preferences = [], pantry = [], priceIndex }) {
  const pref = parsePreferences(preferences);
  const eligible = recipes.filter((r) => (r.ingredients || []).length && recipeAllowed(r, pref));
  if (!eligible.length) return { error: 'Geen recepten die passen bij de voorkeuren. Voeg eerst recepten toe of pas de voorkeuren aan.' };

  const evalPlan = (sel) => {
    const c = costNeeds(aggregateNeeds(sel, persons), priceIndex, pantry);
    // ongeprijsde ingrediënten maken een plan onzeker: kleine straf zodat geprijsde recepten de voorkeur krijgen
    return { ...c, score: c.total + c.leftoverValue * 0.5 + c.unpriced.length * 2 };
  };
  const repeatPenalty = (sel, r) => sel.filter((x) => x.id === r.id).length * 3;

  const chosen = [];
  for (let d = 0; d < days; d++) {
    let best = null;
    const unused = eligible.filter((r) => !chosen.some((c) => c.id === r.id));
    const pool = unused.length ? unused : eligible;
    for (const r of pool) {
      const sc = evalPlan([...chosen, r]).score + repeatPenalty(chosen, r);
      if (!best || sc < best.sc) best = { r, sc };
    }
    chosen.push(best.r);
  }
  // lokale verbetering: probeer per dag een ander recept
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let d = 0; d < chosen.length; d++) {
      const base = evalPlan(chosen).score;
      for (const r of eligible) {
        if (r.id === chosen[d].id) continue;
        const others = chosen.filter((_, i) => i !== d);
        if (others.some((c) => c.id === r.id) && eligible.length >= days) continue;
        const trial = chosen.slice(); trial[d] = r;
        if (evalPlan(trial).score < base - 0.01) { chosen[d] = r; improved = true; break; }
      }
    }
    if (!improved) break;
  }

  const plan = evalPlan(chosen);
  const entries = chosen.map((r, day) => {
    const alone = costNeeds(aggregateNeeds([r], persons), priceIndex, pantry);
    // alternatieven die het hele plan goedkoper of nauwelijks duurder maken
    const alts = [];
    for (const a of eligible) {
      if (chosen.some((c) => c.id === a.id)) continue;
      const trial = chosen.slice(); trial[day] = a;
      const t = evalPlan(trial);
      alts.push({ recipe: a, delta: round(t.total - plan.total, 2) });
    }
    alts.sort((x, y) => x.delta - y.delta);
    return { day, recipe: r, estCost: alone.total, unpriced: alone.unpriced.length, alternatives: alts.slice(0, 3) };
  });
  const shared = aggregateNeeds(chosen, persons).filter((n) => n.recipes.length > 1).length;
  return {
    entries, total: plan.total, regular: plan.regular, leftoverValue: plan.leftoverValue,
    unpriced: plan.unpriced, lines: plan.lines, sharedIngredients: shared,
    overBudget: budget != null && plan.total > budget, budget,
  };
}

/** Boodschappen die nodig zijn voor een (aangepast) menu, na aftrek van voorraad. */
export function shoppingForMenu(recipes, persons, pantry) {
  const needs = aggregateNeeds(recipes, persons);
  return subtractPantry(needs, pantry).filter((n) => n.toBuy > 0)
    .map((n) => ({ name: n.name, quantity: n.toBuy, unit: n.unit }));
}
