// Wordt alleen getoond als config.js nog niet is ingevuld.
import { html, setHTML, formData, toast } from '../ui.js';
import { saveConfig } from '../api.js';

export async function render(el) {
  setHTML(el, html`<div class="auth-wrap card">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1 class="center">Koppel je database</h1>
    <p class="muted">De app is nog niet gekoppeld aan een Supabase-project. Vul bij voorkeur <code>js/config.js</code> in vóór het publiceren,
      zodat gezinsleden dit niet hoeven te doen. Testen kan ook door het hier in te vullen (alleen op dit apparaat).</p>
    <form id="f">
      <div class="field"><label>Project URL</label><input name="url" placeholder="https://xxxx.supabase.co" required></div>
      <div class="field"><label>anon public key</label><input name="key" required></div>
      <button class="btn block">Opslaan en starten</button>
    </form></div>`);
  el.querySelector('#f').onsubmit = (e) => {
    e.preventDefault();
    const { url, key } = formData(e.target);
    if (!/^https:\/\/.+/.test(url)) { toast('URL moet met https:// beginnen', 'error'); return; }
    saveConfig(url, key);
    location.reload();
  };
}
