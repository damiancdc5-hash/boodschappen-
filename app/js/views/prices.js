// Prijsvergelijker: lijst vergelijken (3 scenario's), producten zoeken, acties beheren, databronnen.
import { html, setHTML, toast, errorText, modal, formData, num, timeAgo, isoDate, loading, debounce, confirmDialog } from '../ui.js';
import { sb, q, hid, state, onChange, memberName } from '../api.js';
import { STORES, storeName, enabledStores, scenariosForList, priceStatus, loadOffers, offerSyncStatus } from '../pricing.js';
import { euro, formatQty, unitPriceLabel } from '../lib/units.js';
import { OFFER_TYPES, describeOffer, costForPacks } from '../lib/offers.js';
import { bestAtStore } from '../lib/optimizer.js';
import { defaultListId, loadLists } from './list.js';

const storeTag = (s) => html`<span class="store" style="--c:${STORES[s]?.color || '#888'}">${storeName(s)}</span>`;

export async function render(el, { go }) {
  let tab = sessionStorage.getItem('bs.pricesTab') || 'lijst';
  if (tab === 'acties') tab = 'lijst';
  setHTML(el, html`<h1>Prijsvergelijker</h1>
    <div class="tabs" id="tabs">
      ${[['lijst', 'Mijn lijst'], ['zoeken', 'Product zoeken'], ['acties', 'Aanbiedingen'], ['bronnen', 'Databronnen']].map(([k, l]) =>
        html`<button data-tab="${k}">${l}</button>`)}
    </div><div id="pane"></div>`);
  const pane = el.querySelector('#pane');
  const show = async () => {
    el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    sessionStorage.setItem('bs.pricesTab', tab);
    try {
      if (tab === 'lijst') await listPane(pane, go);
      if (tab === 'zoeken') await searchPane(pane);
      if (tab === 'bronnen') await sourcesPane(pane);
    } catch (e) { setHTML(pane, html`<p class="notice danger">${errorText(e)}</p>`); }
  };
  el.querySelector('#tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    if (b.dataset.tab === 'acties') { go('aanbiedingen'); return; } // eigen pagina
    tab = b.dataset.tab; show();
  };
  await show();
  return null;
}

