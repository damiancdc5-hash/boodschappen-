-- =====================================================================
--  Alleen op uitnodiging + afbeeldingen bij aanbiedingen
--  Voer dit uit in Supabase > SQL Editor NA 001 en 002. Herhaalbaar.
--
--  Werking: zodra er één huishouden bestaat, kan alleen nog een account worden aangemaakt
--  met een e-mailadres dat door een beheerder is uitgenodigd (Huishouden → Uitnodigen).
--  Wie zich aanmeldt met zo'n adres, komt automatisch in het juiste huishouden.
-- =====================================================================

create table if not exists public.household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  email        text not null,
  role         text not null default 'member' check (role in ('admin','member')),
  invited_by   uuid references auth.users(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  accepted_at  timestamptz,
  unique (household_id, email)
);
create index if not exists household_invites_email_idx on public.household_invites(lower(email));

alter table public.household_invites enable row level security;
drop policy if exists household_invites_select on public.household_invites;
create policy household_invites_select on public.household_invites for select to authenticated using (public.is_member(household_id));
grant select on public.household_invites to authenticated;

-- Uitnodigen (alleen beheerders). Bestaat het account al, dan wordt die persoon direct lid.
create or replace function public.invite_member(p_household uuid, p_email text, p_role text default 'member')
returns text language plpgsql security definer set search_path = public, auth as $$
declare v_email text := lower(trim(p_email)); v_user uuid;
begin
  if not is_admin(p_household) then raise exception 'Alleen beheerders kunnen uitnodigen'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Ongeldig e-mailadres'; end if;
  if p_role not in ('admin','member') then raise exception 'Ongeldige rol'; end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    insert into household_members(household_id, user_id, role) values (p_household, v_user, p_role) on conflict do nothing;
    insert into household_invites(household_id, email, role, accepted_at) values (p_household, v_email, p_role, now())
      on conflict (household_id, email) do update set accepted_at = now(), role = excluded.role;
    return 'toegevoegd';
  end if;
  insert into household_invites(household_id, email, role) values (p_household, v_email, p_role)
    on conflict (household_id, email) do update set role = excluded.role, expires_at = now() + interval '30 days', accepted_at = null, invited_by = auth.uid();
  return 'uitgenodigd';
end $$;

create or replace function public.revoke_invite(p_invite uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from household_invites i where i.id = p_invite and is_admin(i.household_id)) then
    raise exception 'Alleen beheerders kunnen uitnodigingen intrekken';
  end if;
  delete from household_invites where id = p_invite;
end $$;

grant execute on function public.invite_member(uuid, text, text), public.revoke_invite(uuid) to authenticated;

-- Nieuwe accounts tegenhouden zonder uitnodiging (het allereerste account mag altijd, om te kunnen beginnen).
create or replace function public.enforce_invite_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.household_members)
     and not exists (select 1 from public.household_invites i
                     where lower(i.email) = lower(new.email) and i.accepted_at is null and i.expires_at > now()) then
    raise exception 'Aanmelden kan alleen op uitnodiging (%).', new.email using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists enforce_invite_only on auth.users;
create trigger enforce_invite_only before insert on auth.users
  for each row execute function public.enforce_invite_only();

-- Na het aanmaken van een account: profiel + automatisch lid worden van de huishoudens die uitnodigden.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  insert into public.household_members (household_id, user_id, role)
    select i.household_id, new.id, i.role from public.household_invites i
    where lower(i.email) = lower(new.email) and i.accepted_at is null and i.expires_at > now()
  on conflict do nothing;
  update public.household_invites set accepted_at = now()
    where lower(email) = lower(new.email) and accepted_at is null;
  return new;
end $$;

-- Realtime voor de uitnodigingenlijst
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'household_invites') then
    alter publication supabase_realtime add table public.household_invites;
  end if;
end $$;

-- Productfoto's bij aanbiedingen (van de websites van de supermarkten)
alter table public.offers add column if not exists image_url text;
