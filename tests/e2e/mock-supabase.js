// TESTHULPMIDDEL — alleen voor de geautomatiseerde UI-test. Bootst de Supabase-client na in de browser
// (database in localStorage, "realtime" via BroadcastChannel tussen tabbladen). Wordt nooit meegeleverd in de app.
const DBKEY = 'mockdb';
const bc = new BroadcastChannel('mock-realtime');
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function load() { return JSON.parse(localStorage.getItem(DBKEY) || '{}'); }
function save(db) { localStorage.setItem(DBKEY, JSON.stringify(db)); }
function table(db, t) { return (db[t] ||= []); }
let session = JSON.parse(sessionStorage.getItem('mock.session') || 'null');
const uid = () => session?.user?.id || null;

const DEFAULTS = {
  households: () => ({ travel_mode: 'car', cost_per_km: 0.23, time_value_per_hour: 0, max_stores: 3, home_lat: null, home_lng: null, home_address: null,
    stores_enabled: ['ah', 'jumbo', 'lidl', 'aldi', 'plus', 'dirk', 'vomar', 'hoogvliet', 'dekamarkt'] }),
  list_items: () => ({ quantity: 1, unit: 'st', category: 'Overig', checked: false, added_by: uid(), pinned_product_id: null, updated_at: now() }),
  shopping_lists: () => ({ is_default: false, archived: false }),
  recipes: () => ({ tags: [], servings: 4, created_by: uid() }),
  meal_plans: () => ({ status: 'concept', preferences: [], created_by: uid() }),
  pantry_items: () => ({ quantity: 1, unit: 'st', updated_by: uid(), updated_at: now() }),
  purchases: () => ({ purchased_on: new Date().toISOString().slice(0, 10), offer_savings: 0, compare_savings: 0, created_by: uid() }),
  offers: () => ({ params: {}, entered_by: uid(), valid_from: new Date().toISOString().slice(0, 10) }),
  budgets: () => ({ warn_pct: 85 }),
};
const PK = { budgets: 'household_id', profiles: 'id' };

function broadcast(t, type, row, old) { const msg = { t, type, new: row, old }; bc.postMessage(msg); dispatch(msg); }
const channels = new Set();
function dispatch(msg) {
  for (const ch of channels) for (const h of ch.handlers) {
    if (h.table !== msg.t || h.event !== msg.type) continue;
    if (h.filter && msg.type !== 'DELETE') { const [col, v] = h.filter.split('=eq.'); if (String(msg.new?.[col]) !== v) continue; }
    setTimeout(() => h.cb({ new: msg.new, old: msg.old }), 0);
  }
}
bc.onmessage = (e) => dispatch(e.data);

function embed(db, t, row, spec) {
  // spec zoals "role, households(id,name)" of "*, meal_plan_entries(*)" of "meal_plan_entries(day, recipe_id, recipes(title))"
  const out = { ...row };
  const re = /(\w+)\(((?:[^()]|\([^()]*\))*)\)/g; let m;
  while ((m = re.exec(spec))) {
    const [_, rel, inner] = m;
    if (rel === 'households') out.households = table(db, 'households').find((h) => h.id === row.household_id) || null;
    else if (rel === 'recipes') out.recipes = table(db, 'recipes').find((r) => r.id === row.recipe_id) || null;
    else if (rel === 'meal_plan_entries') out.meal_plan_entries = table(db, 'meal_plan_entries').filter((e) => e.plan_id === row.id).map((e) => embed(db, 'meal_plan_entries', e, inner));
  }
  return out;
}

