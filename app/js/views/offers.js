// Aanbiedingen: actuele acties van de supermarkten, gefilterd op jullie winkels, met "op de lijst zetten".
import { html, setHTML, toast, errorText, modal, formData, num, timeAgo, isoDate, debounce, confirmDialog, loading } from '../ui.js';
import { sb, q, hid, onChange, memberName } from '../api.js';
import { STORES, storeName, enabledStores, loadOffers, offerSyncStatus } from '../pricing.js';
import { euro } from '../lib/units.js';
import { OFFER_TYPES, describeOffer, offerDiscount } from '../lib/offers.js';
import { addToList, defaultListId } from './list.js';

export const storeTag = (s) => html`<span class="store" style="--c:${STORES[s]?.color || '#888'}">${storeName(s)}</span>`;
const wordsOf = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Acties die passen bij producten op de lijst: alle woorden van het lijstproduct komen voor in de actienaam. */
export function offersForItems(items, offers) {
  const out = [];
  for (const it of items) {
    const iw = wordsOf(it.name);
    if (!iw.length) continue;
    for (const o of offers) { const ow = ' ' + wordsOf(o.product_name).join(' ') + ' '; if (iw.every((w) => ow.includes(' ' + w))) out.push({ item: it.name, o }); }
  }
  return out;
}

