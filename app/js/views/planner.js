// Weekplanner: automatisch goedkoop weekmenu op basis van recepten, acties, voorraad en budget.
import { html, setHTML, toast, errorText, formData, num, loading, isoDate, weekStart, dateNL, confirmDialog, debounce } from '../ui.js';
import { sb, q, hid, state, onChange } from '../api.js';
import { buildMenu, aggregateNeeds, costNeeds, shoppingForMenu } from '../lib/menu.js';
import { euro, formatQty } from '../lib/units.js';
import { priceIndexFor, storeName } from '../pricing.js';
import { loadRecipes } from './recipes.js';
import { addToList, defaultListId } from './list.js';

export async function render(el) {
  setHTML(el, html`<h1>Weekmenu</h1><div id="plans"></div><div id="gen"></div><div id="result"></div>`);
  const [recipes, pantry, budgetRows] = await Promise.all([
    loadRecipes(), q(sb.from('pantry_items').select('*').eq('household_id', hid())),
    q(sb.from('budgets').select('*').eq('household_id', hid())),
  ]);
  const budget = budgetRows[0];
  const nextMonday = weekStart(new Date(Date.now() + 7 * 86400e3));

  async function drawPlans() {
    const plans = await q(sb.from('meal_plans').select('*, meal_plan_entries(*)').eq('household_id', hid()).order('week_start', { ascending: false }).limit(4));
    const byId = Object.fromEntries(recipes.map((r) => [r.id, r]));
    setHTML(el.querySelector('#plans'), plans.length ? html`${plans.map((p) => html`<div class="card">
      <div class="row between"><h2>Week van ${dateNL(p.week_start, { day: 'numeric', month: 'long' })}</h2>
        <span class="badge ${p.status === 'goedgekeurd' ? 'ok' : ''}">${p.status}</span></div>
      <div class="small muted">${p.persons} personen${p.est_cost != null ? ' · verwacht ' + euro(Number(p.est_cost)) : ''}</div>
      ${p.meal_plan_entries.sort((a, b) => a.day - b.day).map((e) => html`<div class="day"><b>${dateNL(addDays(p.week_start, e.day), { weekday: 'short', day: 'numeric' })}</b>
        <span>${byId[e.recipe_id]?.title || html`<span class="muted">verwijderd recept</span>`}</span></div>`)}
      <div class="row" style="margin-top:.6rem">${p.status !== 'goedgekeurd' ? html`<button class="btn small" data-approve="${p.id}">Goedkeuren → boodschappenlijst</button>` : ''}
        <button class="btn small ghost" data-delplan="${p.id}">Verwijderen</button></div></div>`)}` : '');
    el.querySelector('#plans').onclick = async (e) => {
      const a = e.target.closest('[data-approve]'), d = e.target.closest('[data-delplan]');
      try {
        if (a) { const p = plans.find((x) => x.id === a.dataset.approve); await approve(p.id, p.meal_plan_entries.map((x) => byId[x.recipe_id]).filter(Boolean), p.persons); }
        if (d && await confirmDialog('Dit weekmenu verwijderen?', 'Verwijderen')) { await q(sb.from('meal_plans').delete().eq('id', d.dataset.delplan)); drawPlans(); }
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }

  async function approve(planId, recs, persons) {
    const items = shoppingForMenu(recs, persons, pantry);
    const res = await addToList(await defaultListId(), items, 'weekmenu');
    await q(sb.from('meal_plans').update({ status: 'goedgekeurd' }).eq('id', planId));
    toast(`Boodschappenlijst bijgewerkt: ${res.added} nieuw, ${res.merged} opgeteld`);
    drawPlans();
  }

  setHTML(el.querySelector('#gen'), html`<form class="card" id="gf"><h2>Nieuw menu samenstellen</h2>
    ${recipes.length < 3 ? html`<p class="notice warn">Er ${recipes.length === 1 ? 'is 1 recept' : `zijn ${recipes.length} recepten`}. Voeg meer recepten toe voor een gevarieerd menu.
      <a href="#/recepten">Naar recepten</a></p>` : ''}
    <div class="fields">
      <div class="field"><label>Week vanaf</label><input type="date" name="week" value="${isoDate(nextMonday)}"></div>
      <div class="field"><label>Personen</label><input name="persons" inputmode="numeric" value="${Math.max(1, state.members.length || 2)}"></div>
      <div class="field"><label>Dagen</label><input name="days" inputmode="numeric" value="7"></div>
      <div class="field"><label>Max. budget (€)</label><input name="budget" inputmode="decimal" value="${budget?.weekly != null ? String(budget.weekly).replace('.', ',') : ''}"></div>
    </div>
    <div class="field"><label>Voorkeuren (labels die verplicht zijn, of "geen …")</label><input name="prefs" placeholder="bijv. vegetarisch, geen vis, geen champignons"></div>
    <p class="small muted">Voorraad wordt automatisch meegenomen (${pantry.length} producten in de voorraadkast).</p>
    <button class="btn block" ${recipes.length ? '' : 'disabled'}>Stel goedkoop menu samen</button></form>`);

  el.querySelector('#gf').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const opts = { persons: Math.max(1, Math.round(num(f.persons, 2))), days: Math.min(14, Math.max(1, Math.round(num(f.days, 7)))),
      budget: num(f.budget), preferences: f.prefs.split(',').map((x) => x.trim()).filter(Boolean), week: f.week };
    const out = el.querySelector('#result');
    setHTML(out, loading('Recepten en actuele prijzen combineren…'));
    try {
      const names = [...new Set(recipes.flatMap((r) => r.ingredients.map((i) => i.name)))];
      const priceIndex = await priceIndexFor(names);
      const menu = buildMenu({ recipes, pantry, priceIndex, ...opts });
      if (menu.error) { setHTML(out, html`<p class="notice warn">${menu.error}</p>`); return; }
      showResult(out, menu, opts, priceIndex);
      out.scrollIntoView({ behavior: 'smooth' });
    } catch (err) { setHTML(out, html`<p class="notice danger">${errorText(err)}</p>`); }
  };

  function showResult(out, menu, opts, priceIndex) {
    const chosen = menu.entries.map((e) => e.recipe);
    const draw = () => {
      const plan = costNeeds(aggregateNeeds(chosen, opts.persons), priceIndex, pantry);
      const over = opts.budget != null && plan.total > opts.budget;
      setHTML(out, html`<div class="card"><h2>Voorstel</h2>
        <div class="grid three" style="margin-bottom:.8rem">
          <div class="stat"><span class="v">${euro(plan.total)}</span><span class="l">verwachte kosten${plan.unpriced.length ? ' (onvolledig)' : ''}</span></div>
          <div class="stat"><span class="v">${euro(Math.max(0, plan.regular - plan.total))}</span><span class="l">besparing door acties</span></div>
          <div class="stat"><span class="v">${menu.sharedIngredients}</span><span class="l">gedeelde ingrediënten</span></div>
        </div>
        ${over ? html`<p class="notice danger">Boven budget: ${euro(plan.total)} van ${euro(opts.budget)}. Kies goedkopere alternatieven hieronder.</p>`
          : opts.budget != null ? html`<p class="notice">Binnen budget: ${euro(opts.budget - plan.total)} over.</p>` : ''}
        ${plan.unpriced.length ? html`<p class="notice warn">Geen prijs bekend voor: ${plan.unpriced.map((u) => u.name).join(', ')}. Die zitten niet in het totaal.</p>` : ''}
        ${chosen.map((r, d) => {
          const alts = menu.entries[d].alternatives.filter((a) => a.recipe.id !== r.id);
          return html`<div class="day"><b>${dateNL(addDays(opts.week, d), { weekday: 'short', day: 'numeric' })}</b>
            <div><select data-day="${d}">${recipes.map((x) => html`<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${x.title}</option>`)}</select>
            ${alts.filter((a) => a.delta < 0).slice(0, 2).map((a) => html`<button class="chip" data-swap="${d}:${a.recipe.id}">💡 ${a.recipe.title} (${euro(a.delta)})</button>`)}</div></div>`;
        })}
        <details style="margin-top:.8rem"><summary>Boodschappen voor dit menu (${plan.lines.filter((l) => !l.covered).length})</summary>
          <div class="table-wrap"><table><tbody>${plan.lines.map((l) => html`<tr><td>${l.name}${l.covered ? html` <span class="badge ok">in voorraad</span>` : ''}
            ${l.leftover > 0 ? html`<br><span class="small muted">restje: ${formatQty(l.leftover, l.unit)}</span>` : ''}</td>
            <td class="num">${formatQty(l.toBuy ?? l.quantity, l.unit)}</td>
            <td class="num">${l.cost != null ? html`${euro(l.cost)}<br><span class="small muted">${l.store ? storeName(l.store) : ''}</span>` : l.covered ? '' : html`<span class="badge warn">geen prijs</span>`}</td></tr>`)}</tbody></table></div></details>
        <div class="row" style="margin-top:1rem"><button class="btn" data-save="approve">Goedkeuren → boodschappenlijst</button><button class="btn ghost" data-save="concept">Bewaren als concept</button></div>
        <p class="small muted">Kosten zijn berekend met de goedkoopste actuele prijs per ingrediënt, inclusief jullie ingevoerde acties, en houden rekening met hele verpakkingen.</p></div>`);
    };
    draw();
    out.onchange = (e) => { const s = e.target.closest('[data-day]'); if (s) { chosen[+s.dataset.day] = recipes.find((x) => x.id === s.value); draw(); } };
    out.onclick = async (e) => {
      const sw = e.target.closest('[data-swap]');
      if (sw) { const [d, id] = sw.dataset.swap.split(':'); chosen[+d] = recipes.find((x) => x.id === id); draw(); return; }
      const sv = e.target.closest('[data-save]');
      if (!sv) return;
      sv.disabled = true;
      try {
        const plan = costNeeds(aggregateNeeds(chosen, opts.persons), priceIndex, pantry);
        const [p] = await q(sb.from('meal_plans').insert({ household_id: hid(), week_start: opts.week, persons: opts.persons, days: chosen.length,
          budget: opts.budget, preferences: opts.preferences, est_cost: plan.total }).select());
        await q(sb.from('meal_plan_entries').insert(chosen.map((r, d) => ({ plan_id: p.id, household_id: hid(), day: d, recipe_id: r.id, servings: opts.persons }))));
        if (sv.dataset.save === 'approve') await approve(p.id, chosen, opts.persons); else { toast('Concept bewaard'); drawPlans(); }
        out.innerHTML = '';
      } catch (err) { toast(errorText(err), 'error'); sv.disabled = false; }
    };
  }

  await drawPlans();
  return onChange(['meal_plans', 'meal_plan_entries'], debounce(() => drawPlans().catch(() => {}), 400));
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
