// Huishoudinstellingen: leden en rollen, uitnodigen, adres en reisvoorkeuren, winkels, profiel.
import { html, setHTML, toast, errorText, formData, num, confirmDialog, timeAgo, modal } from '../ui.js';
import { sb, q, state, hid, isAdmin, loadMembers, loadHouseholds, selectHousehold, signOut, onChange } from '../api.js';
import { STORES, geocode } from '../pricing.js';

export async function render(el, { go }) {
  let invites = [];
  const loadInvites = async () => {
    invites = await q(sb.from('household_invites').select('*').eq('household_id', hid()).is('accepted_at', null).order('created_at')).catch(() => []);
  };
  await loadInvites();
  const appUrl = location.origin + location.pathname;
  const shareInvite = async (email) => {
    const text = `Je bent uitgenodigd voor "${state.household.name}" in onze boodschappenapp. Open ${appUrl}, kies "Nieuw account" en meld je aan met ${email}.`;
    if (navigator.share) { await navigator.share({ title: 'Uitnodiging boodschappenapp', text }).catch(() => {}); return; }
    try { await navigator.clipboard.writeText(text); toast('Uitnodigingstekst gekopieerd — plak hem in WhatsApp of een mail'); }
    catch { modal('Uitnodiging versturen', html`<p>Stuur dit bericht naar ${email}:</p><textarea readonly rows="5" onfocus="this.select()">${text}</textarea>`); }
  };
  const draw = () => {
    const h = state.household, admin = isAdmin();
    const link = `${location.origin}${location.pathname}#/join/${h.invite_code}`;
    setHTML(el, html`<h1>Huishouden</h1>
    ${state.households.length > 1 ? html`<div class="card"><h2>Wissel van huishouden</h2><div class="row">${state.households.map((x) =>
      html`<button class="chip ${x.id === h.id ? 'active' : ''}" data-hh="${x.id}">${x.name}</button>`)}</div></div>` : ''}

    <div class="card"><h2>Gezinsleden</h2><ul class="items">${state.members.map((m) => html`<li class="item">
      <div class="grow"><div class="name">${m.name}${m.user_id === state.user.id ? ' (jij)' : ''}</div><div class="meta">lid sinds ${timeAgo(m.joined_at)}</div></div>
      <span class="badge ${m.role === 'admin' ? 'ok' : ''}">${m.role === 'admin' ? 'beheerder' : 'gezinslid'}</span>
      ${admin && m.user_id !== state.user.id ? html`<button class="btn small ghost" data-role="${m.user_id}:${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Maak gezinslid' : 'Maak beheerder'}</button>
        <button class="icon-btn" data-remove="${m.user_id}" aria-label="Verwijderen">✕</button>` : ''}</li>`)}</ul>
      <p class="small muted">Beheerders kunnen instellingen, budget en leden beheren. Iedereen kan de lijst, recepten, weekmenu's en voorraad bewerken.</p></div>

    <div class="card"><h2>Gezinslid uitnodigen</h2>
      <p class="small">Alleen mensen die jullie uitnodigen kunnen een account aanmaken. Vul het e-mailadres in waarmee het gezinslid zich gaat aanmelden.</p>
      ${admin ? html`<form id="inv" class="row" autocomplete="off">
          <input name="email" type="email" class="grow" placeholder="naam@voorbeeld.nl" required>
          <select name="role" style="width:auto"><option value="member">gezinslid</option><option value="admin">beheerder</option></select>
          <button class="btn">Uitnodigen</button></form>`
        : html`<p class="notice small">Alleen beheerders kunnen uitnodigen.</p>`}
      ${invites.length ? html`<h3 style="margin-top:1rem">Openstaande uitnodigingen</h3><ul class="items">${invites.map((i) => html`<li class="item">
        <div class="grow"><div class="name">${i.email}</div><div class="meta">${i.role === 'admin' ? 'beheerder' : 'gezinslid'} · geldig t/m ${new Date(i.expires_at).toLocaleDateString('nl-NL')}</div></div>
        <button class="btn small ghost" data-share-inv="${i.email}">Delen</button>
        ${admin ? html`<button class="icon-btn" data-revoke="${i.id}" aria-label="Intrekken">✕</button>` : ''}</li>`)}</ul>` : ''}
    </div>

    <form class="card" id="hf"><h2>Instellingen ${admin ? '' : html`<span class="badge">alleen-lezen</span>`}</h2>
      <fieldset ${admin ? '' : 'disabled'} style="border:0;padding:0;margin:0">
      <div class="field"><label>Naam huishouden</label><input name="name" value="${h.name}" required></div>
      <div class="field"><label>Thuisadres (voor winkelroute)</label><input name="address" value="${h.home_address || ''}" placeholder="Straat 1, Plaats" autocomplete="street-address">
        ${h.home_lat != null ? html`<span class="small muted">📍 locatie bekend</span>` : html`<span class="small muted">Nog geen locatie ingesteld</span>`}</div>
      <div class="fields">
        <div class="field"><label>Vervoer</label><select name="travel_mode">${[['car', 'Auto'], ['bike', 'Fiets'], ['walk', 'Lopend']].map(([k, l]) => html`<option value="${k}" ${h.travel_mode === k ? 'selected' : ''}>${l}</option>`)}</select></div>
        <div class="field"><label>Autokosten per km (€)</label><input name="cost_per_km" inputmode="decimal" value="${String(h.cost_per_km).replace('.', ',')}"></div>
        <div class="field"><label>Waarde van je tijd (€/uur)</label><input name="time_value" inputmode="decimal" value="${String(h.time_value_per_hour).replace('.', ',')}"></div>
        <div class="field"><label>Max. winkels per ronde</label><input name="max_stores" inputmode="numeric" value="${h.max_stores}"></div>
      </div>
      <label>Supermarkten waar jullie willen winkelen</label>
      <div class="row" style="margin-bottom:1rem">${Object.entries(STORES).map(([k, v]) => html`<label class="chip" style="color:var(--text)">
        <input type="checkbox" name="store_${k}" ${h.stores_enabled.includes(k) ? 'checked' : ''}> ${v.name}</label>`)}</div>
      <button class="btn">Opslaan</button></fieldset></form>

    <form class="card" id="pf"><h2>Mijn profiel</h2><div class="field"><label>Naam</label><input name="display_name" value="${state.profile?.display_name || ''}" required></div>
      <p class="small muted">${state.user.email}</p><button class="btn ghost">Opslaan</button></form>

    <div class="card"><h2>App installeren</h2>
      <p class="small"><b>iPhone/iPad:</b> open deze site in Safari → deelknop → "Zet op beginscherm".<br>
      <b>Android:</b> Chrome-menu ⋮ → "App installeren".<br><b>Laptop:</b> klik in Chrome/Edge op het installatie-icoon in de adresbalk.</p>
      <button class="btn install-only" id="install">Installeer nu</button></div>

    <div class="card row"><a class="btn ghost" href="#/start">Nog een huishouden starten / aansluiten</a>
      <button class="btn ghost" id="leave">Huishouden verlaten</button><button class="btn danger" id="logout">Uitloggen</button></div>`);
  };
  draw();

  el.onclick = async (e) => {
    const t = e.target;
    try {
      const hh = t.closest('[data-hh]'); if (hh) { await selectHousehold(hh.dataset.hh); draw(); return; }
      const r = t.closest('[data-role]');
      if (r) { const [uid, role] = r.dataset.role.split(':'); await q(sb.rpc('set_member_role', { p_household: hid(), p_user: uid, p_role: role })); await loadMembers(); draw(); return; }
      const rm = t.closest('[data-remove]');
      if (rm && await confirmDialog('Dit gezinslid uit het huishouden verwijderen?', 'Verwijderen')) {
        await q(sb.rpc('remove_member', { p_household: hid(), p_user: rm.dataset.remove })); await loadMembers(); draw(); return;
      }
      const si = t.closest('[data-share-inv]'); if (si) { await shareInvite(si.dataset.shareInv); return; }
      const rv = t.closest('[data-revoke]');
      if (rv && await confirmDialog('Deze uitnodiging intrekken?', 'Intrekken')) { await q(sb.rpc('revoke_invite', { p_invite: rv.dataset.revoke })); await loadInvites(); draw(); return; }
      if (t.closest('#share')) {
        const link = `${location.origin}${location.pathname}#/join/${state.household.invite_code}`;
        const text = `Doe mee met "${state.household.name}" in onze boodschappenapp: ${link}`;
        if (navigator.share) await navigator.share({ title: 'Uitnodiging boodschappenapp', text, url: link }).catch(() => {});
        else { await navigator.clipboard.writeText(link); toast('Link gekopieerd'); }
        return;
      }
      if (t.closest('#regen')) { state.household.invite_code = await q(sb.rpc('regenerate_invite', { p_household: hid() })); draw(); toast('Nieuwe code gemaakt; de oude werkt niet meer'); return; }
      if (t.closest('#install')) { window.__installPrompt?.prompt(); return; }
      if (t.closest('#logout')) { await signOut(); location.hash = '#/login'; location.reload(); return; }
      if (t.closest('#leave')) {
        if (!(await confirmDialog(`Weet je zeker dat je "${state.household.name}" wilt verlaten?`, 'Verlaten'))) return;
        await q(sb.rpc('remove_member', { p_household: hid(), p_user: state.user.id }));
        localStorage.removeItem('bs.household'); await loadHouseholds(); go(state.household ? 'dashboard' : 'start'); location.reload();
      }
    } catch (err) { toast(errorText(err), 'error'); }
  };

  el.onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try {
      if (e.target.id === 'inv') {
        const res = await q(sb.rpc('invite_member', { p_household: hid(), p_email: f.email, p_role: f.role }));
        if (res === 'toegevoegd') { toast(`${f.email} had al een account en is nu lid van jullie huishouden`); await loadMembers(); }
        else { toast('Uitnodiging klaar — stuur het bericht door'); await shareInvite(f.email.toLowerCase()); }
        await loadInvites(); draw(); return;
      }
      if (e.target.id === 'pf') {
        await q(sb.from('profiles').update({ display_name: f.display_name }).eq('id', state.user.id));
        state.profile.display_name = f.display_name; await loadMembers(); draw(); toast('Profiel opgeslagen');
      }
      if (e.target.id === 'hf') {
        const h = state.household;
        const patch = { name: f.name, travel_mode: f.travel_mode, cost_per_km: num(f.cost_per_km, 0.23), time_value_per_hour: num(f.time_value, 0),
          max_stores: Math.min(5, Math.max(1, Math.round(num(f.max_stores, 3)))), stores_enabled: Object.keys(STORES).filter((k) => f['store_' + k] === 'on') };
        if (!patch.stores_enabled.length) { toast('Kies minstens één supermarkt', 'error'); return; }
        if ((f.address || '') !== (h.home_address || '')) {
          if (f.address) { const g = await geocode(f.address); Object.assign(patch, { home_address: f.address, home_lat: g.lat, home_lng: g.lng }); toast('Adres gevonden: ' + g.label.split(',').slice(0, 3).join(',')); }
          else Object.assign(patch, { home_address: null, home_lat: null, home_lng: null });
        }
        const [row] = await q(sb.from('households').update(patch).eq('id', h.id).select());
        state.household = row; state.households = state.households.map((x) => x.id === row.id ? { ...x, name: row.name } : x);
        draw(); toast('Instellingen opgeslagen');
        document.querySelector('#hh-switch').textContent = row.name;
      }
    } catch (err) { toast(errorText(err), 'error'); }
  };

  return onChange(['household_members', 'households', 'household_invites'], async () => {
    try { await loadMembers(); await loadInvites(); state.household = (await q(sb.from('households').select('*').eq('id', hid()).single())); draw(); } catch { /* */ }
  });
}