export function offerCard(o, { compact = false } = {}) {
  const pct = offerDiscount(o);
  const price = ['fixed', 'card'].includes(o.offer_type) ? Number(o.params?.price) : o.offer_price != null ? Number(o.offer_price) : null;
  return html`<div class="offer-card ${compact ? 'compact' : ''}">
    <div class="offer-img">${o.image_url ? html`<img src="${o.image_url}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : html`<span>🏷️</span>`}
      ${pct ? html`<span class="offer-pct">-${pct}%</span>` : ''}</div>
    <div class="offer-body">
      <div class="offer-deal">${describeOffer(o)}</div>
      <div class="offer-name">${o.product_name}</div>
      <div class="small muted">${o.size_text || ''}</div>
      <div class="offer-prices">${price != null && o.offer_type !== 'multibuy' ? html`<b>${euro(price)}</b>` : ''}
        ${o.regular_price ? html` <s class="muted">${euro(Number(o.regular_price))}</s>` : ''}</div>
      <div class="row between" style="margin-top:auto">${storeTag(o.store)}<span class="small muted">t/m ${new Date(o.valid_to).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}</span></div>
      ${compact ? '' : html`<div class="row" style="margin-top:.4rem"><button class="btn small" data-addoffer="${o.id}">＋ Op lijst</button>
        ${o.link ? html`<a class="btn small ghost" href="${o.link}" target="_blank" rel="noopener">Bekijk</a>` : ''}
        ${o.household_id ? html`<button class="icon-btn" data-del="${o.id}" aria-label="Verwijderen">🗑</button>` : ''}</div>`}
    </div></div>`;
}

export async function render(el) {
  setHTML(el, html`<h1>Aanbiedingen</h1>${loading('Aanbiedingen laden…')}`);
  let offers = [], status = {}, items = [];
  let store = sessionStorage.getItem('bs.offerStore') || 'alle', filter = '', sort = 'korting', onlyList = false, shown = 60;
  const load = async () => {
    [offers, status, items] = await Promise.all([
      loadOffers({ fresh: true }), offerSyncStatus().catch(() => ({})),
      q(sb.from('list_items').select('name').eq('household_id', hid()).eq('checked', false)).catch(() => []),
    ]);
  };
  const draw = () => {
    const enabled = enabledStores();
    const mine = offers.filter((o) => o.household_id);
    const web = offers.filter((o) => enabled.includes(o.store));
    const forList = offersForItems(items, web);
    const listIds = new Set(forList.map((x) => x.o.id));
    const f = filter.toLowerCase();
    let list = web.filter((o) => (store === 'alle' || o.store === store) && (!f || o.product_name.toLowerCase().includes(f)) && (!onlyList || listIds.has(o.id)));
    if (sort === 'korting') list.sort((a, b) => (offerDiscount(b) ?? -1) - (offerDiscount(a) ?? -1));
    if (sort === 'naam') list.sort((a, b) => a.product_name.localeCompare(b.product_name, 'nl'));
    if (sort === 'einde') list.sort((a, b) => a.valid_to.localeCompare(b.valid_to));
    setHTML(el, html`<h1>Aanbiedingen</h1>
      ${forList.length ? html`<div class="card"><h2>🎯 Voor jullie lijst</h2><div class="offer-grid">${forList.slice(0, 8).map(({ o }) => offerCard(o, { compact: true }))}</div>
        <p class="small muted">Deze acties worden automatisch meegerekend in de prijsvergelijking en het weekmenu.</p></div>` : ''}
      <div class="card">
        <div class="row"><input id="of" class="grow" placeholder="Zoek in ${web.length} aanbiedingen…" value="${filter}">
          <select id="sort" style="width:auto"><option value="korting" ${sort === 'korting' ? 'selected' : ''}>Hoogste korting</option>
            <option value="einde" ${sort === 'einde' ? 'selected' : ''}>Loopt eerst af</option><option value="naam" ${sort === 'naam' ? 'selected' : ''}>A–Z</option></select></div>
        <div class="tabs" style="margin-top:.6rem">${['alle', ...enabled.filter((s) => web.some((o) => o.store === s))].map((s) =>
          html`<button data-st="${s}" class="${s === store ? 'active' : ''}">${s === 'alle' ? 'Alle winkels' : storeName(s)}</button>`)}
          ${forList.length ? html`<button data-onlylist class="${onlyList ? 'active' : ''}">🎯 Mijn lijst</button>` : ''}</div>
      </div>
      ${list.length ? html`<div class="offer-grid">${list.slice(0, shown).map((o) => offerCard(o))}</div>
        ${list.length > shown ? html`<p class="center"><button class="btn ghost" data-more>Meer tonen (${list.length - shown})</button></p>` : ''}`
        : html`<div class="empty"><p>${web.length ? 'Geen aanbiedingen gevonden.' : 'Nog geen aanbiedingen opgehaald. Ze worden elke ochtend automatisch bijgewerkt.'}</p></div>`}
      <details class="card"><summary><b>Status per winkel</b></summary>
        <div class="table-wrap"><table><thead><tr><th>Winkel</th><th class="num">Acties</th><th>Opgehaald</th></tr></thead><tbody>
        ${enabled.map((s) => { const r = status[s]; const n = web.filter((o) => o.store === s && !o.household_id).length;
          return html`<tr><td>${storeTag(s)}</td><td class="num">${n || '–'}</td><td>${r ? html`${timeAgo(r.finished_at || r.started_at)}
            ${r.status !== 'ok' ? html` <span class="badge ${r.status === 'leeg' ? 'warn' : 'danger'}" title="${r.message || ''}">${r.status === 'leeg' ? 'niets gevonden' : 'mislukt'}</span>` : ''}`
            : html`<span class="muted small">${['vomar', 'hoogvliet'].includes(s) ? 'niet automatisch — voer acties zelf in' : 'nog niet opgehaald'}</span>`}</td></tr>`; })}
        </tbody></table></div>
        <p class="small muted">Elke ochtend automatisch opgehaald van de aanbiedingenpagina's van de supermarkten.</p></details>
      <div class="card"><h2>Zelf ingevoerde acties</h2>
        <p class="small">Voor acties die de app niet automatisch vindt (bijv. Vomar, Hoogvliet of een schapactie). Alleen zichtbaar voor jullie huishouden.</p>
        ${mine.length ? html`<ul class="items">${mine.map((o) => html`<li class="item"><div class="grow"><div class="name">${o.product_name} <span class="badge ok">${describeOffer(o)}</span></div>
          <div class="meta">${storeName(o.store)} · t/m ${new Date(o.valid_to).toLocaleDateString('nl-NL')} · ${o.source}${o.entered_by ? ' · ' + memberName(o.entered_by) : ''}</div></div>
          <button class="icon-btn" data-del="${o.id}" aria-label="Verwijderen">🗑</button></li>`)}</ul>` : ''}
        <button class="btn" id="add" style="margin-top:.6rem">＋ Actie toevoegen</button></div>`);
    const inp = el.querySelector('#of');
    inp.oninput = debounce(() => { filter = inp.value; shown = 60; draw(); const n = el.querySelector('#of'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 300);
    el.querySelector('#sort').onchange = (e) => { sort = e.target.value; draw(); };
  };
  el.onclick = async (e) => {
    const t = e.target;
    try {
      const st = t.closest('[data-st]'); if (st) { store = st.dataset.st; sessionStorage.setItem('bs.offerStore', store); shown = 60; draw(); return; }
      if (t.closest('[data-onlylist]')) { onlyList = !onlyList; draw(); return; }
      if (t.closest('[data-more]')) { shown += 60; draw(); return; }
      if (t.closest('#add')) { addOffer(); return; }
      const add = t.closest('[data-addoffer]');
      if (add) {
        const o = offers.find((x) => String(x.id) === add.dataset.addoffer);
        const res = await addToList(await defaultListId(), [{ name: o.product_name, quantity: 1, unit: 'st' }], `actie ${storeName(o.store)}`);
        toast(res.added ? `${o.product_name} staat op de lijst` : `${o.product_name} stond al op de lijst`);
        return;
      }
      const d = t.closest('[data-del]');
      if (d && await confirmDialog('Deze actie verwijderen?', 'Verwijderen')) { await q(sb.from('offers').delete().eq('id', d.dataset.del)); await load(); draw(); }
    } catch (err) { toast(errorText(err), 'error'); }
  };

  function addOffer() {
    const end = new Date(); end.setDate(end.getDate() + ((7 - end.getDay()) % 7 || 7));
    const m = modal('Actie toevoegen', html`<form id="ofm">
      <div class="field"><label>Product (zoals in de winkel)</label><input name="product" placeholder="Bijv. Calvé pindakaas" required></div>
      <div class="fields"><div class="field"><label>Winkel</label><select name="store">${Object.entries(STORES).map(([k, v]) => html`<option value="${k}">${v.name}</option>`)}</select></div>
        <div class="field"><label>Soort actie</label><select name="type">${Object.entries(OFFER_TYPES).filter(([k]) => k !== 'info').map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div></div>
      <div class="fields"><div class="field" data-p="percent"><label>Korting %</label><input name="pct" inputmode="decimal"></div>
        <div class="field" data-p="multibuy nplusm"><label>Aantal (kopen)</label><input name="n" inputmode="numeric" placeholder="3"></div>
        <div class="field" data-p="nplusm"><label>Gratis erbij</label><input name="m" inputmode="numeric" placeholder="1"></div>
        <div class="field" data-p="amount_off"><label>Korting (€)</label><input name="amount" inputmode="decimal"></div>
        <div class="field" data-p="multibuy"><label>Voor (€)</label><input name="total" inputmode="decimal" placeholder="5,00"></div>
        <div class="field" data-p="fixed card"><label>Actieprijs (€)</label><input name="price" inputmode="decimal"></div></div>
      <div class="fields"><div class="field"><label>Normale prijs (€, optioneel)</label><input name="regular" inputmode="decimal"></div>
        <div class="field"><label>Geldig t/m</label><input name="to" type="date" value="${isoDate(end)}" required></div></div>
      <div class="field"><label>Bron</label><input name="source" value="folder" placeholder="folder / app / schap"></div>
      <button class="btn block">Opslaan</button></form>`);
    const f = m.el.querySelector('#ofm');
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
          regular_price: num(v.regular), valid_to: v.to, source: 'handmatig: ' + (v.source || 'folder') }));
        m.close(); toast('Actie opgeslagen'); await load(); draw();
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }

  try { await load(); draw(); } catch (err) { setHTML(el, html`<h1>Aanbiedingen</h1><p class="notice danger">${errorText(err)}</p>`); }
  return onChange(['offers', 'households'], debounce(async () => { try { await load(); draw(); } catch { /* */ } }, 500));
}

export { memberName };
