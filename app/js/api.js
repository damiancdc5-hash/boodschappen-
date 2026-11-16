// Verbinding met Supabase: inloggen, huishouden, realtime synchronisatie en een offline-wachtrij.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export function getConfig() {
  let url = SUPABASE_URL, key = SUPABASE_ANON_KEY;
  if (!url || !key) {
    try { const c = JSON.parse(localStorage.getItem('bs.config') || 'null'); if (c) { url = c.url; key = c.key; } } catch { /* leeg */ }
  }
  return url && key ? { url, key } : null;
}

export function saveConfig(url, key) { localStorage.setItem('bs.config', JSON.stringify({ url: url.trim(), key: key.trim() })); }

const cfg = getConfig();
export const sb = cfg ? createClient(cfg.url, cfg.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 20 } },
}) : null;

// ------------------------------------------------------------------ gedeelde toestand
export const state = {
  session: null,
  user: null,
  profile: null,
  households: [],     // [{id,name,role}]
  household: null,    // volledige rij van het actieve huishouden
  role: null,
  members: [],
  online: navigator.onLine,
};

const listeners = new Map(); // table → Set(fn)
export function onChange(tables, fn) {
  const arr = Array.isArray(tables) ? tables : [tables];
  arr.forEach((t) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); });
  return () => arr.forEach((t) => listeners.get(t)?.delete(fn));
}
export function emit(table, payload = {}) {
  listeners.get(table)?.forEach((fn) => { try { fn({ table, ...payload }); } catch (e) { console.error(e); } });
  listeners.get('*')?.forEach((fn) => { try { fn({ table, ...payload }); } catch (e) { console.error(e); } });
}

// ------------------------------------------------------------------ helpers
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
export const hid = () => state.household?.id;
export const isAdmin = () => state.role === 'admin';

// ------------------------------------------------------------------ authenticatie
export async function initAuth() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  state.user = data.session?.user || null;
  sb.auth.onAuthStateChange((event, session) => {
    state.session = session;
    const changed = (session?.user?.id || null) !== (state.user?.id || null);
    state.user = session?.user || null;
    if (changed || event === 'SIGNED_OUT' || event === 'PASSWORD_RECOVERY') emit('auth', { event });
  });
}

export async function signUp(email, password, displayName) {
  const redirect = location.origin + location.pathname;
  return q(sb.auth.signUp({ email, password, options: { data: { display_name: displayName }, emailRedirectTo: redirect } }));
}
export async function signIn(email, password) { return q(sb.auth.signInWithPassword({ email, password })); }
export async function signOut() { stopRealtime(); await sb.auth.signOut(); state.household = null; localStorage.removeItem('bs.household'); }
export async function resetPassword(email) {
  return q(sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + '#/nieuw-wachtwoord' }));
}

// ------------------------------------------------------------------ huishouden
export async function loadHouseholds() {
  const uid = state.user.id;
  state.profile = await q(sb.from('profiles').select('*').eq('id', uid).maybeSingle());
  const rows = await q(sb.from('household_members').select('role, households(id,name)').eq('user_id', uid));
  state.households = rows.filter((r) => r.households).map((r) => ({ id: r.households.id, name: r.households.name, role: r.role }));
  const pref = localStorage.getItem('bs.household');
  const pick = state.households.find((h) => h.id === pref) || state.households[0];
  if (pick) await selectHousehold(pick.id); else { state.household = null; state.role = null; }
}

export async function selectHousehold(id) {
  state.household = await q(sb.from('households').select('*').eq('id', id).single());
  state.role = state.households.find((h) => h.id === id)?.role || 'member';
  localStorage.setItem('bs.household', id);
  await loadMembers();
  startRealtime();
  emit('household');
}

export async function loadMembers() {
  const rows = await q(sb.from('household_members').select('user_id, role, joined_at').eq('household_id', hid()));
  const profiles = await q(sb.from('profiles').select('id, display_name').in('id', rows.map((r) => r.user_id)));
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.display_name]));
  state.members = rows.map((r) => ({ ...r, name: names[r.user_id] || 'Gezinslid' }));
  const me = state.members.find((m) => m.user_id === state.user.id);
  if (me) state.role = me.role;
}