// ------------------------------------------------------------------ mijn lijst → scenario's
async function listPane(pane, go) {
  const lists = await loadLists();
  let listId = localStorage.getItem('bs.list.' + hid()) || (await defaultListId());
  if (!lists.some((l) => l.id === listId)) listId = lists[0]?.id;
  setHTML(pane, html`${lists.length > 1 ? html`<div class="field"><select id="ls">${lists.map((l) => html`<option value="${l.id}" ${l.id === listId ? 'selected' : ''}>${l.name}</option>`)}</select></div>` : ''}
    <div id="res">${loading('Prijzen vergelijken…')}</div>`);
  const ls = pane.querySelector('#ls');
  if (ls) ls.onchange = () => { localStorage.setItem('bs.list.' + hid(), ls.value); listPane(pane, go); };
  const res = pane.querySelector('#res');
  const data = await scenariosForList(listId);
  const { items, candMap, result } = data;
  if (!items.length) { setHTML(res, html`<div class="empty"><p>Er staan geen open producten op deze lijst.</p><a class="btn" href="#/lijst">Naar de lijst</a></div>`); return; }
  if (!result.available.length) {
    setHTML(res, html`<div class="card"><h2>Nog geen prijzen gevonden</h2><p>Voor deze producten zijn (nog) geen prijzen in de database.
      Controleer bij <b>Databronnen</b> of de prijssync heeft gedraaid. Er worden nooit verzonnen prijzen getoond.</p></div>`);
    return;
  }
  const sc = (title, sub, p, extra = '') => p ? html`<div class="card scenario ${extra}">
    <div class="row between"><h3>${title}</h3>${p.missing.length ? html`<span class="badge warn">${p.missing.length} niet gevonden</span>` : html`<span class="badge ok">compleet</span>`}</div>
    <p class="small muted" style="margin-top:0">${sub}</p>
    <div class="big">${euro(p.total)}</div>
    <div class="row" style="margin:.3rem 0">${p.stores.map(storeTag)}</div>
    <div class="small">${p.savingsVsAverage > 0 ? html`Besparing t.o.v. gemiddelde prijs: <b>${euro(p.savingsVsAverage)}</b><br>` : ''}
      ${p.offerSavings > 0 ? html`Waarvan door acties: <b>${euro(p.offerSavings)}</b><br>` : ''}
      ${p.travel ? html`Route ≈ ${p.travel.km} km, ${p.travel.minutes} min${p.travel.cost ? `, reiskosten ≈ ${euro(p.travel.cost)}` : ''}` : html`<span class="muted">Stel je adres in voor reistijd en -kosten.</span>`}</div>
    <div class="row" style="margin-top:.6rem"><button class="btn small" data-route='${JSON.stringify(p.stores)}'>Route plannen</button>
      <button class="btn small ghost" data-detail="${title}">Per product</button></div></div>` : '';
  const best1 = result.single[0];
  const savingsBalanced = result.balanced && best1 ? Math.round((best1.total - result.balanced.total) * 100) / 100 : 0;
  setHTML(res, html`
    ${result.unpriced.length ? html`<p class="notice warn">Geen prijs gevonden voor: ${result.unpriced.map((i) => i.name).join(', ')}.
      Deze producten tellen niet mee in de totalen. Tip: gebruik een algemenere naam (bijv. "halfvolle melk").</p>` : ''}
    <div class="grid three">
      ${sc('1 · Eén winkel', 'Alles bij de goedkoopste complete winkel', best1)}
      ${sc('2 · Goedkoopste combinatie', `Laagste prijs over max. ${state.household.max_stores} winkels`, result.cheapest)}
      ${sc('3 · Beste balans', 'Prijs + reistijd + gemak', result.balanced, 'pick')}
    </div>
    ${savingsBalanced > 0 ? html`<p class="notice">Met scenario 3 bespaar je ${euro(savingsBalanced)} ten opzichte van alles bij ${storeName(best1.store)}.</p>` : ''}
    <div class="card"><h2>Alle winkels voor deze lijst</h2><div class="table-wrap"><table>
      <thead><tr><th>Winkel</th><th class="num">Totaal</th><th class="num">Ontbreekt</th></tr></thead>
      <tbody>${result.single.map((p, i) => html`<tr class="${i === 0 ? 'best' : ''}"><td>${storeTag(p.store)}</td><td class="num">${euro(p.total)}</td><td class="num">${p.missing.length || ''}</td></tr>`)}
      ${enabledStores().filter((s) => !result.available.includes(s)).map((s) => html`<tr><td>${storeTag(s)}</td><td class="num muted" colspan="2">geen prijsdata</td></tr>`)}
      </tbody></table></div>
      <p class="small muted">Prijzen laatst gecontroleerd: ${checkedSummary(candMap)}. Winkels "zonder prijsdata" worden door de databron niet aangeboden.</p></div>
    <div class="card"><h2>Per product</h2><div id="per"></div></div>`);
  const drawPer = () => setHTML(pane.querySelector('#per'), html`${items.map((it) => {
    const cands = candMap[it.id] || [];
    const stores = [...new Set(cands.map((c) => c.store))];
    const opts = stores.map((s) => bestAtStore(it, cands, s)).filter(Boolean).sort((a, b) => a.total - b.total);
    return html`<details style="border-bottom:1px solid var(--line);padding:.5rem 0">
      <summary class="row between"><span><b>${it.name}</b> <span class="muted small">${formatQty(Number(it.quantity), it.unit)}</span></span>
        <span>${opts[0] ? html`${euro(opts[0].total)} ${storeTag(opts[0].store)}` : html`<span class="badge warn">geen prijs</span>`}</span></summary>
      ${cands.length ? html`<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Prijs</th><th class="num">Per eenheid</th><th></th></tr></thead><tbody>
        ${cands.sort((a, b) => (a.unit_price ?? 1e9) - (b.unit_price ?? 1e9)).map((c) => html`<tr class="${it.pinned_product_id === c.id ? 'best' : ''}">
          <td>${storeTag(c.store)}<br>${c.link ? html`<a href="${c.link}" target="_blank" rel="noopener">${c.name}</a>` : c.name}
            <span class="muted small">${c.size_text || ''}</span>${c.offer ? html`<br><span class="badge ok">${describeOffer(c.offer)}</span>` : ''}
            <br><span class="small muted">gecontroleerd ${timeAgo(c.checked_at)}</span></td>
          <td class="num">${euro(c.price)}</td><td class="num">${c.unit_price != null ? html`${euro(c.unit_price)}<br><span class="small muted">${unitPriceLabel(c.unit)}</span>` : '–'}</td>
          <td><button class="btn small ghost" data-pin="${it.id}:${c.id}">${it.pinned_product_id === c.id ? 'Gekozen' : 'Kies'}</button></td></tr>`)}
      </tbody></table></div>` : html`<p class="small muted">Geen overeenkomend product gevonden.</p>`}</details>`;
  })}`);
  drawPer();
  pane.onclick = async (e) => {
    const r = e.target.closest('[data-route]');
    if (r) { sessionStorage.setItem('bs.routeStores', r.dataset.route); go('route'); return; }
    if (e.target.closest('[data-detail]')) { pane.querySelector('#per').scrollIntoView({ behavior: 'smooth' }); return; }
    const pin = e.target.closest('[data-pin]');
    if (pin) {
      const [itemId, prodId] = pin.dataset.pin.split(':');
      const it = items.find((i) => i.id === itemId);
      const val = it.pinned_product_id === Number(prodId) ? null : Number(prodId);
      try { await q(sb.from('list_items').update({ pinned_product_id: val }).eq('id', itemId)); toast(val ? 'Product gekozen — scenario’s worden herberekend' : 'Keuze verwijderd'); listPane(pane, go); }
      catch (err) { toast(errorText(err), 'error'); }
    }
  };
}

