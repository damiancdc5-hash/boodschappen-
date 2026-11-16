// Eerste keer: huishouden aanmaken of met een code aansluiten.
import { html, setHTML, formData, toast, errorText } from '../ui.js';
import { createHousehold, joinHousehold, signOut, state } from '../api.js';

export async function render(el, { go }) {
  const code = sessionStorage.getItem('bs.joinCode') || '';
  setHTML(el, html`<div class="auth-wrap">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1 class="center">Welkom${state.profile?.display_name ? ', ' + state.profile.display_name : ''}!</h1>
    <form id="join" class="card"><h2>Aansluiten bij je huishouden</h2>
      <p class="small muted">Vraag een gezinslid om de uitnodigingscode (Huishouden → Uitnodigen).</p>
      <div class="field"><input name="code" value="${code}" placeholder="Bijv. K7Q2MX9A" autocapitalize="characters" required></div>
      <button class="btn block">Aansluiten</button></form>
    <form id="create" class="card"><h2>Of: nieuw huishouden starten</h2>
      <div class="field"><input name="name" placeholder="Bijv. Familie Jansen" required></div>
      <button class="btn ghost block">Huishouden aanmaken</button></form>
    ${state.households.length ? html`<p class="center"><a href="#/dashboard">Terug</a></p>` : ''}
    <p class="center small"><a href="#" id="out">Uitloggen</a></p></div>`);
  el.querySelector('#join').onsubmit = async (e) => {
    e.preventDefault();
    try { await joinHousehold(formData(e.target).code); sessionStorage.removeItem('bs.joinCode'); toast('Welkom in het huishouden!'); go('lijst'); }
    catch (err) { toast(errorText(err), 'error'); }
  };
  el.querySelector('#create').onsubmit = async (e) => {
    e.preventDefault();
    try { await createHousehold(formData(e.target).name); toast('Huishouden aangemaakt'); go('instellingen'); }
    catch (err) { toast(errorText(err), 'error'); }
  };
  el.querySelector('#out').onclick = async (e) => { e.preventDefault(); await signOut(); location.hash = '#/login'; location.reload(); };
}
