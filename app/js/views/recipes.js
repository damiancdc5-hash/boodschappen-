// Recepten: importeren via URL, tekst, foto of PDF; schalen; op de boodschappenlijst zetten.
import { html, setHTML, toast, errorText, modal, formData, num, confirmDialog, loading, debounce } from '../ui.js';
import { sb, q, hid, onChange, memberName } from '../api.js';
import { parseRecipeText, parseIngredientLine, scaleIngredients, subtractPantry } from '../lib/ingredients.js';
import { recipeFromJsonLd } from '../lib/recipes.js';
import { formatQty } from '../lib/units.js';
import { RECIPE_IMPORT_FUNCTION } from '../config.js';
import { addToList, defaultListId } from './list.js';

export async function loadRecipes() {
  const [recipes, ings] = await Promise.all([
    q(sb.from('recipes').select('*').eq('household_id', hid()).order('title')),
    q(sb.from('recipe_ingredients').select('*').eq('household_id', hid()).order('sort')),
  ]);
  const by = {};
  for (const i of ings) (by[i.recipe_id] ||= []).push({ ...i, quantity: i.quantity != null ? Number(i.quantity) : null });
  return recipes.map((r) => ({ ...r, ingredients: by[r.id] || [] }));
}

export async function render(el) {
  let recipes = [], filter = '';
  setHTML(el, html`<div class="row between"><h1>Recepten</h1><button class="btn" id="imp">＋ Recept toevoegen</button></div>
    <input id="f" placeholder="Zoek recept of ingrediënt…" style="margin-bottom:1rem"><div id="list">${loading()}</div>`);
  const draw = () => {
    const f = filter.toLowerCase();
    const shown = recipes.filter((r) => !f || r.title.toLowerCase().includes(f) || r.tags.some((t) => t.includes(f)) || r.ingredients.some((i) => i.name.toLowerCase().includes(f)));
    setHTML(el.querySelector('#list'), shown.length ? html`<div class="grid two">${shown.map((r) => html`<div class="card" data-r="${r.id}" style="cursor:pointer">
      <h3>${r.title}</h3><div class="small muted">${r.servings} personen · ${r.ingredients.length} ingrediënten${r.created_by ? ' · ' + memberName(r.created_by) : ''}</div>
      <div class="row" style="margin-top:.4rem">${r.tags.slice(0, 5).map((t) => html`<span class="chip">${t}</span>`)}</div></div>`)}</div>`
      : html`<div class="empty"><p>${recipes.length ? 'Geen recepten gevonden.' : 'Nog geen recepten. Voeg er een toe via een website, tekst, foto of PDF.'}</p></div>`);
  };
  const load = async () => { recipes = await loadRecipes(); draw(); };
  el.querySelector('#f').oninput = (e) => { filter = e.target.value; draw(); };
  el.querySelector('#imp').onclick = () => importDialog(load);
  el.querySelector('#list').onclick = (e) => { const c = e.target.closest('[data-r]'); if (c) showRecipe(recipes.find((r) => r.id === c.dataset.r), load); };
  await load();
  return onChange(['recipes', 'recipe_ingredients'], debounce(() => load().catch(() => {}), 400));
}

