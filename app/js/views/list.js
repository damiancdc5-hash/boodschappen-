// Gedeelde boodschappenlijst met realtime sync, favorieten, categorieën en afrekenen.
import { html, setHTML, toast, errorText, modal, formData, num, confirmDialog, debounce, isoDate, esc } from '../ui.js';
import { sb, q, state, hid, onChange, mutate, cacheGet, cacheSet, memberName } from '../api.js';
import { guessCategory, CATEGORIES, mergeItems, nameKey, isEquipment } from '../lib/ingredients.js';
import { formatQty, euro } from '../lib/units.js';
import { STORES, storeName } from '../pricing.js';

const UNITS = ['st', 'g', 'kg', 'ml', 'l', 'pak', 'bos', 'blik', 'zak'];

export async function loadLists() {
  return q(sb.from('shopping_lists').select('*').eq('household_id', hid()).eq('archived', false).order('created_at'));
}

/** Voegt producten toe aan een lijst zonder dubbelingen (gebruikt door recepten en weekmenu). */
export async function addToList(listId, products, source = null) {
  products = products.filter((p) => !isEquipment(p.name)); // geen ovenschaal of bakpapier op de lijst
  const existing = await q(sb.from('list_items').select('*').eq('list_id', listId).eq('checked', false));
  const { updates, additions } = mergeItems(existing, products);
  for (const u of updates) await q(sb.from('list_items').update({ quantity: u.quantity, unit: u.unit }).eq('id', u.id));
  if (additions.length) {
    await q(sb.from('list_items').insert(additions.map((a) => ({
      household_id: hid(), list_id: listId, name: a.name, quantity: a.quantity ?? 1, unit: a.unit || 'st',
      category: a.category || guessCategory(a.name), source: a.source || source,
    }))));
  }
  return { added: additions.length, merged: updates.length };
}

export async function defaultListId() {
  const lists = await loadLists();
  return (lists.find((l) => l.is_default) || lists[0])?.id;
}

