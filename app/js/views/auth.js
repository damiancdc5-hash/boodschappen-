// Inloggen, registreren, wachtwoord vergeten en nieuw wachtwoord instellen.
import { html, setHTML, formData, toast, errorText } from '../ui.js';
import { sb, signIn, signUp, resetPassword } from '../api.js';

export async function render(el, { route, go }) {
  if (route === 'nieuw-wachtwoord') return renderNewPassword(el, go);
  let mode = 'login';
  const draw = () => {
    const join = sessionStorage.getItem('bs.joinCode');
    setHTML(el, html`<div class="auth-wrap">
      <img class="logo" src="icons/icon-192.png" alt="">
      <h1 class="center">${mode === 'login' ? 'Inloggen' : mode === 'register' ? 'Account aanmaken' : 'Wachtwoord vergeten'}</h1>
      ${join ? html`<p class="notice center">Je bent uitgenodigd voor een huishouden. Log in of maak een account aan om mee te doen.</p>` : ''}
      <form id="f" class="card">
        ${mode === 'register' ? html`<div class="field"><label for="n">Je naam</label><input id="n" name="name" autocomplete="name" required></div>` : ''}
        <div class="field"><label for="e">E-mailadres</label><input id="e" name="email" type="email" autocomplete="email" required></div>
        ${mode !== 'forgot' ? html`<div class="field"><label for="p">Wachtwoord</label>
          <input id="p" name="password" type="password" minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></div>` : ''}
        <button class="btn block" type="submit">${mode === 'login' ? 'Inloggen' : mode === 'register' ? 'Account aanmaken' : 'Stuur herstellink'}</button>
      </form>
      <p class="center small">
        ${mode !== 'login' ? html`<a href="#" data-m="login">Ik heb al een account</a>` : html`<a href="#" data-m="register">Nieuw account</a> · <a href="#" data-m="forgot">Wachtwoord vergeten?</a>`}
      </p></div>`);
    el.querySelectorAll('[data-m]').forEach((a) => a.onclick = (e) => { e.preventDefault(); mode = a.dataset.m; draw(); });
    el.querySelector('#f').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        if (mode === 'login') { await signIn(f.email, f.password); }
        else if (mode === 'register') {
          const res = await signUp(f.email, f.password, f.name);
          if (!res.session) {
            setHTML(el, html`<div class="auth-wrap card center"><h1>Check je mail</h1>
              <p>We hebben een bevestigingslink gestuurd naar <b>${f.email}</b>. Klik daarop en log daarna hier in.</p>
              <a class="btn" href="#/login" onclick="location.reload()">Naar inloggen</a></div>`);
            return;
          }
        } else { await resetPassword(f.email); toast('Als dit adres bekend is, is er een herstellink verstuurd.'); mode = 'login'; draw(); }
      } catch (err) { toast(errorText(err), 'error'); }
      finally { btn.disabled = false; }
    };
  };
  draw();
}

function renderNewPassword(el, go) {
  setHTML(el, html`<div class="auth-wrap"><h1 class="center">Nieuw wachtwoord</h1>
    <form id="f" class="card"><div class="field"><label>Nieuw wachtwoord</label><input name="password" type="password" minlength="8" autocomplete="new-password" required></div>
    <button class="btn block">Opslaan</button></form></div>`);
  el.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { error } = await sb.auth.updateUser({ password: formData(e.target).password });
      if (error) throw error;
      toast('Wachtwoord gewijzigd'); go('dashboard'); location.reload();
    } catch (err) { toast(errorText(err), 'error'); }
  };
}