// ------------------------------------------------------------------ importeren
function importDialog(onSaved) {
  const m = modal('Recept toevoegen', html`
    <div class="tabs" id="it"><button data-m="url" class="active">Website</button><button data-m="text">Tekst</button><button data-m="photo">Foto</button><button data-m="pdf">PDF</button><button data-m="manual">Zelf invullen</button></div>
    <div id="ip"></div>`);
  const ip = m.el.querySelector('#ip');
  const panes = {
    url: html`<form id="u"><div class="field"><label>Link naar het recept</label><input name="url" type="url" placeholder="https://www.ah.nl/allerhande/recept/…" required></div>
      <button class="btn block">Ophalen</button><p class="small muted">Werkt met de meeste receptensites (Allerhande, Jumbo, 24Kitchen, Leukerecepten…).</p></form>`,
    text: html`<form id="t"><div class="field"><label>Plak het recept</label><textarea name="text" rows="10" placeholder="Titel&#10;4 personen&#10;Ingrediënten&#10;400 g pasta&#10;…&#10;Bereiding&#10;…" required></textarea></div>
      <button class="btn block">Herkennen</button></form>`,
    photo: html`<form id="p"><div class="field"><label>Foto van een recept (kookboek, tijdschrift)</label><input name="file" type="file" accept="image/*" capture="environment" required></div>
      <button class="btn block">Tekst herkennen</button><p class="small muted">De tekstherkenning gebeurt op je eigen apparaat; de foto wordt niet geüpload. De eerste keer duurt het even (taalbestand laden).</p></form>`,
    pdf: html`<form id="d"><div class="field"><label>PDF met recept</label><input name="file" type="file" accept="application/pdf" required></div>
      <button class="btn block">Inlezen</button></form>`,
  };
  const showPane = (k) => {
    m.el.querySelectorAll('#it [data-m]').forEach((b) => b.classList.toggle('active', b.dataset.m === k));
    if (k === 'manual') { m.close(); editRecipe({ title: '', servings: 4, ingredients: [], tags: [], instructions: '' }, onSaved); return; }
    setHTML(ip, panes[k]);
    const form = ip.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true; const label = btn.textContent; btn.textContent = 'Bezig…';
      try {
        let draft;
        if (k === 'url') draft = await fromUrl(form.url.value);
        if (k === 'text') draft = parseRecipeText(form.text.value);
        if (k === 'photo') draft = parseRecipeText(await ocrImage(form.file.files[0], (p) => (btn.textContent = `Herkennen… ${Math.round(p * 100)}%`)));
        if (k === 'pdf') draft = parseRecipeText(await pdfText(form.file.files[0]));
        if (!draft.ingredients.length) toast('Geen ingrediënten herkend — vul ze hieronder aan.', 'error');
        m.close(); editRecipe(draft, onSaved);
      } catch (err) { toast(errorText(err), 'error'); btn.disabled = false; btn.textContent = label; }
    };
  };
  m.el.querySelector('#it').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) showPane(b.dataset.m); };
  showPane('url');
}

async function fromUrl(url) {
  const { data, error } = await sb.functions.invoke(RECIPE_IMPORT_FUNCTION, { body: { url } });
  if (error) throw new Error('Ophalen mislukt. Is de Edge Function "import-recipe" geïnstalleerd? (' + (error.message || error) + ')');
  if (data?.error) throw new Error(data.error);
  if (data?.jsonld?.length) {
    const r = recipeFromJsonLd(data.jsonld, url);
    if (r) return r;
  }
  if (data?.text) { const r = parseRecipeText(data.text); r.source_url = url; if (data.title) r.title = data.title; return r; }
  throw new Error('Op deze pagina is geen recept gevonden. Kopieer de tekst en gebruik "Tekst".');
}

async function ocrImage(file, onProgress) {
  const Tesseract = (await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js')).default;
  const { data } = await Tesseract.recognize(file, 'nld', { logger: (m) => m.status === 'recognizing text' && onProgress(m.progress) });
  return data.text;
}

async function pdfText(file) {
  const pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let line = '', lastY = null;
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line); line = ''; }
      line += it.str; lastY = y;
    }
    out.push(line);
  }
  const text = out.join('\n').trim();
  if (!text) throw new Error('Deze PDF bevat geen tekst (gescand?). Maak er een foto van en gebruik "Foto".');
  return text;
}

