// Digitale voorraadkast met houdbaarheidswaarschuwingen.
import { html, setHTML, toast, errorText, modal, formData, num, confirmDialog, debounce, dateNL, isoDate } from '../ui.js';
import { sb, q, hid, onChange, mutate, memberName } from '../api.js';
import { formatQty } from '../lib/units.js';
import { addToList, defaultListId } from './list.js';

const LOCATIONS = ['Koelkast', 'Vriezer', 'Voorraadkast', 'Keukenkast', 'Kelder', 'Badkamer'];

export function daysLeft(d) {
  if (!d) return null;
  const t = new Date(isoDate()); return Math.round((new Date(d) - t) / 86400e3);
}

export async function render(el) {
  let items = [], filter = '';
  setHTML(el, html`<div class="row between"><h1>Voorraadkast</h1><button class="btn" id="add">＋ Toevoegen</button></div>
    <input id="f" placeholder="Zoeken…" style="margin-bottom:1rem"><div id="warn"></div><div id="list"></div>`);
  const draw = () => {
    const f = filter.toLowerCase();
    const shown = items.filter((i) => !f || i.name.toLowerCase().includes(f));
    const soon = items.filter((i) => { const d = daysLeft(i.expires_on); return d != null && d <= 3; });
    setHTML(el.querySelector('#warn'), soon.length ? html`<div class="notice warn" style="margin-bottom:1rem"><b>Bijna over datum:</b>
      ${soon.map((i) => { const d = daysLeft(i.expires_on); return `${i.name} (${d < 0 ? 'verlopen' : d === 0 ? 'vandaag' : d === 1 ? 'morgen' : `nog ${d} dagen`})`; }).join(', ')}
      <br><a href="#/recepten">Zoek een recept</a> dat deze producten gebruikt.</div>` : '');
    const groups = new Map();
    for (const i of shown) { const l = i.location || 'Overig'; if (!groups.has(l)) groups.set(l, []); groups.get(l).push(i); }
    setHTML(el.querySelector('#list'), shown.length ? html`${[...groups.entries()].map(([loc, arr]) => html`<div class="card"><h2>${loc}</h2><ul class="items">
      ${arr.map((i) => { const d = daysLeft(i.expires_on); return html`<li class="item" data-id="${i.id}">
        <div class="grow" data-edit style="cursor:pointer"><div class="name">${i.name}</div>
          <div class="meta">${formatQty(Number(i.quantity), i.unit)}${i.expires_on ? ` · THT ${dateNL(i.expires_on, { day: 'numeric', month: 'short' })}` : ''}${i.updated_by ? ' · ' + memberName(i.updated_by) : ''}</div></div>
        ${d != null && d <= 3 ? html`<span class="badge ${d < 0 ? 'danger' : 'warn'}">${d < 0 ? 'verlopen' : d + 'd'}</span>` : ''}
        <button class="icon-btn" data-dec aria-label="Minder">−</button><button class="icon-btn" data-inc aria-label="Meer">＋</button></li>`; })}</ul></div>`)}`
      : html`<div class="empty"><p>${items.length ? 'Niets gevonden.' : 'De voorraadkast is leeg. Producten komen er automatisch in als je afrekent, of voeg ze hier toe.'}</p></div>`);
  };
  const load = async () => { items = await q(sb.from('pantry_items').select('*').eq('household_id', hid()).order('expires_on', { ascending: true, nullsFirst: false }).order('name')); draw(); };
  el.querySelector('#f').oninput = (e) => { filter = e.target.value; draw(); };
  el.querySelector('#add').onclick = () => edit({});
  el.querySelector('#list').onclick = async (e) => {
    const li = e.target.closest('[data-id]'); if (!li) return;
    const it = items.find((i) => i.id === li.dataset.id);
    try {
      if (e.target.closest('[data-edit]')) return edit(it);
      const step = it.unit === 'g' || it.unit === 'ml' ? 100 : 1;
      if (e.target.closest('[data-inc]')) { it.quantity = Number(it.quantity) + step; draw(); await mutate('pantry_items', 'update', { quantity: it.quantity }, { id: it.id }); }
      if (e.target.closest('[data-dec]')) {
        const nq = Number(it.quantity) - step;
        if (nq <= 0) {
          const again = await confirmDialog(`${it.name} is op. Uit de voorraad halen en op de boodschappenlijst zetten?`, 'Ja');
          await mutate('pantry_items', 'delete', null, { id: it.id });
          items = items.filter((x) => x.id !== it.id); draw();
          if (again) { await addToList(await defaultListId(), [{ name: it.name, quantity: 1, unit: 'st' }]); toast('Op de lijst gezet'); }
        } else { it.quantity = nq; draw(); await mutate('pantry_items', 'update', { quantity: nq }, { id: it.id }); }
      }
    } catch (err) { toast(errorText(err), 'error'); }
  };

  function edit(it) {
    const m = modal(it.id ? 'Voorraad bewerken' : 'Voorraad toevoegen', html`<form id="pf">
      <div class="field"><label>Product</label><input name="name" value="${it.name || ''}" required></div>
      <div class="fields"><div class="field"><label>Hoeveelheid</label><input name="quantity" inputmode="decimal" value="${it.quantity != null ? String(Number(it.quantity)).replace('.', ',') : '1'}"></div>
        <div class="field"><label>Eenheid</label><select name="unit">${['st', 'g', 'ml', 'kg', 'l'].map((u) => html`<option ${u === it.unit ? 'selected' : ''}>${u}</option>`)}</select></div></div>
      <div class="fields"><div class="field"><label>Houdbaar tot</label><input type="date" name="expires_on" value="${it.expires_on || ''}"></div>
        <div class="field"><label>Locatie</label><input name="location" list="locs" value="${it.location || ''}"><datalist id="locs">${LOCATIONS.map((l) => html`<option value="${l}">`)}</datalist></div></div>
      <div class="field"><label>Barcode (optioneel)</label><input name="barcode" inputmode="numeric" value="${it.barcode || ''}" placeholder="Scannen volgt later; nu handmatig"></div>
      <div class="row between">${it.id ? html`<button type="button" class="btn danger" data-del>Verwijderen</button>` : html`<span></span>`}<button class="btn">Opslaan</button></div></form>`);
    m.el.querySelector('[data-del]')?.addEventListener('click', async () => {
      try { await q(sb.from('pantry_items').delete().eq('id', it.id)); m.close(); load(); } catch (err) { toast(errorText(err), 'error'); }
    });
    m.el.querySelector('#pf').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      let qty = num(f.quantity, 1), unit = f.unit;
      if (unit === 'kg') { qty *= 1000; unit = 'g'; } if (unit === 'l') { qty *= 1000; unit = 'ml'; }
      const row = { household_id: hid(), name: f.name, quantity: qty, unit, expires_on: f.expires_on || null, location: f.location || null, barcode: f.barcode || null };
      try {
        if (it.id) await q(sb.from('pantry_items').update(row).eq('id', it.id)); else await q(sb.from('pantry_items').insert(row));
        m.close(); load();
      } catch (err) { toast(errorText(err), 'error'); }
    };
  }

  await load();
  return onChange(['pantry_items', 'refresh'], debounce(() => load().catch(() => {}), 300));
}
