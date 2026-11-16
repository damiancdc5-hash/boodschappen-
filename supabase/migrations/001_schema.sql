-- =====================================================================
--  Slimme Boodschappenassistent — databaseschema (Supabase / PostgreSQL)
--  Voer dit volledige bestand één keer uit in Supabase > SQL Editor.
--  Het script is herhaalbaar: opnieuw uitvoeren is veilig.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
--  Profielen (één per account)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
--  Huishoudens en leden
-- ---------------------------------------------------------------------
create table if not exists public.households (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  invite_code          text not null unique,
  home_address         text,
  home_lat             double precision,
  home_lng             double precision,
  travel_mode          text not null default 'car' check (travel_mode in ('car','bike','walk')),
  cost_per_km          numeric(6,3) not null default 0.23,   -- € per km (auto)
  time_value_per_hour  numeric(6,2) not null default 0,      -- € per uur reistijd (0 = tijd telt niet als geld)
  max_stores           int not null default 3 check (max_stores between 1 and 5),
  stores_enabled       text[] not null default array['ah','jumbo','lidl','aldi','plus','dirk','vomar','hoogvliet','dekamarkt'],
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('admin','member')),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index if not exists household_members_user_idx on public.household_members(user_id);

create or replace function public.is_member(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.household_members m where m.household_id = hid and m.user_id = auth.uid());
$$;

create or replace function public.is_admin(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.household_members m where m.household_id = hid and m.user_id = auth.uid() and m.role = 'admin');
$$;

create or replace function public.shares_household(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members a
    join public.household_members b on a.household_id = b.household_id
    where a.user_id = auth.uid() and b.user_id = other);
$$;