class Builder {
  constructor(t) { this.t = t; this.filters = []; this.op = 'select'; this.ret = false; this._order = []; }
  select(spec = '*') { if (this.op === 'select') this.spec = spec; else this.ret = true; return this; }
  insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows) { this.op = 'upsert'; this.payload = rows; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push((r) => String(r[c]) === String(v)); return this; }
  neq(c, v) { this.filters.push((r) => String(r[c]) !== String(v)); return this; }
  in(c, arr) { this.filters.push((r) => arr.map(String).includes(String(r[c]))); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  not(c, op, v) { this.filters.push((r) => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return this; }
  or(expr) {
    const parts = expr.split(',').map((p) => p.split('.'));
    this.filters.push((r) => parts.some(([c, op, ...v]) => op === 'is' ? r[c] == null : String(r[c]) === v.join('.')));
    return this;
  }
  like(c, pat) { const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*') + '$'); this.filters.push((r) => re.test(String(r[c] ?? ''))); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  match(o) { for (const [k, v] of Object.entries(o)) this.eq(k, v); return this; }
  order(c, { ascending = true } = {}) { this._order.push([c, ascending]); return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = true; return this; }
  maybeSingle() { this._maybe = true; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.exec()).then(res, rej); }
  exec() {
    const db = load();
    if (this.t === 'price_status') {
      const by = {};
      for (const p of table(db, 'store_products')) { by[p.store] ||= { store: p.store, products: 0, last_checked: p.checked_at }; by[p.store].products++; }
      return { data: Object.values(by), error: null };
    }
    const rows = table(db, this.t);
    const match = (r) => this.filters.every((f) => f(r));
    let data = null;
    if (this.op === 'select') {
      data = rows.filter(match);
      for (const [c, asc] of this._order.slice().reverse()) data.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      if (this._limit) data = data.slice(0, this._limit);
      if (this.spec && this.spec.includes('(')) data = data.map((r) => embed(db, this.t, r, this.spec));
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const arr = (Array.isArray(this.payload) ? this.payload : [this.payload]);
      data = [];
      for (const p of arr) {
        const pk = PK[this.t] || 'id';
        const ex = this.op === 'upsert' && rows.find((r) => r[pk] === p[pk]);
        if (ex) { Object.assign(ex, p); data.push(ex); broadcast(this.t, 'UPDATE', ex); continue; }
        if (this.op === 'insert' && p.id && rows.some((r) => r.id === p.id)) return { data: null, error: { message: 'duplicate key' } };
        const row = { id: uuid(), created_at: now(), ...(DEFAULTS[this.t]?.() || {}), ...p };
        rows.push(row); data.push(row); broadcast(this.t, 'INSERT', row);
      }
    } else if (this.op === 'update') {
      data = rows.filter(match);
      data.forEach((r) => { Object.assign(r, this.payload); broadcast(this.t, 'UPDATE', r); });
    } else if (this.op === 'delete') {
      const del = rows.filter(match);
      db[this.t] = rows.filter((r) => !match(r));
      if (this.t === 'meal_plans') db.meal_plan_entries = table(db, 'meal_plan_entries').filter((e) => !del.some((d) => d.id === e.plan_id));
      if (this.t === 'recipes') db.recipe_ingredients = table(db, 'recipe_ingredients').filter((e) => !del.some((d) => d.id === e.recipe_id));
      save(db); del.forEach((r) => broadcast(this.t, 'DELETE', null, { id: r.id }));
      return { data: null, error: null };
    }
    save(db);
    if (this.op !== 'select' && !this.ret) data = null;
    if (this._single || this._maybe) {
      if (!data?.length && this._single) return { data: null, error: { message: 'not found' } };
      data = data?.[0] || null;
    }
    return { data: data && JSON.parse(JSON.stringify(data)), error: null };
  }
}

function rpc(name, a) {
  const db = load();
  const ok = (data) => ({ data, error: null });
  const code = () => Math.random().toString(36).slice(2, 10).toUpperCase();
  switch (name) {
    case 'create_household': {
      const id = uuid();
      table(db, 'households').push({ id, name: a.p_name, invite_code: code(), created_by: uid(), created_at: now(), ...DEFAULTS.households() });
      table(db, 'household_members').push({ household_id: id, user_id: uid(), role: 'admin', joined_at: now() });
      table(db, 'shopping_lists').push({ id: uuid(), household_id: id, name: 'Boodschappen', is_default: true, archived: false, created_at: now() });
      table(db, 'budgets').push({ household_id: id, weekly: null, monthly: null, warn_pct: 85 });
      save(db); return ok(id);
    }
    case 'join_household': {
      const h = table(db, 'households').find((x) => x.invite_code === a.p_code.toUpperCase().trim());
      if (!h) return { data: null, error: { message: 'Onbekende uitnodigingscode' } };
      table(db, 'household_members').push({ household_id: h.id, user_id: uid(), role: 'member', joined_at: now() });
      save(db); broadcast('household_members', 'INSERT', { household_id: h.id, user_id: uid() }); return ok(h.id);
    }
    case 'invite_member': {
      const email = a.p_email.toLowerCase().trim();
      const u = table(db, 'users').find((x) => x.email === email);
      if (u) { table(db, 'household_members').push({ household_id: a.p_household, user_id: u.id, role: a.p_role || 'member', joined_at: now() }); save(db); broadcast('household_members', 'INSERT', { household_id: a.p_household, user_id: u.id }); return ok('toegevoegd'); }
      const inv = { id: uuid(), household_id: a.p_household, email, role: a.p_role || 'member', created_at: now(), expires_at: new Date(Date.now() + 30 * 864e5).toISOString(), accepted_at: null };
      table(db, 'household_invites').push(inv); save(db); broadcast('household_invites', 'INSERT', inv); return ok('uitgenodigd');
    }
    case 'revoke_invite': db.household_invites = table(db, 'household_invites').filter((x) => x.id !== a.p_invite); save(db); return ok(null);
    case 'regenerate_invite': { const h = table(db, 'households').find((x) => x.id === a.p_household); h.invite_code = code(); save(db); return ok(h.invite_code); }
    case 'set_member_role': { const m = table(db, 'household_members').find((x) => x.household_id === a.p_household && x.user_id === a.p_user); m.role = a.p_role; save(db); return ok(null); }
    case 'remove_member': db.household_members = table(db, 'household_members').filter((x) => !(x.household_id === a.p_household && x.user_id === a.p_user)); save(db); return ok(null);
    case 'search_products': case 'match_products': {
      const find = (q) => {
        const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        if (!words.length) return [];
        return table(db, 'store_products').filter((p) => words.every((w) => p.name.toLowerCase().includes(w)) && (!a.p_stores || a.p_stores.includes(p.store)))
          .map((p) => ({ ...p, score: words.join(' ').length / p.name.length })).sort((x, y) => y.score - x.score || x.unit_price - y.unit_price);
      };
      if (name === 'search_products') return ok(find(a.p_query).slice(0, a.p_limit || 60));
      const out = {};
      for (const n of a.p_names) {
        const per = {}; out[n] = [];
        for (const p of find(n)) { per[p.store] = (per[p.store] || 0) + 1; if (per[p.store] <= (a.p_per_store || 3)) out[n].push(p); }
      }
      return ok(out);
    }
  }
  return { data: null, error: { message: 'onbekende rpc ' + name } };
}

export function createClient() {
  const authListeners = [];
  const setSession = (s, ev) => { session = s; sessionStorage.setItem('mock.session', JSON.stringify(s)); authListeners.forEach((f) => f(ev, s)); };
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: (f) => { authListeners.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
      signUp: async ({ email, password, options }) => {
        const db = load(); const users = table(db, 'users');
        if (users.some((u) => u.email === email)) return { data: null, error: { message: 'User already registered' } };
        const invites = table(db, 'household_invites').filter((i) => i.email === email.toLowerCase() && !i.accepted_at);
        if (table(db, 'household_members').length && !invites.length) return { data: null, error: { message: 'Database error saving new user' } };
        const user = { id: uuid(), email, password }; users.push(user);
        table(db, 'profiles').push({ id: user.id, display_name: options?.data?.display_name || email.split('@')[0] });
        const joined = invites.map((i) => { const m = { household_id: i.household_id, user_id: user.id, role: i.role, joined_at: now() }; table(db, 'household_members').push(m); i.accepted_at = now(); return m; });
        save(db); joined.forEach((m) => broadcast('household_members', 'INSERT', m)); const s = { user: { id: user.id, email } }; setSession(s, 'SIGNED_IN'); return { data: { session: s, user: s.user }, error: null };
      },
      signInWithPassword: async ({ email, password }) => {
        const u = table(load(), 'users').find((x) => x.email === email && x.password === password);
        if (!u) return { data: null, error: { message: 'Invalid login credentials' } };
        const s = { user: { id: u.id, email } }; setSession(s, 'SIGNED_IN'); return { data: { session: s }, error: null };
      },
      signOut: async () => { setSession(null, 'SIGNED_OUT'); return { error: null }; },
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
    },
    from: (t) => new Builder(t),
    rpc: async (n, a) => rpc(n, a || {}),
    channel: () => {
      const ch = { handlers: [], on(_, f, cb) { this.handlers.push({ table: f.table, event: f.event, filter: f.filter, cb }); return this; },
        subscribe(cb) { channels.add(this); setTimeout(() => cb && cb('SUBSCRIBED'), 0); return this; } };
      return ch;
    },
    removeChannel: (ch) => channels.delete(ch),
    functions: { invoke: async () => ({ data: null, error: { message: 'niet beschikbaar in test' } }) },
  };
}
