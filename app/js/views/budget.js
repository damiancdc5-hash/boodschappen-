// Budgetbeheer: weekbudget/maandbudget, gepland vs. werkelijk, besparingen en grafieken.
import { html, setHTML, toast, errorText, modal, formData, num, isoDate, weekStart, dateNL, confirmDialog, debounce, raw, esc } from '../ui.js';
import { sb, q, hid, isAdmin, onChange, memberName } from '../api.js';
import { euro } from '../lib/units.js';
import { STORES, storeName } from '../pricing.js';

export function periodTotals(purchases, from, to) {
  const rows = purchases.filter((p) => p.purchased_on >= from && p.purchased_on < to);
  const sum = (k) => Math.round(rows.reduce((a, p) => a + Number(p[k] || 0), 0) * 100) / 100;
  return { spent: sum('amount'), offer: sum('offer_savings'), compare: sum('compare_savings'), count: rows.length };
}

export async function budgetSnapshot() {
  const ws = weekStart(), we = new Date(ws); we.setDate(we.getDate() + 7);
  const ms = new Date(); ms.setDate(1); const me = new Date(ms); me.setMonth(me.getMonth() + 1);
  const since = new Date(); since.setMonth(since.getMonth() - 7);
  const [budgets, purchases, plans] = await Promise.all([
    q(sb.from('budgets').select('*').eq('household_id', hid())),
    q(sb.from('purchases').select('*').eq('household_id', hid()).gte('purchased_on', isoDate(since)).order('purchased_on', { ascending: false })),
    q(sb.from('meal_plans').select('week_start, est_cost, status').eq('household_id', hid()).gte('week_start', isoDate(ws)).lt('week_start', isoDate(we))),
  ]);
  const b = budgets[0] || {};
  const week = periodTotals(purchases, isoDate(ws), isoDate(we));
  const month = periodTotals(purchases, isoDate(ms), isoDate(me));
  const plannedWeek = plans.reduce((a, p) => a + Number(p.est_cost || 0), 0);
  return { budget: b, purchases, week, month, plannedWeek, ws, ms };
}

function bar(label, spent, planned, budget, warnPct) {
  const pct = budget ? Math.min(100, ((spent + planned) / budget) * 100) : 0;
  const cls = budget && spent + planned > budget ? 'over' : budget && (spent + planned) / budget * 100 >= warnPct ? 'warn' : '';
  return html`<div class="card"><div class="row between"><h2>${label}</h2>${budget ? html`<span class="badge ${cls === 'over' ? 'danger' : cls === 'warn' ? 'warn' : 'ok'}">
      ${cls === 'over' ? '⚠ over budget' : cls === 'warn' ? '⚠ bijna op' : '✓ op koers'}</span>` : ''}</div>
    <div class="grid three"><div class="stat"><span class="v">${budget ? euro(budget) : '—'}</span><span class="l">budget</span></div>
      <div class="stat"><span class="v">${euro(spent)}</span><span class="l">uitgegeven</span></div>
      <div class="stat"><span class="v">${budget ? euro(budget - spent - planned) : '—'}</span><span class="l">resterend${planned ? ' na gepland' : ''}</span></div></div>
    ${planned ? html`<p class="small muted">Gepland (goedgekeurd weekmenu / lijst): ${euro(planned)}</p>` : ''}
    ${budget ? html`<div class="progress ${cls}" style="margin-top:.6rem" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>` : ''}</div>`;
}