-- ---------------------------------------------------------------------
--  Boodschappenlijsten
-- ---------------------------------------------------------------------
create table if not exists public.shopping_lists (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  is_default   boolean not null default false,
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists shopping_lists_hh_idx on public.shopping_lists(household_id);

create table if not exists public.list_items (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.households(id) on delete cascade,
  list_id          uuid not null references public.shopping_lists(id) on delete cascade,
  name             text not null,
  quantity         numeric(10,3) not null default 1,
  unit             text not null default 'st',
  category         text not null default 'Overig',
  note             text,
  checked          boolean not null default false,
  checked_by       uuid references auth.users(id),
  checked_at       timestamptz,
  pinned_product_id bigint,             -- gekozen product uit store_products
  source           text,                -- bijv. 'recept:Lasagne' of 'weekmenu'
  added_by         uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists list_items_list_idx on public.list_items(list_id);
create index if not exists list_items_hh_idx on public.list_items(household_id);

create table if not exists public.favorites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  quantity     numeric(10,3) not null default 1,
  unit         text not null default 'st',
  category     text not null default 'Overig',
  created_at   timestamptz not null default now(),
  unique (household_id, name)
);

-- ---------------------------------------------------------------------
--  Supermarktprijzen (gevuld door de prijssync, alleen-lezen voor gebruikers)
-- ---------------------------------------------------------------------
create table if not exists public.store_products (
  id          bigserial primary key,
  store       text not null,               -- 'ah','jumbo',...
  name        text not null,
  link        text,
  price       numeric(10,2) not null,      -- schapprijs in euro
  size_text   text,                        -- zoals aangeleverd door de bron, bijv. '1 l'
  amount      numeric(12,3),               -- genormaliseerde hoeveelheid
  unit        text,                        -- 'g' | 'ml' | 'st'
  unit_price  numeric(12,4),               -- € per kg / per l / per stuk
  source      text not null,               -- 'checkjebon' etc.
  checked_at  timestamptz not null,        -- wanneer de bron deze prijs voor het laatst controleerde/ophaalde
  seen_at     timestamptz not null default now(),
  ext_key     text not null,
  unique (store, ext_key)
);
create index if not exists store_products_name_trgm on public.store_products using gin (name extensions.gin_trgm_ops);
create index if not exists store_products_store_idx on public.store_products(store);

create table if not exists public.price_sync_runs (
  id          bigserial primary key,
  source      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',
  rows        int,
  per_store   jsonb,
  message     text
);

-- Aanbiedingen: alleen echte, door gezinsleden ingevoerde of door een bron aangeleverde acties.
create table if not exists public.offers (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid references public.households(id) on delete cascade, -- null = afkomstig uit een bron (voor iedereen)
  store            text not null,
  product_name     text not null,
  store_product_id bigint references public.store_products(id) on delete set null,
  offer_type       text not null check (offer_type in ('percent','1+1','2+1','2e_half','multibuy','fixed','card')),
  params           jsonb not null default '{}'::jsonb, -- percent:{pct}, multibuy:{n,total}, fixed:{price}, card:{price}
  regular_price    numeric(10,2),
  valid_from       date not null default current_date,
  valid_to         date not null,
  source           text not null default 'handmatig',
  entered_by       uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now()
);
create index if not exists offers_hh_idx on public.offers(household_id);

-- ---------------------------------------------------------------------
--  Recepten en weekmenu
-- ---------------------------------------------------------------------
create table if not exists public.recipes (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title        text not null,
  servings     int not null default 4 check (servings > 0),
  source_url   text,
  instructions text,
  tags         text[] not null default '{}',
  image_url    text,
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists recipes_hh_idx on public.recipes(household_id);

create table if not exists public.recipe_ingredients (
  id           uuid primary key default gen_random_uuid(),
  recipe_id    uuid not null references public.recipes(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  quantity     numeric(10,3),
  unit         text,
  raw          text,
  optional     boolean not null default false,
  sort         int not null default 0
);
create index if not exists recipe_ingredients_recipe_idx on public.recipe_ingredients(recipe_id);

create table if not exists public.meal_plans (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  week_start   date not null,
  persons      int not null default 2,
  days         int not null default 7,
  budget       numeric(10,2),
  preferences  text[] not null default '{}',
  status       text not null default 'concept' check (status in ('concept','goedgekeurd')),
  est_cost     numeric(10,2),
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists meal_plans_hh_idx on public.meal_plans(household_id);

create table if not exists public.meal_plan_entries (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.meal_plans(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  day          int not null check (day between 0 and 13),
  recipe_id    uuid references public.recipes(id) on delete set null,
  servings     int not null default 2,
  est_cost     numeric(10,2)
);
create index if not exists meal_plan_entries_plan_idx on public.meal_plan_entries(plan_id);

-- ---------------------------------------------------------------------
--  Voorraadkast
-- ---------------------------------------------------------------------
create table if not exists public.pantry_items (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  quantity     numeric(10,3) not null default 1,
  unit         text not null default 'st',
  expires_on   date,
  location     text,
  barcode      text,
  updated_by   uuid references auth.users(id) default auth.uid(),
  updated_at   timestamptz not null default now()
);
create index if not exists pantry_hh_idx on public.pantry_items(household_id);

-- ---------------------------------------------------------------------
--  Budget en uitgaven
-- ---------------------------------------------------------------------
create table if not exists public.budgets (
  household_id uuid primary key references public.households(id) on delete cascade,
  weekly       numeric(10,2),
  monthly      numeric(10,2),
  warn_pct     int not null default 85 check (warn_pct between 50 and 100)
);

create table if not exists public.purchases (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  purchased_on    date not null default current_date,
  store           text,
  amount          numeric(10,2) not null check (amount >= 0),   -- werkelijk betaald
  planned_amount  numeric(10,2),                                -- verwachte kosten volgens de app
  regular_amount  numeric(10,2),                                -- zelfde producten tegen normale prijs
  offer_savings   numeric(10,2) not null default 0,             -- besparing door acties
  compare_savings numeric(10,2) not null default 0,             -- besparing t.o.v. gemiddelde supermarktprijs
  note            text,
  created_by      uuid references auth.users(id) default auth.uid(),
  created_at      timestamptz not null default now()
);
create index if not exists purchases_hh_idx on public.purchases(household_id, purchased_on);

-- ---------------------------------------------------------------------
--  updated_at bijhouden
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists list_items_touch on public.list_items;
create trigger list_items_touch before update on public.list_items for each row execute function public.touch_updated_at();
drop trigger if exists pantry_touch on public.pantry_items;
create trigger pantry_touch before update on public.pantry_items for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.households         enable row level security;
alter table public.household_members  enable row level security;
alter table public.shopping_lists     enable row level security;
alter table public.list_items         enable row level security;
alter table public.favorites          enable row level security;
alter table public.store_products     enable row level security;
alter table public.price_sync_runs    enable row level security;
alter table public.offers             enable row level security;
alter table public.recipes            enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.meal_plans         enable row level security;
alter table public.meal_plan_entries  enable row level security;
alter table public.pantry_items       enable row level security;
alter table public.budgets            enable row level security;
alter table public.purchases          enable row level security;

-- profielen
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_household(id));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- huishoudens: lezen als lid, wijzigen als beheerder. Aanmaken/joinen via RPC.
drop policy if exists households_select on public.households;
create policy households_select on public.households for select to authenticated using (public.is_member(id));
drop policy if exists households_update on public.households;
create policy households_update on public.households for update to authenticated
  using (public.is_admin(id)) with check (public.is_admin(id));
drop policy if exists households_delete on public.households;
create policy households_delete on public.households for delete to authenticated using (public.is_admin(id));

drop policy if exists members_select on public.household_members;
create policy members_select on public.household_members for select to authenticated using (public.is_member(household_id));

-- generieke huishoud-tabellen: alle leden mogen lezen en schrijven
do $$
declare t text;
begin
  foreach t in array array['shopping_lists','list_items','favorites','recipes','recipe_ingredients',
                           'meal_plans','meal_plan_entries','pantry_items','purchases']
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format('create policy %I_all on public.%I for all to authenticated
                      using (public.is_member(household_id)) with check (public.is_member(household_id))', t, t);
  end loop;
end $$;

-- budget: iedereen leest, alleen beheerders wijzigen
drop policy if exists budgets_select on public.budgets;
create policy budgets_select on public.budgets for select to authenticated using (public.is_member(household_id));
drop policy if exists budgets_write on public.budgets;
create policy budgets_write on public.budgets for all to authenticated
  using (public.is_admin(household_id)) with check (public.is_admin(household_id));

-- prijzen: iedereen die is ingelogd mag lezen; schrijven alleen via service role (prijssync)
drop policy if exists store_products_select on public.store_products;
create policy store_products_select on public.store_products for select to authenticated using (true);
drop policy if exists price_sync_runs_select on public.price_sync_runs;
create policy price_sync_runs_select on public.price_sync_runs for select to authenticated using (true);

-- aanbiedingen: bron-acties (household_id null) zichtbaar voor iedereen; eigen acties alleen voor het huishouden
drop policy if exists offers_select on public.offers;
create policy offers_select on public.offers for select to authenticated
  using (household_id is null or public.is_member(household_id));
drop policy if exists offers_write on public.offers;
create policy offers_write on public.offers for all to authenticated
  using (household_id is not null and public.is_member(household_id))
  with check (household_id is not null and public.is_member(household_id));

-- ---------------------------------------------------------------------
--  RPC's: huishouden aanmaken / joinen / beheren
-- ---------------------------------------------------------------------
create or replace function public.new_invite_code() returns text language sql volatile as $$
  select upper(substr(translate(encode(decode(md5(random()::text || clock_timestamp()::text),'hex'),'base64'),'+/=0O1I',''),1,8));
$$;

create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Geef het huishouden een naam'; end if;
  insert into households(name, invite_code, created_by) values (trim(p_name), new_invite_code(), auth.uid()) returning id into hid;
  insert into household_members(household_id, user_id, role) values (hid, auth.uid(), 'admin');
  insert into shopping_lists(household_id, name, is_default) values (hid, 'Boodschappen', true);
  insert into budgets(household_id) values (hid);
  return hid;
end $$;

create or replace function public.join_household(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'Niet ingelogd'; end if;
  select id into hid from households where invite_code = upper(trim(p_code));
  if hid is null then raise exception 'Onbekende uitnodigingscode'; end if;
  insert into household_members(household_id, user_id, role) values (hid, auth.uid(), 'member')
  on conflict do nothing;
  return hid;
end $$;

create or replace function public.regenerate_invite(p_household uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not is_admin(p_household) then raise exception 'Alleen beheerders'; end if;
  c := new_invite_code();
  update households set invite_code = c where id = p_household;
  return c;
end $$;

create or replace function public.set_member_role(p_household uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_household) then raise exception 'Alleen beheerders'; end if;
  if p_role not in ('admin','member') then raise exception 'Ongeldige rol'; end if;
  if p_role = 'member' and (select count(*) from household_members where household_id = p_household and role = 'admin' and user_id <> p_user) = 0 then
    raise exception 'Er moet minstens één beheerder overblijven';
  end if;
  update household_members set role = p_role where household_id = p_household and user_id = p_user;
end $$;

create or replace function public.remove_member(p_household uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin(p_household) or p_user = auth.uid()) then raise exception 'Geen rechten'; end if;
  if exists (select 1 from household_members where household_id = p_household and user_id = p_user and role = 'admin')
     and (select count(*) from household_members where household_id = p_household and role = 'admin') = 1
     and (select count(*) from household_members where household_id = p_household) > 1 then
    raise exception 'Maak eerst iemand anders beheerder';
  end if;
  delete from household_members where household_id = p_household and user_id = p_user;
end $$;

-- ---------------------------------------------------------------------
--  RPC's: prijzen zoeken en matchen
-- ---------------------------------------------------------------------
-- Zoekt producten waarvan de naam alle woorden van de zoekterm bevat.
create or replace function public.search_products(p_query text, p_stores text[] default null, p_limit int default 60)
returns setof public.store_products
language sql stable security invoker set search_path = public, extensions as $$
  with words as (
    select array_agg('%' || w || '%') as pats
    from regexp_split_to_table(lower(trim(p_query)), '\s+') w where length(w) > 1
  )
  select sp.* from public.store_products sp, words
  where words.pats is not null
    and lower(sp.name) like all (words.pats)
    and (p_stores is null or sp.store = any(p_stores))
  order by extensions.word_similarity(lower(p_query), lower(sp.name)) desc, sp.unit_price asc nulls last, sp.price asc
  limit greatest(1, least(p_limit, 300));
$$;

-- Geeft per gevraagde naam per winkel de beste kandidaten (meest gelijkend, dan goedkoopst per eenheid).
create or replace function public.match_products(p_names text[], p_stores text[] default null, p_per_store int default 3)
returns jsonb
language sql stable security invoker set search_path = public, extensions as $$
  select coalesce(jsonb_object_agg(q.name, q.hits), '{}'::jsonb)
  from (
    select n.name,
      coalesce((
        select jsonb_agg(to_jsonb(r) - 'rn' order by r.store, r.rn)
        from (
          select sp.id, sp.store, sp.name, sp.price, sp.size_text, sp.amount, sp.unit, sp.unit_price, sp.link,
                 sp.checked_at, sp.source,
                 extensions.word_similarity(lower(n.name), lower(sp.name)) as score,
                 row_number() over (partition by sp.store
                                    order by extensions.word_similarity(lower(n.name), lower(sp.name)) desc,
                                             sp.unit_price asc nulls last, sp.price asc) as rn
          from public.store_products sp
          cross join lateral (
            select array_agg('%' || w || '%') as pats
            from regexp_split_to_table(lower(trim(n.name)), '\s+') w where length(w) > 1) wq
          where wq.pats is not null
            and lower(sp.name) like all (wq.pats)
            and (p_stores is null or sp.store = any(p_stores))
        ) r where r.rn <= p_per_store
      ), '[]'::jsonb) as hits
    from (select distinct unnest(p_names) as name) n
    where coalesce(trim(n.name),'') <> ''
  ) q;
$$;

-- Laatste prijssync per bron (voor "laatst gecontroleerd")
create or replace view public.price_status with (security_invoker = true) as
  select store, count(*)::int as products, max(checked_at) as last_checked, max(seen_at) as last_seen
  from public.store_products group by store;

grant usage on schema public to anon, authenticated;
grant usage on schema extensions to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke insert, update, delete on public.store_products, public.price_sync_runs from authenticated;
grant select on public.price_status to authenticated;
grant execute on function public.create_household(text), public.join_household(text), public.regenerate_invite(uuid),
  public.set_member_role(uuid,uuid,text), public.remove_member(uuid,uuid),
  public.search_products(text,text[],int), public.match_products(text[],text[],int),
  public.is_member(uuid), public.is_admin(uuid) to authenticated;
revoke execute on function public.new_invite_code() from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  Realtime: wijzigingen direct naar alle apparaten
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['households','household_members','shopping_lists','list_items','favorites','offers','recipes',
                           'recipe_ingredients','meal_plans','meal_plan_entries','pantry_items','budgets','purchases']
  loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