export async function render(el) {
  let lists = [], items = [], favorites = [];
  let listId = localStorage.getItem('bs.list.' + hid());
  let pending = 0;

  setHTML(el, html`
    <div class="list-head"><h1 class="grow" style="margin:0">Boodschappenlijst</h1>
      <button class="icon-btn" id="list-menu" aria-label="Lijsten beheren">⋯</button></div>
    <div class="tabs" id="tabs"></div>
    <form id="add" class="card add-bar" autocomplete="off">
      <input name="name" list="sugg" placeholder="Product toevoegen…" aria-label="Product" required enterkeyhint="done">
      <input name="quantity" inputmode="decimal" placeholder="1" aria-label="Aantal">
      <select name="unit" aria-label="Eenheid">${UNITS.map((u) => html`<option>${u}</option>`)}</select>
      <button class="btn">Voeg toe</button>
      <datalist id="sugg"></datalist>
    </form>
    <div id="favs" class="row" style="margin-bottom:.8rem"></div>
    <div class="card" id="items"></div>
    <div class="row" id="actions"></div>`);

  const $ = (s) => el.querySelector(s);

  async function load() {
    lists = await loadLists();
    if (!lists.find((l) => l.id === listId)) listId = (lists.find((l) => l.is_default) || lists[0])?.id;
    if (listId) localStorage.setItem('bs.list.' + hid(), listId);
    [items, favorites] = await Promise.all([
      q(sb.from('list_items').select('*').eq('list_id', listId).order('created_at')),
      q(sb.from('favorites').select('*').eq('household_id', hid()).order('name')),
    ]);
    cacheSet('list.' + listId, { lists, items, favorites });
    draw();
  }

  function draw() {
    setHTML($('#tabs'), html`${lists.map((l) => html`<button data-list="${l.id}" class="${l.id === listId ? 'active' : ''}">${l.name}</button>`)}
      <button data-newlist>＋ Lijst</button>`);
    setHTML($('#sugg'), html`${[...new Set([...favorites.map((f) => f.name), ...items.map((i) => i.name)])].map((n) => html`<option value="${n}">`)}`);
    setHTML($('#favs'), favorites.length ? html`<span class="small muted">Favorieten:</span>
      ${favorites.map((f) => html`<button class="chip" data-fav="${f.id}">＋ ${f.name}</button>`)}` : '');
    const open = items.filter((i) => !i.checked), done = items.filter((i) => i.checked);
    const byCat = new Map();
    for (const it of open) { const c = it.category || 'Overig'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(it); }
    const cats = [...byCat.keys()].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
    const row = (it) => html`<li class="item ${it.checked ? 'done' : ''}" data-id="${it.id}">
      <button class="check" data-toggle aria-label="${it.checked ? 'Niet afgevinkt' : 'Afvinken'}">${it.checked ? '✓' : ''}</button>
      <div class="grow" data-edit style="cursor:pointer">
        <div class="name">${it.name} <span class="muted small">${formatQty(Number(it.quantity), it.unit)}</span></div>
        <div class="meta">${[it.note, it.source, it.checked && it.checked_by ? 'afgevinkt door ' + memberName(it.checked_by) : (it.added_by && it.added_by !== state.user.id ? 'door ' + memberName(it.added_by) : '')].filter(Boolean).join(' · ')}</div>
      </div></li>`;
    setHTML($('#items'), items.length ? html`
      ${cats.map((c) => html`<div class="cat-h">${c}</div><ul class="items">${byCat.get(c).map(row)}</ul>`)}
      ${!open.length ? html`<p class="muted center">Alles is afgevinkt 🎉</p>` : ''}
      ${done.length ? html`<div class="cat-h">In het mandje (${done.length})</div><ul class="items">${done.map(row)}</ul>` : ''}`
      : html`<div class="empty"><p>De lijst is leeg. Voeg hierboven iets toe, of zet een recept of weekmenu op de lijst.</p></div>`);
    setHTML($('#actions'), html`
      ${open.length ? html`<a class="btn ghost" href="#/prijzen">💶 Vergelijk prijzen</a>` : ''}
      ${done.length ? html`<button class="btn" data-checkout>Afrekenen (${done.length})</button>
        <button class="btn ghost" data-clear>Afgevinkte verwijderen</button>` : ''}`);
  }

  async function addItem(name, quantity, unit) {
    const existing = items.filter((i) => !i.checked);
    const { updates, additions } = mergeItems(existing, [{ name, quantity, unit }]);
    if (updates.length) {
      const u = updates[0];
      const it = items.find((i) => i.id === u.id); Object.assign(it, { quantity: u.quantity, unit: u.unit }); draw();
      await mutate('list_items', 'update', { quantity: u.quantity, unit: u.unit }, { id: u.id });
      toast(`Opgeteld bij ${it.name}`);
      return;
    }
    if (!additions.length) { toast(`${name} staat al op de lijst`); return; }
    const row = { id: crypto.randomUUID(), household_id: hid(), list_id: listId, name, quantity: quantity ?? 1, unit,
      category: guessCategory(name), added_by: state.user.id, created_at: new Date().toISOString() };
    items.push(row); draw();
    pending++;
    try { await mutate('list_items', 'insert', row); } finally { pending--; }
  }

  el.addEventListener('submit', async (e) => {
    if (e.target.id !== 'add') return;
    e.preventDefault();
    const f = formData(e.target);
    if (!f.name) return;
    e.target.reset();
    e.target.name.focus();
    try { await addItem(f.name, num(f.quantity, 1), f.unit || 'st'); } catch (err) { toast(errorText(err), 'error'); }
  });

  el.addEventListener('click', async (e) => {
    const t = e.target;
    const li = t.closest('[data-id]');
    try {
      if (t.closest('[data-list]')) { listId = t.closest('[data-list]').dataset.list; localStorage.setItem('bs.list.' + hid(), listId); await load(); return; }
      if (t.closest('[data-newlist]')) return newList();
      if (t.closest('#list-menu')) return manageLists();
      if (t.closest('[data-fav]')) {
        const f = favorites.find((x) => x.id === t.closest('[data-fav]').dataset.fav);
        return addItem(f.name, Number(f.quantity), f.unit);
      }
      if (li && t.closest('[data-toggle]')) {
        const it = items.find((i) => i.id === li.dataset.id);
        it.checked = !it.checked; it.checked_by = it.checked ? state.user.id : null; draw();
        if (navigator.vibrate) navigator.vibrate(10);
        pending++;
        try { await mutate('list_items', 'update', { checked: it.checked, checked_by: it.checked_by, checked_at: it.checked ? new Date().toISOString() : null }, { id: it.id }); }
        finally { pending--; }
        return;
      }
      if (li && t.closest('[data-edit]')) return editItem(items.find((i) => i.id === li.dataset.id));
      if (t.closest('[data-clear]')) {
        if (!(await confirmDialog('Alle afgevinkte producten van deze lijst verwijderen?', 'Verwijderen'))) return;
        await q(sb.from('list_items').delete().eq('list_id', listId).eq('checked', true));
        items = items.filter((i) => !i.checked); draw();
        return;
      }
      if (t.closest('[data-checkout]')) return checkout();
    } catch (err) { toast(errorText(err), 'error'); }
  });

  function editItem(it) {
    const isFav = favorites.some((f) => nameKey(f.name) === nameKey(it.name));
    const m = modal('Product', html`<form id="ef">
      <div class="field"><label>Naam</label><input name="name" value="${it.name}" required></div>
      <div class="fields"><div class="field"><label>Aantal</label><input name="quantity" inputmode="decimal" value="${String(Number(it.quantity)).replace('.', ',')}"></div>
        <div class="field"><label>Eenheid</label><select name="unit">${[...new Set([it.unit, ...UNITS])].map((u) => html`<option ${u === it.unit ? 'selected' : ''}>${u}</option>`)}</select></div></div>
      <div class="field"><label>Categorie</label><select name="category">${CATEGORIES.map((c) => html`<option ${c === it.category ? 'selected' : ''}>${c}</option>`)}</select></div>
      <div class="field"><label>Notitie</label><input name="note" value="${it.note || ''}" placeholder="Bijv. merk, smaak"></div>
      <label class="row" style="font-weight:500;color:var(--text)"><input type="checkbox" name="fav" ${isFav ? 'checked' : ''}> Favoriet</label>
      <div class="row between" style="margin-top:1rem"><button type="button" class="btn danger" data-del>Verwijderen</button><button class="btn">Opslaan</button></div>
    </form>`);
    m.el.querySelector('[data-del]').onclick = async () => {
      m.close(); items = items.filter((i) => i.id !== it.id); draw();
      await mutate('list_items', 'delete', null, { id: it.id });
    };
    m.el.querySelector('#ef').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const patch = { name: f.name, quantity: num(f.quantity, 1), unit: f.unit, category: f.category, note: f.note || null };
      if (f.name !== it.name) patch.pinned_product_id = null;
      Object.assign(it, patch); draw(); m.close();
      try {
        await mutate('list_items', 'update', patch, { id: it.id });
        const fav = favorites.find((x) => nameKey(x.name) === nameKey(it.name));
        if (f.fav === 'on' && !fav) await q(sb.from('favorites').insert({ household_id: hid(), name: it.name, quantity: patch.quantity, unit: patch.unit, category: patch.category }));
        if (f.fav !== 'on' && fav) await q(sb.from('favorites').delete().eq('id', fav.id));
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }

  function newList() {
    const m = modal('Nieuwe lijst', html`<form id="nl"><div class="field"><label>Naam</label><input name="name" placeholder="Bijv. Verjaardag, Drogist" required></div><button class="btn block">Aanmaken</button></form>`);
    m.el.querySelector('#nl').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const [l] = await q(sb.from('shopping_lists').insert({ household_id: hid(), name: formData(e.target).name }).select());
        listId = l.id; m.close(); await load();
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }

  function manageLists() {
    const cur = lists.find((l) => l.id === listId);
    const m = modal('Lijst beheren', html`<form id="ml"><div class="field"><label>Naam van deze lijst</label><input name="name" value="${cur?.name || ''}" required></div>
      <div class="row between"><button type="button" class="btn danger" data-arch ${cur?.is_default ? 'disabled' : ''}>Lijst archiveren</button><button class="btn">Opslaan</button></div>
      ${cur?.is_default ? html`<p class="small muted">De hoofdlijst kan niet worden gearchiveerd.</p>` : ''}</form>`);
    m.el.querySelector('#ml').onsubmit = async (e) => {
      e.preventDefault();
      try { await q(sb.from('shopping_lists').update({ name: formData(e.target).name }).eq('id', listId)); m.close(); load(); } catch (err) { toast(errorText(err), 'error'); }
    };
    m.el.querySelector('[data-arch]').onclick = async () => {
      try { await q(sb.from('shopping_lists').update({ archived: true }).eq('id', listId)); m.close(); listId = null; load(); } catch (err) { toast(errorText(err), 'error'); }
    };
  }

  function checkout() {
    const done = items.filter((i) => i.checked);
    let planned = null;
    try {
      const s = JSON.parse(sessionStorage.getItem('bs.scenarios') || 'null');
      if (s && s.listId === listId) planned = s.result?.balanced || s.result?.cheapest;
    } catch { /* geen scenario */ }
    const m = modal('Afrekenen', html`<form id="co">
      <p class="small muted">Leg vast wat jullie betaald hebben. Dit telt mee in het budget.</p>
      <div class="fields">
        <div class="field"><label>Betaald bedrag (€)</label><input name="amount" inputmode="decimal" required placeholder="0,00"></div>
        <div class="field"><label>Datum</label><input name="date" type="date" value="${isoDate()}"></div>
      </div>
      <div class="field"><label>Winkel</label><select name="store"><option value="">— meerdere / anders —</option>
        ${Object.entries(STORES).map(([k, v]) => html`<option value="${k}" ${planned?.stores?.length === 1 && planned.stores[0] === k ? 'selected' : ''}>${v.name}</option>`)}</select></div>
      <div class="field"><label>Besparing door acties volgens de kassabon (€, optioneel)</label><input name="offer" inputmode="decimal" placeholder="${planned ? String(planned.offerSavings).replace('.', ',') : '0,00'}"></div>
      ${planned ? html`<p class="notice small">Verwachte kosten volgens de prijsvergelijking: <b>${euro(planned.total)}</b>
        (gemiddelde supermarktprijs ${euro(planned.reference)}).</p>` : ''}
      <label class="row" style="font-weight:500;color:var(--text)"><input type="checkbox" name="pantry" checked> ${done.length} afgevinkte producten in de voorraadkast zetten</label>
      <label class="row" style="font-weight:500;color:var(--text)"><input type="checkbox" name="clear" checked> Afgevinkte producten van de lijst halen</label>
      <button class="btn block" style="margin-top:1rem">Opslaan</button></form>`);
    m.el.querySelector('#co').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const amount = num(f.amount);
      if (amount == null) { toast('Vul het betaalde bedrag in', 'error'); return; }
      try {
        const offer = num(f.offer, planned?.offerSavings ?? 0);
        await q(sb.from('purchases').insert({
          household_id: hid(), purchased_on: f.date || isoDate(), store: f.store || null, amount,
          planned_amount: planned?.total ?? null, regular_amount: planned?.regular ?? null, offer_savings: offer || 0,
          compare_savings: planned ? Math.max(0, Math.round((planned.reference - amount) * 100) / 100) : 0,
          note: `${done.length} producten${f.store ? ' bij ' + storeName(f.store) : ''}`,
        }));
        if (f.pantry === 'on') {
          await q(sb.from('pantry_items').insert(done.map((d) => ({ household_id: hid(), name: d.name, quantity: d.quantity, unit: d.unit }))));
        }
        if (f.clear === 'on') { await q(sb.from('list_items').delete().eq('list_id', listId).eq('checked', true)); items = items.filter((i) => !i.checked); }
        m.close(); draw(); toast('Uitgave opgeslagen');
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }

  // Eerst cache tonen (snel/offline), dan verversen
  const cached = cacheGet('list.' + listId);
  if (cached) { ({ lists, items, favorites } = cached); draw(); }
  else setHTML($('#items'), html`<div class="loading"><span class="spinner"></span>Laden…</div>`);
  try { await load(); } catch (err) { if (!cached) setHTML($('#items'), html`<p class="notice warn">${errorText(err)}</p>`); }

  const reload = debounce(() => { if (!pending) load().catch(() => {}); }, 250);
  const off = onChange(['list_items', 'shopping_lists', 'favorites', 'refresh'], (ev) => {
    if (ev.table === 'list_items' && ev.type === 'DELETE' && ev.old?.id && !items.some((i) => i.id === ev.old.id)) return;
    reload();
  });
  return off;
}

export { esc };