function checkedSummary(candMap) {
  const all = Object.values(candMap).flat().map((c) => new Date(c.checked_at).getTime()).filter(Boolean);
  if (!all.length) return 'onbekend';
  return `tussen ${timeAgo(Math.min(...all))} en ${timeAgo(Math.max(...all))}`;
}

// ------------------------------------------------------------------ zoeken
async function searchPane(pane) {
  setHTML(pane, html`<div class="card"><div class="row"><input id="s" class="grow" placeholder="Zoek een product, bijv. pindakaas 600" enterkeyhint="search">
    </div><div class="row" style="margin-top:.6rem" id="sf">${enabledStores().map((s) => html`<button class="chip active" data-s="${s}">${storeName(s)}</button>`)}</div></div><div id="out"></div>`);
  const input = pane.querySelector('#s'), out = pane.querySelector('#out');
  const sel = new Set(enabledStores());
  const run = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) { out.innerHTML = ''; return; }
    setHTML(out, loading('Zoeken…'));
    try {
      const rows = await q(sb.rpc('search_products', { p_query: term, p_stores: [...sel], p_limit: 80 }));
      if (!rows.length) { setHTML(out, html`<div class="empty"><p>Niets gevonden voor "${term}".</p></div>`); return; }
      const minUnit = Math.min(...rows.filter((r) => r.unit_price != null).map((r) => Number(r.unit_price)));
      setHTML(out, html`<div class="card table-wrap"><table><thead><tr><th>Product</th><th class="num">Prijs</th><th class="num">Per eenheid</th></tr></thead><tbody>
        ${rows.sort((a, b) => (a.unit_price ?? 1e9) - (b.unit_price ?? 1e9)).map((r) => html`<tr class="${Number(r.unit_price) === minUnit ? 'best' : ''}">
          <td>${storeTag(r.store)}<br>${r.link ? html`<a href="${r.link}" target="_blank" rel="noopener">${r.name}</a>` : r.name} <span class="small muted">${r.size_text || ''}</span>
          <br><span class="small muted">gecontroleerd ${timeAgo(r.checked_at)} · bron: ${r.source}</span></td>
          <td class="num">${euro(Number(r.price))}</td><td class="num">${r.unit_price != null ? html`${euro(Number(r.unit_price))}<br><span class="small muted">${unitPriceLabel(r.unit)}</span>` : '–'}</td></tr>`)}
        </tbody></table><p class="small muted">Groen = laagste prijs per kilo/liter/stuk.</p></div>`);
    } catch (e) { setHTML(out, html`<p class="notice danger">${errorText(e)}</p>`); }
  }, 350);
  input.oninput = run;
  pane.querySelector('#sf').onclick = (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    sel.has(b.dataset.s) ? sel.delete(b.dataset.s) : sel.add(b.dataset.s);
    b.classList.toggle('active'); run();
  };
  input.focus();
}

// ------------------------------------------------------------------ databronnen
async function sourcesPane(pane) {
  const st = await priceStatus();
  setHTML(pane, html`<div class="card"><h2>Waar komen de prijzen vandaan?</h2>
    <p class="small">Normale schapprijzen komen uit de open dataset van <a href="https://www.checkjebon.nl" target="_blank" rel="noopener">Checkjebon.nl</a>
    (open source, hergebruik toegestaan). Die wordt dagelijks automatisch ingeladen. De app toont nooit verzonnen prijzen: ontbreekt een prijs, dan staat dat erbij.</p>
    ${st.lastRun ? html`<p class="small">Laatste sync: <b>${timeAgo(st.lastRun.finished_at || st.lastRun.started_at)}</b> —
      <span class="badge ${st.lastRun.status === 'ok' ? 'ok' : 'danger'}">${st.lastRun.status}</span> ${st.lastRun.message || ''}</p>` : html`<p class="notice warn">De prijssync heeft nog niet gedraaid. Zie de installatiehandleiding (stap 4).</p>`}
    <div class="table-wrap"><table><thead><tr><th>Winkel</th><th class="num">Producten</th><th>Laatst gecontroleerd</th></tr></thead><tbody>
    ${Object.keys(STORES).map((s) => { const r = st.stores[s]; return html`<tr><td>${storeTag(s)}</td><td class="num">${r ? r.products.toLocaleString('nl-NL') : '–'}</td>
      <td>${r ? timeAgo(r.last_checked) : html`<span class="badge warn">geen data beschikbaar</span>`}</td></tr>`; })}
    </tbody></table></div>
    <p class="small muted">Lidl zit niet in deze dataset. Van Lidl staan alleen de producten uit de wekelijkse aanbiedingen van lidl.nl in de app
      (met normale prijs en Lidl Plus-prijs). Aanbiedingen van alle winkels staan onder <b>Aanbiedingen</b>.</p></div>`);
}

export { costForPacks };