export function memberName(uid) {
  return state.members.find((m) => m.user_id === uid)?.name || '';
}

export async function createHousehold(name) {
  const id = await q(sb.rpc('create_household', { p_name: name }));
  await loadHouseholds(); await selectHousehold(id); return id;
}
export async function joinHousehold(code) {
  const id = await q(sb.rpc('join_household', { p_code: code }));
  await loadHouseholds(); await selectHousehold(id); return id;
}

// ------------------------------------------------------------------ realtime
const TABLES = ['households', 'household_members', 'household_invites', 'shopping_lists', 'list_items', 'favorites', 'offers', 'recipes',
  'recipe_ingredients', 'meal_plans', 'meal_plan_entries', 'pantry_items', 'budgets', 'purchases'];
let channel = null;

export function startRealtime() {
  stopRealtime();
  const id = hid();
  if (!id) return;
  channel = sb.channel(`hh-${id}`);
  for (const t of TABLES) {
    const filter = t === 'households' ? `id=eq.${id}` : `household_id=eq.${id}`;
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: t, filter }, (p) => emit(t, { type: 'INSERT', new: p.new }));
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: t, filter }, (p) => emit(t, { type: 'UPDATE', new: p.new }));
    channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table: t }, (p) => emit(t, { type: 'DELETE', old: p.old }));
  }
  channel.subscribe((status) => emit('realtime', { status }));
}
export function stopRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }

// Na terugkomen in de app (telefoon uit slaapstand) alles verversen
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.household) { flushOutbox(); emit('refresh'); }
});

// ------------------------------------------------------------------ offline-wachtrij (voor de boodschappenlijst)
const OUTBOX = 'bs.outbox';
function readOutbox() { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; } }
function writeOutbox(a) { localStorage.setItem(OUTBOX, JSON.stringify(a)); emit('outbox', { count: a.length }); }
export const outboxCount = () => readOutbox().length;

function isNetworkError(e) { return !navigator.onLine || /Failed to fetch|NetworkError|Load failed|network/i.test(e?.message || ''); }

/** Schrijfactie die offline in een wachtrij komt. op: 'insert'|'update'|'delete' */
export async function mutate(table, op, payload, match) {
  try {
    return await runMutation({ table, op, payload, match });
  } catch (e) {
    if (isNetworkError(e)) {
      writeOutbox([...readOutbox(), { table, op, payload, match, at: Date.now() }]);
      return null;
    }
    throw e;
  }
}
async function runMutation({ table, op, payload, match }) {
  let qb = sb.from(table);
  if (op === 'insert') return q(qb.insert(payload).select());
  if (op === 'upsert') return q(qb.upsert(payload).select());
  if (op === 'update') return q(qb.update(payload).match(match).select());
  if (op === 'delete') return q(qb.delete().match(match));
  throw new Error('Onbekende actie');
}
let flushing = false;
export async function flushOutbox() {
  if (flushing || !navigator.onLine || !sb) return;
  flushing = true;
  try {
    let box = readOutbox();
    while (box.length) {
      try { await runMutation(box[0]); } catch (e) { if (isNetworkError(e)) break; console.warn('Wachtrij-actie mislukt', e); }
      box = box.slice(1); writeOutbox(box);
    }
    if (!box.length) emit('refresh');
  } finally { flushing = false; }
}
window.addEventListener('online', () => { state.online = true; emit('online'); flushOutbox(); });
window.addEventListener('offline', () => { state.online = false; emit('online'); });

// ------------------------------------------------------------------ lokale cache (lezen zonder verbinding)
export function cacheSet(key, value) { try { localStorage.setItem('bs.cache.' + key, JSON.stringify({ t: Date.now(), v: value })); } catch { /* vol */ } }
export function cacheGet(key, maxAgeMs = Infinity) {
  try { const c = JSON.parse(localStorage.getItem('bs.cache.' + key) || 'null'); if (c && Date.now() - c.t < maxAgeMs) return c.v; } catch { /* leeg */ }
  return null;
}