// ------------------------------------------------------------------ bewerken
export function editRecipe(r, onSaved) {
  const ingText = (r.ingredients || []).map((i) => [i.quantity != null ? String(i.quantity).replace('.', ',') : '', i.unit && i.unit !== 'st' ? i.unit : (i.quantity != null ? '' : ''), i.name].filter(Boolean).join(' ')).join('\n');
  const m = modal(r.id ? 'Recept bewerken' : 'Recept controleren', html`<form id="er">
    <div class="field"><label>Titel</label><input name="title" value="${r.title}" required></div>
    <div class="fields"><div class="field"><label>Aantal personen</label><input name="servings" inputmode="numeric" value="${r.servings || 4}" required></div>
      <div class="field"><label>Labels (komma's)</label><input name="tags" value="${(r.tags || []).join(', ')}" placeholder="vegetarisch, snel, pasta"></div></div>
    <div class="field"><label>Ingrediënten — één per regel, bijv. "200 g gehakt", "2 uien", "1 el olie"</label>
      <textarea name="ings" rows="9">${ingText}</textarea></div>
    <div class="field"><label>Bereiding</label><textarea name="instructions" rows="6">${r.instructions || ''}</textarea></div>
    ${r.source_url ? html`<p class="small muted">Bron: <a href="${r.source_url}" target="_blank" rel="noopener">${r.source_url}</a></p>` : ''}
    <button class="btn block">Opslaan</button></form>`, { wide: true });
  m.el.querySelector('#er').onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const ings = f.ings.split('\n').map((l) => parseIngredientLine(l)).filter(Boolean);
    const row = { household_id: hid(), title: f.title, servings: Math.max(1, Math.round(num(f.servings, 4))), instructions: f.instructions || null,
      tags: f.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), source_url: r.source_url || null, image_url: r.image_url || null };
    try {
      let id = r.id;
      if (id) await q(sb.from('recipes').update(row).eq('id', id));
      else id = (await q(sb.from('recipes').insert(row).select()))[0].id;
      await q(sb.from('recipe_ingredients').delete().eq('recipe_id', id));
      if (ings.length) await q(sb.from('recipe_ingredients').insert(ings.map((i, n) => ({ recipe_id: id, household_id: hid(), name: i.name,
        quantity: i.quantity, unit: i.unit, raw: i.raw, optional: i.optional, sort: n }))));
      m.close(); toast('Recept opgeslagen'); onSaved?.();
    } catch (err) { toast(errorText(err), 'error'); }
  };
}

function showRecipe(r, onChanged) {
  let persons = r.servings;
  const m = modal(r.title, html`<div id="rd"></div>`, { wide: true });
  const draw = () => {
    const ings = scaleIngredients(r.ingredients, r.servings, persons);
    setHTML(m.el.querySelector('#rd'), html`
      <div class="row"><label style="margin:0">Personen</label>
        <button class="btn small ghost" data-p="-1">−</button><b>${persons}</b><button class="btn small ghost" data-p="1">＋</button>
        <span class="grow"></span><span class="row">${r.tags.map((t) => html`<span class="chip">${t}</span>`)}</span></div>
      <h3 style="margin-top:1rem">Ingrediënten</h3>
      <ul class="items">${ings.map((i) => html`<li class="item" style="min-height:0"><span class="grow">${i.name}${i.optional ? html` <span class="muted small">(optioneel)</span>` : ''}</span>
        <span class="muted">${i.quantity != null ? formatQty(i.quantity, i.unit === 'st' ? 'st' : i.unit) : ''}</span></li>`)}</ul>
      ${r.instructions ? html`<h3 style="margin-top:1rem">Bereiding</h3><p style="white-space:pre-line">${r.instructions}</p>` : ''}
      ${r.source_url ? html`<p class="small"><a href="${r.source_url}" target="_blank" rel="noopener">Origineel recept</a></p>` : ''}
      <div class="row" style="margin-top:1rem"><button class="btn" data-add>Ontbrekende ingrediënten op lijst</button>
        <button class="btn ghost" data-edit>Bewerken</button><button class="btn ghost" data-del>Verwijderen</button></div>`);
  };
  draw();
  m.el.onclick = async (e) => {
    const p = e.target.closest('[data-p]');
    if (p) { persons = Math.max(1, persons + Number(p.dataset.p)); draw(); return; }
    if (e.target.closest('[data-edit]')) { m.close(); editRecipe(r, onChanged); return; }
    if (e.target.closest('[data-del]')) {
      if (!(await confirmDialog(`"${r.title}" verwijderen?`, 'Verwijderen'))) return;
      try { await q(sb.from('recipes').delete().eq('id', r.id)); m.close(); onChanged(); } catch (err) { toast(errorText(err), 'error'); }
      return;
    }
    if (e.target.closest('[data-add]')) {
      try {
        const pantry = await q(sb.from('pantry_items').select('*').eq('household_id', hid()));
        const need = subtractPantry(scaleIngredients(r.ingredients.filter((i) => !i.optional), r.servings, persons), pantry);
        const toBuy = need.filter((n) => n.toBuy > 0).map((n) => ({ name: n.name, quantity: n.toBuy, unit: n.unit }));
        const fromPantry = need.filter((n) => n.toBuy <= 0).length;
        const res = await addToList(await defaultListId(), toBuy, `recept: ${r.title}`);
        toast(`${res.added} toegevoegd, ${res.merged} opgeteld${fromPantry ? `, ${fromPantry} al in voorraad` : ''}`);
      } catch (err) { toast(errorText(err), 'error'); }
    }
  };
}
