// Bijhouden welke boodschappen bij welke dag van het weekmenu horen, zodat een dag
// later precies weer van de lijst kan worden gehaald.
import { nameKey, scaleIngredients, guessCategory } from './ingredients.js';
import { toBase, round } from './units.js';

const IGNORE = new Set(['water', 'kraanwater', 'heet water', 'koud water', 'ijsblokjes']);

/**
 * Boodschappen per dag, met de voorraad op volgorde van de dagen verbruikt.
 * entries: [{id, recipe:{servings, ingredients}, servings}] — geeft [{entryId, items:[{name, key, quantity, unit}]}]
 */
export function planContributions(entries, pantry = []) {
  const stock = new Map();
  for (const p of pantry) {
    const b = toBase(p.quantity ?? 1, p.unit);
    if (!b) continue;
    const k = nameKey(p.name) + '|' + b.unit;
    stock.set(k, (stock.get(k) || 0) + b.amount);
  }
  return entries.map((e) => {
    const acc = new Map();
    const r = e.recipe;
    if (r) {
      for (const ing of scaleIngredients(r.ingredients || [], r.servings || e.servings, e.servings)) {
        if (ing.optional) continue;
        const key = nameKey(ing.name);
        if (IGNORE.has(key)) continue;
        const b = toBase(ing.quantity ?? 1, ing.unit || 'st') || { amount: 1, unit: 'st' };
        const k = key + '|' + b.unit;
        const cur = acc.get(k) || { name: ing.name, key, quantity: 0, unit: b.unit };
        cur.quantity = round(cur.quantity + b.amount, 3);
        acc.set(k, cur);
      }
    }
    const items = [];
    for (const [k, it] of acc) {
      const have = stock.get(k) || 0;
      const used = Math.min(have, it.quantity);
      if (used) stock.set(k, have - used);
      const rest = round(it.quantity - used, 3);
      if (rest > 0) items.push({ ...it, quantity: rest });
    }
    return { entryId: e.id, items };
  });
}

/**
 * Zet de boodschappen van alle dagen samen met de bestaande (niet afgevinkte) lijst.
 * Geeft {updates:[{id, quantity, unit}], inserts:[{tmp, name, quantity, unit, category}], contribs:{entryId:[{ref, quantity, unit}]}}
 * ref is een bestaand list_item-id of een tijdelijke sleutel ("tmp:n") van een nieuwe regel.
 */
export function mergePlanIntoList(existing, perEntry) {
  const byKey = new Map();
  for (const it of existing) {
    if (it.checked) continue;
    const b = toBase(Number(it.quantity ?? 1), it.unit);
    if (!b) continue;
    const k = nameKey(it.name) + '|' + b.unit;
    if (!byKey.has(k)) byKey.set(k, { ref: it.id, quantity: b.amount, unit: b.unit, existing: true });
  }
  const inserts = [], contribs = {};
  let n = 0;
  for (const { entryId, items } of perEntry) {
    contribs[entryId] = [];
    for (const it of items) {
      const k = it.key + '|' + it.unit;
      let row = byKey.get(k);
      if (!row) {
        row = { ref: `tmp:${n++}`, quantity: 0, unit: it.unit, existing: false };
        byKey.set(k, row);
        inserts.push({ tmp: row.ref, name: it.name, quantity: 0, unit: it.unit, category: guessCategory(it.name) });
      }
      row.quantity = round(row.quantity + it.quantity, 3);
      row.changed = true;
      contribs[entryId].push({ ref: row.ref, quantity: it.quantity, unit: it.unit });
    }
  }
  for (const ins of inserts) ins.quantity = byKey.get([...byKey.keys()].find((k) => byKey.get(k).ref === ins.tmp)).quantity;
  const updates = [...byKey.values()].filter((r) => r.existing && r.changed).map((r) => ({ id: r.ref, quantity: r.quantity, unit: r.unit }));
  return { updates, inserts, contribs };
}

/**
 * Wat moet er van de lijst af als een dag wordt verwijderd?
 * listItems: huidige regels; contrib: [{ref(id), quantity, unit}] — geeft {updates:[{id, quantity}], deletes:[id], kept:n}
 * Afgevinkte regels (al gekocht) blijven staan.
 */
export function removalOps(listItems, contrib) {
  const byId = new Map(listItems.map((i) => [i.id, i]));
  const left = new Map();
  let kept = 0;
  for (const c of contrib) {
    const it = byId.get(c.ref);
    if (!it) continue;
    if (it.checked) { kept++; continue; }
    const b = toBase(Number(it.quantity ?? 1), it.unit);
    if (!b || b.unit !== c.unit) { kept++; continue; }
    const cur = left.has(it.id) ? left.get(it.id) : b.amount;
    left.set(it.id, round(cur - c.quantity, 3));
  }
  const updates = [], deletes = [];
  for (const [id, q] of left) (q <= 0.001 ? deletes.push(id) : updates.push({ id, quantity: q }));
  return { updates, deletes, kept };
}

/** Voor weekmenu's die zijn goedgekeurd vóórdat bijgehouden werd per dag: zoek de regels met bron "weekmenu". */
export function fallbackContrib(listItems, perEntryItems) {
  const out = [];
  const pool = listItems.filter((i) => !i.checked && /weekmenu/i.test(i.source || ''));
  for (const it of perEntryItems) {
    const match = pool.find((p) => nameKey(p.name) === it.key && toBase(Number(p.quantity ?? 1), p.unit)?.unit === it.unit);
    if (match) out.push({ ref: match.id, quantity: it.quantity, unit: it.unit });
  }
  return out;
}
