// Berekent de drie winkelscenario's: één winkel, goedkoopste combinatie, beste balans prijs/reistijd/gemak.
import { toBase, round } from './units.js';
import { costForPacks } from './offers.js';
import { bestRoute } from './geo.js';

/** Hoeveel verpakkingen van `product` zijn nodig voor `item`? */
export function packsNeeded(item, product) {
  const need = toBase(item.quantity ?? 1, item.unit || 'st');
  if (!need) return { packs: 1, approx: true };
  if (product.amount && product.unit && need.unit === product.unit) {
    if (need.unit === 'st' && product.amount === 1) return { packs: Math.max(1, Math.ceil(need.amount - 1e-9)), approx: false };
    return { packs: Math.max(1, Math.ceil(need.amount / product.amount - 1e-9)), approx: false };
  }
  // Lijst zegt "2 st" (bijv. 2 pakken melk) en product is in ml/g: aantal = aantal verpakkingen
  if (need.unit === 'st') return { packs: Math.max(1, Math.ceil(need.amount - 1e-9)), approx: !product.amount };
  return { packs: 1, approx: true };
}

/** Goedkoopste optie voor één item bij één winkel (rekening houdend met acties). */
export function bestAtStore(item, candidates, store, opts = {}) {
  let best = null;
  let list = candidates || [];
  // Heeft iemand een specifiek product gekozen? Dan alleen dat product.
  if (item.pinned_product_id && list.some((c) => c.id === item.pinned_product_id)) list = list.filter((c) => c.id === item.pinned_product_id);
  for (const c of list) {
    if (c.store !== store) continue;
    const { packs, approx } = packsNeeded(item, c);
    const cost = costForPacks(Number(c.price), packs, c.offer, opts);
    if (!best || cost.total < best.total) best = { ...cost, product: c, packs, approx, store };
  }
  return best;
}

/** Plan voor een vaste set winkels: per item de goedkoopste winkel binnen de set. */
export function planForStores(items, candMap, stores, opts = {}) {
  const assignments = [];
  let total = 0, regular = 0, offerSavings = 0;
  const missing = [];
  const used = new Set();
  for (const it of items) {
    let best = null;
    for (const s of stores) {
      const b = bestAtStore(it, candMap[it.id], s, opts);
      if (b && (!best || b.total < best.total)) best = b;
    }
    if (best) {
      assignments.push({ item: it, ...best });
      total += best.total; regular += best.regular; offerSavings += best.savings;
      used.add(best.store);
    } else {
      missing.push(it);
      assignments.push({ item: it, store: null });
    }
  }
  return { stores: [...used], total: round(total, 2), regular: round(regular, 2), offerSavings: round(offerSavings, 2), missing, assignments };
}

/** Gemiddelde prijs per item over alle winkels die het hebben (referentie voor "besparing"). */
export function averageCost(items, candMap, stores, opts = {}) {
  const per = {};
  for (const it of items) {
    const vals = stores.map((s) => bestAtStore(it, candMap[it.id], s, { ...opts, useCard: false })).filter(Boolean).map((b) => b.regular);
    per[it.id] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return per;
}

function* subsets(arr, maxK) {
  const n = arr.length;
  function* rec(start, acc) {
    if (acc.length) yield acc.slice();
    if (acc.length === maxK) return;
    for (let i = start; i < n; i++) { acc.push(arr[i]); yield* rec(i + 1, acc); acc.pop(); }
  }
  yield* rec(0, []);
}

const SPEED = { car: 35, bike: 15, walk: 5 }; // km/u gemiddeld in de bebouwde kom

export function travelFor(stores, ctx) {
  if (!ctx.home || !stores.length) return null;
  const pts = stores.map((s) => ctx.locations?.[s]).filter(Boolean);
  if (pts.length !== stores.length) return null;
  const r = bestRoute(ctx.home, pts);
  const km = round(r.km * 1.3, 1); // hemelsbreed × 1,3 ≈ over de weg (schatting)
  const minutes = Math.round((km / (SPEED[ctx.mode] || 35)) * 60);
  const cost = ctx.mode === 'car' ? round(km * (ctx.costPerKm ?? 0.23), 2) : 0;
  const timeCost = round((minutes / 60) * (ctx.timeValue ?? 0), 2);
  return { km, minutes, cost, timeCost, order: r.order.map((i) => stores[i]), estimate: true };
}

/**
 * items: [{id,name,quantity,unit,pinned_product_id}]
 * candMap: {itemId: [{id,store,name,price,amount,unit,unit_price,checked_at,offer}]}
 * ctx: {stores:[...], maxStores, home:{lat,lng}, locations:{store:{lat,lng}}, mode, costPerKm, timeValue, perStorePenalty}
 */
export function computeScenarios(items, candMap, ctx) {
  const opts = { useCard: ctx.useCard !== false };
  const available = ctx.stores.filter((s) => items.some((it) => (candMap[it.id] || []).some((c) => c.store === s)));
  const avg = averageCost(items, candMap, available, opts);
  const withSavings = (plan) => {
    let ref = 0;
    for (const a of plan.assignments) if (a.store && avg[a.item.id] != null) ref += avg[a.item.id];
    const travel = travelFor(plan.stores, ctx);
    return { ...plan, reference: round(ref, 2), savingsVsAverage: round(ref - plan.total, 2), travel };
  };

  // 1. Alles bij één winkel
  const single = available.map((s) => planForStores(items, candMap, [s], opts))
    .sort((a, b) => a.missing.length - b.missing.length || a.total - b.total);
  const singleRanked = single.map((p) => ({ ...withSavings(p), store: p.stores[0] || null }));

  // 2. Goedkoopste combinatie (max winkels), puur op prijs
  const maxK = Math.max(1, Math.min(ctx.maxStores || 3, available.length));
  let cheapest = null;
  for (const set of subsets(available, maxK)) {
    const p = planForStores(items, candMap, set, opts);
    if (!cheapest || p.missing.length < cheapest.missing.length ||
        (p.missing.length === cheapest.missing.length && (p.total < cheapest.total - 0.005 ||
          (Math.abs(p.total - cheapest.total) < 0.005 && p.stores.length < cheapest.stores.length)))) cheapest = p;
  }

  // 3. Beste balans: prijs + reiskosten + tijd + gemak (€ per extra winkel)
  const penalty = ctx.perStorePenalty ?? 1.5;
  let balanced = null;
  for (const set of subsets(available, maxK)) {
    const p = planForStores(items, candMap, set, opts);
    if (p.stores.length < set.length) continue; // set met ongebruikte winkel: telt al als kleinere set
    const t = travelFor(p.stores, ctx);
    const score = p.total + (t ? t.cost + t.timeCost : 0) + penalty * Math.max(0, p.stores.length - 1);
    if (!balanced || p.missing.length < balanced.plan.missing.length ||
        (p.missing.length === balanced.plan.missing.length && score < balanced.score)) balanced = { plan: p, score };
  }

  return {
    available,
    single: singleRanked,
    cheapest: cheapest ? withSavings(cheapest) : null,
    balanced: balanced ? { ...withSavings(balanced.plan), score: round(balanced.score, 2) } : null,
    unpriced: items.filter((it) => !(candMap[it.id] || []).length),
  };
}