/** Eenvoudige staafgrafiek (één reeks) met optionele budgetlijn. */
function chart(data, { budget = null, valueLabel = 'Uitgaven' } = {}) {
  const W = 640, H = 220, P = { l: 48, r: 12, t: 12, b: 28 };
  const max = Math.max(1, ...data.map((d) => d.v), budget || 0) * 1.1;
  const bw = (W - P.l - P.r) / data.length;
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const ticks = [0, max / 2, max].map((t) => Math.round(t));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(valueLabel)} per periode">`;
  for (const t of ticks) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/><text x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">€${t}</text>`;
  data.forEach((d, i) => {
    const x = P.l + i * bw + bw * 0.2, w = bw * 0.6, top = y(d.v), h = Math.max(0, H - P.b - top);
    const over = budget && d.v > budget;
    s += `<g><title>${esc(d.label)}: ${esc(euro(d.v))}</title><rect x="${P.l + i * bw}" y="${P.t}" width="${bw}" height="${H - P.t - P.b}" fill="transparent"/>`;
    if (h > 0) s += `<path d="M${x},${H - P.b} V${top + Math.min(4, h)} q0,-4 4,-4 h${w - 8} q4,0 4,4 V${H - P.b} Z" fill="${over ? 'var(--danger)' : 'var(--brand)'}"/>`;
    s += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text></g>`;
  });
  if (budget) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(budget)}" y2="${y(budget)}" stroke="var(--text)" stroke-dasharray="4 4" stroke-width="1.5"/><text x="${W - P.r}" y="${y(budget) - 4}" text-anchor="end">budget €${Math.round(budget)}</text>`;
  return raw(s + '</svg>');
}

export async function render(el) {
  let mode = 'week';
  const load = async () => {
    const snap = await budgetSnapshot();
    const { budget: b, purchases, week, month, plannedWeek } = snap;
    const warn = b.warn_pct || 85;
    // reeksen
    const weeks = [], months = [];
    for (let i = 7; i >= 0; i--) {
      const s = weekStart(); s.setDate(s.getDate() - 7 * i); const e = new Date(s); e.setDate(e.getDate() + 7);
      const t = periodTotals(purchases, isoDate(s), isoDate(e));
      weeks.push({ label: dateNL(s, { day: 'numeric', month: 'short' }), v: t.spent, save: t.offer + t.compare });
    }
    for (let i = 5; i >= 0; i--) {
      const s = new Date(); s.setDate(1); s.setMonth(s.getMonth() - i); const e = new Date(s); e.setMonth(e.getMonth() + 1);
      const t = periodTotals(purchases, isoDate(s), isoDate(e));
      months.push({ label: s.toLocaleDateString('nl-NL', { month: 'short' }), v: t.spent, save: t.offer + t.compare });
    }
    const series = mode === 'week' ? weeks : months;
    const bud = mode === 'week' ? (b.weekly != null ? Number(b.weekly) : null) : (b.monthly != null ? Number(b.monthly) : null);
    setHTML(el, html`<div class="row between"><h1>Budget</h1><div class="row">
        <button class="btn ghost" id="settings" ${isAdmin() ? '' : 'disabled title="Alleen beheerders"'}>Budget instellen</button>
        <button class="btn" id="add">＋ Uitgave</button></div></div>
      <div class="grid two">${bar('Deze week', week.spent, plannedWeek, b.weekly != null ? Number(b.weekly) : null, warn)}
        ${bar('Deze maand', month.spent, 0, b.monthly != null ? Number(b.monthly) : null, warn)}</div>
      <div class="grid two">
        <div class="card"><div class="stat"><span class="v">${euro(month.offer)}</span><span class="l">bespaard door aanbiedingen (maand)</span></div></div>
        <div class="card"><div class="stat"><span class="v">${euro(month.compare)}</span><span class="l">bespaard t.o.v. gemiddelde supermarktprijs (maand)</span></div></div>
      </div>
      <div class="card"><div class="row between"><h2>Uitgaven per ${mode === 'week' ? 'week' : 'maand'}</h2>
        <div class="tabs" style="margin:0"><button data-mode="week" class="${mode === 'week' ? 'active' : ''}">Week</button><button data-mode="maand" class="${mode !== 'week' ? 'active' : ''}">Maand</button></div></div>
        ${chart(series, { budget: bud })}
        <h2 style="margin-top:1rem">Besparing per ${mode === 'week' ? 'week' : 'maand'}</h2>${chart(series.map((s) => ({ label: s.label, v: s.save })), { valueLabel: 'Besparing' })}
        <details><summary class="small">Als tabel</summary><table><thead><tr><th>Periode</th><th class="num">Uitgaven</th><th class="num">Besparing</th></tr></thead>
          <tbody>${series.map((s) => html`<tr><td>${s.label}</td><td class="num">${euro(s.v)}</td><td class="num">${euro(s.save)}</td></tr>`)}</tbody></table></details></div>
      <div class="card"><h2>Recente uitgaven</h2>${purchases.length ? html`<ul class="items">${purchases.slice(0, 20).map((p) => html`<li class="item">
        <div class="grow"><div class="name">${euro(Number(p.amount))} ${p.store ? html`<span class="muted">· ${storeName(p.store)}</span>` : ''}</div>
        <div class="meta">${dateNL(p.purchased_on)}${p.note ? ' · ' + p.note : ''}${p.created_by ? ' · ' + memberName(p.created_by) : ''}${Number(p.offer_savings) ? ` · acties −${euro(Number(p.offer_savings))}` : ''}</div></div>
        <button class="icon-btn" data-del="${p.id}" aria-label="Verwijderen">🗑</button></li>`)}</ul>` : html`<p class="muted">Nog geen uitgaven. Ze komen hier automatisch bij "Afrekenen" op de lijst.</p>`}</div>`);
    el.querySelectorAll('[data-mode]').forEach((x) => x.onclick = () => { mode = x.dataset.mode; load(); });
    el.querySelector('#settings').onclick = () => editBudget(b);
    el.querySelector('#add').onclick = () => addPurchase();
    el.querySelectorAll('[data-del]').forEach((x) => x.onclick = async () => {
      if (await confirmDialog('Deze uitgave verwijderen?', 'Verwijderen')) { try { await q(sb.from('purchases').delete().eq('id', x.dataset.del)); load(); } catch (e) { toast(errorText(e), 'error'); } }
    });
  };
  function editBudget(b) {
    const m = modal('Budget instellen', html`<form id="bf"><div class="fields">
      <div class="field"><label>Weekbudget (€)</label><input name="weekly" inputmode="decimal" value="${b.weekly ?? ''}"></div>
      <div class="field"><label>Maandbudget (€)</label><input name="monthly" inputmode="decimal" value="${b.monthly ?? ''}"></div>
      <div class="field"><label>Waarschuwen bij (%)</label><input name="warn" inputmode="numeric" value="${b.warn_pct ?? 85}"></div></div>
      <button class="btn block">Opslaan</button></form>`);
    m.el.querySelector('#bf').onsubmit = async (e) => {
      e.preventDefault(); const f = formData(e.target);
      try {
        await q(sb.from('budgets').upsert({ household_id: hid(), weekly: num(f.weekly), monthly: num(f.monthly), warn_pct: Math.min(100, Math.max(50, Math.round(num(f.warn, 85)))) }));
        m.close(); load();
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }
  function addPurchase() {
    const m = modal('Uitgave toevoegen', html`<form id="pf"><div class="fields">
      <div class="field"><label>Bedrag (€)</label><input name="amount" inputmode="decimal" required></div>
      <div class="field"><label>Datum</label><input type="date" name="date" value="${isoDate()}"></div></div>
      <div class="field"><label>Winkel</label><select name="store"><option value="">—</option>${Object.entries(STORES).map(([k, v]) => html`<option value="${k}">${v.name}</option>`)}</select></div>
      <div class="field"><label>Korting door acties (€, van de kassabon)</label><input name="offer" inputmode="decimal"></div>
      <div class="field"><label>Notitie</label><input name="note"></div><button class="btn block">Opslaan</button></form>`);
    m.el.querySelector('#pf').onsubmit = async (e) => {
      e.preventDefault(); const f = formData(e.target);
      try {
        await q(sb.from('purchases').insert({ household_id: hid(), amount: num(f.amount, 0), purchased_on: f.date, store: f.store || null, offer_savings: num(f.offer, 0), note: f.note || null }));
        m.close(); load();
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }
  await load();
  return onChange(['purchases', 'budgets', 'meal_plans'], debounce(() => load().catch(() => {}), 400));
}
