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
      if (tab === 'acties') await offersPane(pane);
      if (tab === 'bronnen') await sourcesPane(pane);
    } catch (e) { setHTML(pane, html`<p class="notice danger">${errorText(e)}</p>`); }
  };
  el.querySelector('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; show(); } };
  await show();
  return onChange('offers', debounce(() => { if (tab === 'acties') show(); }, 300));
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

// ------------------------------------------------------------------ aanbiedingen
async function offersPane(pane) {
  const [offers, status, listItems] = await Promise.all([
    loadOffers({ fresh: true }), offerSyncStatus().catch(() => ({})),
    q(sb.from('list_items').select('name').eq('household_id', hid()).eq('checked', false)).catch(() => []),
  ]);
  const enabled = enabledStores();
  const web = offers.filter((o) => !o.household_id && enabled.includes(o.store));
  const mine = offers.filter((o) => o.household_id);
  const wordsOf = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const forList = [];
  for (const it of listItems) {
    const iw = wordsOf(it.name);
    if (!iw.length) continue;
    for (const o of web) { const ow = wordsOf(o.product_name).join(' '); if (iw.every((w) => ow.includes(w))) forList.push({ item: it.name, o }); }
  }
  let store = sessionStorage.getItem('bs.offerStore') || 'alle', filter = '';
  const row = (o) => html`<li class="item"><div class="grow"><div class="name">${o.product_name} <span class="badge ok">${describeOffer(o)}</span></div>
    <div class="meta">${storeTag(o.store)} ${o.size_text ? '· ' + o.size_text : ''} ${o.regular_price ? html`· normaal ${euro(Number(o.regular_price))}` : ''}
      · t/m ${new Date(o.valid_to).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
      ${o.link ? html`· <a href="${o.link}" target="_blank" rel="noopener">bekijk</a>` : ''}
      ${o.household_id ? html` · ${o.source}${o.entered_by ? ' · ' + memberName(o.entered_by) : ''}` : ''}</div></div>
    ${o.household_id ? html`<button class="icon-btn" data-del="${o.id}" aria-label="Verwijderen">🗑</button>` : ''}</li>`;
  const draw = () => {
    const f = filter.toLowerCase();
    const shown = web.filter((o) => (store === 'alle' || o.store === store) && (!f || o.product_name.toLowerCase().includes(f)));
    setHTML(pane, html`
      ${forList.length ? html`<div class="card"><h2>🎯 In de aanbieding van jullie lijst</h2><ul class="items">
        ${forList.slice(0, 30).map(({ item, o }) => html`<li class="item"><div class="grow"><div class="name">${item}: ${o.product_name}</div>
          <div class="meta">${storeTag(o.store)} · ${describeOffer(o)}${o.regular_price ? html` · normaal ${euro(Number(o.regular_price))}` : ''}</div></div></li>`)}</ul>
        <p class="small muted">Deze acties worden automatisch meegerekend in de prijsvergelijking en het weekmenu.</p></div>` : ''}
      <div class="card"><h2>Aanbiedingen van de supermarkten</h2>
        <div class="table-wrap"><table><thead><tr><th>Winkel</th><th class="num">Acties</th><th>Opgehaald</th></tr></thead><tbody>
        ${enabled.map((s) => { const r = status[s]; const n = web.filter((o) => o.store === s).length;
          return html`<tr><td>${storeTag(s)}</td><td class="num">${n || '–'}</td><td>${r ? html`${timeAgo(r.finished_at || r.started_at)}
            ${r.status !== 'ok' ? html` <span class="badge ${r.status === 'leeg' ? 'warn' : 'danger'}" title="${r.message || ''}">${r.status === 'leeg' ? 'niets gevonden' : 'mislukt'}</span>` : ''}`
            : html`<span class="muted small">${['vomar', 'hoogvliet'].includes(s) ? 'niet automatisch — voer acties zelf in' : 'nog niet opgehaald'}</span>`}</td></tr>`; })}
        </tbody></table></div>
        <p class="small muted">Elke ochtend automatisch opgehaald van de aanbiedingenpagina's van de supermarkten. Lukt dat een keer niet,
          dan blijven de laatst bekende acties staan tot hun einddatum.</p>
        <div class="row" style="margin:.6rem 0"><input id="of" placeholder="Zoek in aanbiedingen…" class="grow" value="${filter}"></div>
        <div class="tabs">${['alle', ...enabled.filter((s) => web.some((o) => o.store === s))].map((s) => html`<button data-st="${s}" class="${s === store ? 'active' : ''}">${s === 'alle' ? `Alle (${web.length})` : storeName(s)}</button>`)}</div>
        ${shown.length ? html`<ul class="items">${shown.slice(0, 300).map(row)}</ul>${shown.length > 300 ? html`<p class="small muted">Eerste 300 van ${shown.length} getoond; zoek om te verfijnen.</p>` : ''}`
          : html`<div class="empty"><p>${web.length ? 'Geen aanbiedingen gevonden.' : 'Nog geen aanbiedingen opgehaald. Zie de installatiehandleiding (stap 4b).'}</p></div>`}
      </div>
      <div class="card"><h2>Zelf ingevoerde acties</h2>
        <p class="small">Voor winkels of acties die de app niet automatisch vindt (bijv. Vomar, Hoogvliet of een schapactie). Alleen zichtbaar voor jullie huishouden.</p>
        ${mine.length ? html`<ul class="items">${mine.map(row)}</ul>` : ''}
        <button class="btn" id="add">＋ Actie toevoegen</button></div>`);
    pane.querySelector('#add').onclick = () => addOffer();
    const inp = pane.querySelector('#of');
    inp.oninput = debounce(() => { filter = inp.value; draw(); const n = pane.querySelector('#of'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250);
  };
  draw();
  pane.onclick = async (e) => {
    const st = e.target.closest('[data-st]');
    if (st) { store = st.dataset.st; sessionStorage.setItem('bs.offerStore', store); draw(); return; }
    const d = e.target.closest('[data-del]');
    if (d && await confirmDialog('Deze actie verwijderen?', 'Verwijderen')) {
      try { await q(sb.from('offers').delete().eq('id', d.dataset.del)); offersPane(pane); } catch (err) { toast(errorText(err), 'error'); }
    }
  };
  function addOffer() {
    const end = new Date(); end.setDate(end.getDate() + ((7 - end.getDay()) % 7 || 7));
    const m = modal('Actie toevoegen', html`<form id="of">
      <div class="field"><label>Product (zoals in de winkel)</label><input name="product" placeholder="Bijv. Calvé pindakaas" required></div>
      <div class="fields"><div class="field"><label>Winkel</label><select name="store">${Object.entries(STORES).map(([k, v]) => html`<option value="${k}">${v.name}</option>`)}</select></div>
        <div class="field"><label>Soort actie</label><select name="type">${Object.entries(OFFER_TYPES).filter(([k]) => k !== 'info').map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div></div>
      <div class="fields"><div class="field" data-p="percent"><label>Korting %</label><input name="pct" inputmode="decimal"></div>
        <div class="field" data-p="multibuy nplusm"><label>Aantal (kopen)</label><input name="n" inputmode="numeric" placeholder="3"></div>
        <div class="field" data-p="nplusm"><label>Gratis erbij</label><input name="m" inputmode="numeric" placeholder="1"></div>
        <div class="field" data-p="amount_off"><label>Korting (€)</label><input name="amount" inputmode="decimal"></div>
        <div class="field" data-p="multibuy"><label>Voor (€)</label><input name="total" inputmode="decimal" placeholder="5,00"></div>
        <div class="field" data-p="fixed card"><label>Actieprijs (€)</label><input name="price" inputmode="decimal"></div></div>
      <div class="fields"><div class="field"><label>Geldig t/m</label><input name="to" type="date" value="${isoDate(end)}" required></div>
        <div class="field"><label>Bron</label><input name="source" value="folder" placeholder="folder / app / schap"></div></div>
      <button class="btn block">Opslaan</button></form>`);
    const f = m.el.querySelector('#of');
    const sync = () => m.el.querySelectorAll('[data-p]').forEach((d) => d.classList.toggle('hidden', !d.dataset.p.split(' ').includes(f.type.value)));
    f.type.onchange = sync; sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = formData(f);
      const params = v.type === 'percent' ? { pct: num(v.pct) } : v.type === 'multibuy' ? { n: num(v.n), total: num(v.total) } :
        v.type === 'nplusm' ? { n: num(v.n), m: num(v.m) } : v.type === 'amount_off' ? { amount: num(v.amount) } :
        ['fixed', 'card'].includes(v.type) ? { price: num(v.price) } : {};
      if (Object.values(params).some((x) => x == null)) { toast('Vul de actiegegevens in', 'error'); return; }
      try {
        await q(sb.from('offers').insert({ household_id: hid(), store: v.store, product_name: v.product, offer_type: v.type, params,
          valid_to: v.to, source: 'handmatig: ' + (v.source || 'folder') }));
        m.close(); toast('Actie opgeslagen'); offersPane(pane);
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }
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
