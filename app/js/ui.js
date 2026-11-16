// Kleine UI-hulpmiddelen: veilige HTML, meldingen, dialogen.

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Template-tag die alle ingevoegde waarden escapet, behalve raw()-waarden en arrays daarvan. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += toHtml(vals[i]);
  });
  return new Raw(out);
}
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
function toHtml(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return esc(v);
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function setHTML(el, content) { el.innerHTML = String(content); }

let toastTimer;
export function toast(msg, type = 'info') {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), type === 'error' ? 6000 : 3000);
}

export function errorText(e) {
  const m = e?.message || String(e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Geen verbinding met de server. Controleer je internet.';
  if (/Invalid login credentials/i.test(m)) return 'E-mailadres of wachtwoord klopt niet.';
  if (/Email not confirmed/i.test(m)) return 'Bevestig eerst je e-mailadres via de link in je mailbox.';
  if (/User already registered/i.test(m)) return 'Er bestaat al een account met dit e-mailadres.';
  if (/Password should be/i.test(m)) return 'Kies een wachtwoord van minstens 8 tekens.';
  if (/Database error saving new user|alleen op uitnodiging|Signups not allowed/i.test(m))
    return 'Aanmelden kan alleen op uitnodiging. Vraag een beheerder van je huishouden om je e-mailadres uit te nodigen (Huishouden → Gezinslid uitnodigen) en gebruik precies dat adres.';
  if (/Requested function was not found|Function not found/i.test(m)) return 'De recept-functie is niet gevonden in Supabase. Controleer of de Edge Function precies "import-recipe" heet.';
  return m;
}

/** Modaal venster. Geeft {el, close}. content mag een html``-waarde zijn. */
export function modal(title, content, { wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = String(html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
    <header><h2>${title}</h2><button class="icon-btn" data-close aria-label="Sluiten">✕</button></header>
    <div class="modal-body">${content}</div></div>`);
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const close = () => { wrap.remove(); if (!document.querySelector('.modal-backdrop')) document.body.classList.remove('no-scroll'); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  const first = wrap.querySelector('input,select,textarea');
  if (first && matchMedia('(pointer:fine)').matches) setTimeout(() => first.focus(), 30);
  return { el: wrap.querySelector('.modal'), close };
}

export function confirmDialog(text, okLabel = 'OK') {
  return new Promise((resolve) => {
    const m = modal('Weet je het zeker?', html`<p>${text}</p><div class="row end"><button class="btn ghost" data-no>Annuleren</button><button class="btn danger" data-yes>${okLabel}</button></div>`);
    m.el.querySelector('[data-yes]').onclick = () => { m.close(); resolve(true); };
    m.el.querySelector('[data-no]').onclick = () => { m.close(); resolve(false); };
  });
}

export function formData(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) o[k] = typeof v === 'string' ? v.trim() : v;
  return o;
}

export function num(v, d = null) {
  if (v == null || v === '') return d;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? d : n;
}

export function timeAgo(ts) {
  if (!ts) return 'onbekend';
  const d = new Date(ts), s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return 'zojuist';
  if (s < 3600) return `${Math.round(s / 60)} min geleden`;
  if (s < 86400) return `${Math.round(s / 3600)} uur geleden`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} dag(en) geleden`;
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateNL(d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return new Date(d).toLocaleDateString('nl-NL', opts);
}

export function isoDate(d = new Date()) {
  const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}

export function weekStart(d = new Date()) {
  const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x;
}

export function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function loading(text = 'Laden…') { return html`<div class="loading"><span class="spinner"></span>${text}</div>`; }
export function empty(text, action = '') { return html`<div class="empty"><p>${text}</p>${action}</div>`; }
