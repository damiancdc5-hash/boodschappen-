// Dashboard: in één oogopslag de lijst, het budget, het menu van vandaag, voorraadwaarschuwingen en prijsdata.
import { html, setHTML, isoDate, weekStart, timeAgo, debounce, errorText } from '../ui.js';
import { sb, q, hid, state, onChange } from '../api.js';
import { euro } from '../lib/units.js';
import { priceStatus, enabledStores, storeName, loadOffers } from '../pricing.js';
import { offerDiscount } from '../lib/offers.js';
import { offerCard, offersForItems } from './offers.js';
import { budgetSnapshot } from './budget.js';
import { daysLeft } from './pantry.js';

export async function render(el) {
  const load = async () => {
    const today = isoDate();
    const [items, pantry, snap, plans, ps, offers] = await Promise.all([
      q(sb.from('list_items').select('id, name, checked, list_id').eq('household_id', hid())),
      q(sb.from('pantry_items').select('name, expires_on').eq('household_id', hid()).not('expires_on', 'is', null)),
      budgetSnapshot(),
      q(sb.from('meal_plans').select('id, week_start, status, meal_plan_entries(day, recipe_id, recipes(title))').eq('household_id', hid())
        .lte('week_start', today).order('week_start', { ascending: false }).limit(2)),
      priceStatus().catch(() => null),
      loadOffers().catch(() => []),
    ]);
    const open = items.filter((i) => !i.checked).length;
    const soon = pantry.filter((p) => daysLeft(p.expires_on) <= 3);
    let todayMeal = null;
    for (const p of plans) {
      const d = Math.round((new Date(today) - new Date(p.week_start)) / 86400e3);
      const e = p.meal_plan_entries.find((x) => x.day === d);
      if (e) { todayMeal = e.recipes?.title; break; }
    }
    const wb = snap.budget.weekly != null ? Number(snap.budget.weekly) : null;
    const used = snap.week.spent + snap.plannedWeek;
    const pct = wb ? Math.min(100, (used / wb) * 100) : 0;
    const warn = snap.budget.warn_pct || 85;
    const missingStores = ps ? enabledStores().filter((s) => !ps.stores[s]) : [];
    const lastSync = ps?.lastRun?.finished_at || ps?.lastRun?.started_at;
    const hour = new Date().getHours();
    const myOffers = offers.filter((o) => enabledStores().includes(o.store));
    const top = myOffers.filter((o) => offerDiscount(o) != null).sort((a, b) => (!!b.image_url - !!a.image_url) || (offerDiscount(b) - offerDiscount(a))).slice(0, 10);
    const forList = offersForItems(items.filter((i) => !i.checked), myOffers);
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
    setHTML(el, html`<h1>${hour < 12 ? 'Goedemorgen' : hour < 18 ? 'Goedemiddag' : 'Goedenavond'}, ${state.profile?.display_name || ''}</h1>
      <div class="grid two">
        <a class="card" href="#/lijst" style="text-decoration:none;color:inherit"><div class="stat"><span class="v">${open}</span><span class="l">producten op de boodschappenlijst</span></div></a>
        <a class="card" href="#/budget" style="text-decoration:none;color:inherit"><div class="stat"><span class="v">${wb ? euro(wb - used) : euro(snap.week.spent)}</span>
          <span class="l">${wb ? 'over van het weekbudget' : 'uitgegeven deze week'}</span></div>
          ${wb ? html`<div class="progress ${used > wb ? 'over' : pct >= warn ? 'warn' : ''}" style="margin-top:.5rem"><div style="width:${pct}%"></div></div>` : ''}</a>
      </div>
      ${wb && used > wb ? html`<p class="notice danger">Let op: het weekbudget is overschreden (${euro(used)} van ${euro(wb)}).</p>`
        : wb && pct >= warn ? html`<p class="notice warn">Het weekbudget is bijna bereikt (${Math.round(pct)}%).</p>` : ''}
      <div class="grid two">
        <a class="card" href="#/weekmenu" style="text-decoration:none;color:inherit"><h2>🍽️ Vandaag</h2><p>${todayMeal || html`<span class="muted">Geen menu gepland. Stel een goedkoop weekmenu samen.</span>`}</p></a>
        <a class="card" href="#/voorraad" style="text-decoration:none;color:inherit"><h2>🥫 Voorraad</h2>${soon.length ? html`<p>Bijna over datum: <b>${soon.map((s) => s.name).join(', ')}</b></p>` : html`<p class="muted">Niets dat binnenkort verloopt.</p>`}</a>
      </div>
      ${myOffers.length ? html`<div class="card"><div class="row between"><h2 style="margin:0">🏷️ Topaanbiedingen</h2><a href="#/aanbiedingen" class="small">Alle ${myOffers.length} bekijken →</a></div>
        ${forList.length ? html`<p class="small" style="margin:.3rem 0 .6rem">🎯 <a href="#/aanbiedingen">${forList.length} actie(s)</a> voor producten op jullie lijst.</p>` : html`<div style="height:.6rem"></div>`}
        <div class="scroll-row">${top.map((o) => offerCard(o, { compact: true }))}</div></div>` : ''}
      <div class="card"><h2>💶 Besparing deze maand</h2><div class="grid two">
        <div class="stat"><span class="v">${euro(snap.month.offer)}</span><span class="l">door aanbiedingen</span></div>
        <div class="stat"><span class="v">${euro(snap.month.compare)}</span><span class="l">t.o.v. gemiddelde supermarktprijs</span></div></div></div>
      <div class="card"><h2>Snel naar</h2><div class="row">
        <a class="btn" href="#/prijzen">Goedkoopste winkel voor mijn lijst</a><a class="btn ghost" href="#/recepten">Recept toevoegen</a>
        <a class="btn ghost" href="#/route">Winkelroute</a></div></div>
      <p class="small muted">Prijsdata: ${lastSync ? `laatst bijgewerkt ${timeAgo(lastSync)}` : 'nog niet ingeladen'}${missingStores.length ? ` · geen prijsdata voor ${missingStores.map(storeName).join(', ')}` : ''}.</p>
      ${isIos ? html`<p class="notice small">Tip: zet deze app op je beginscherm via de deelknop → "Zet op beginscherm".</p>` : ''}
      <button class="btn ghost install-only" onclick="window.__installPrompt && window.__installPrompt.prompt()">📲 Installeer de app</button>`);
  };
  try { await load(); } catch (e) { setHTML(el, html`<p class="notice danger">${errorText(e)}</p>`); }
  return onChange(['list_items', 'purchases', 'budgets', 'pantry_items', 'meal_plans', 'meal_plan_entries', 'refresh'], debounce(() => load().catch(() => {}), 500));
}
export { weekStart };
