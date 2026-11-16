-- =====================================================================
--  Aanbiedingen van de supermarktwebsites (dagelijkse sync)
--  Voer dit uit in Supabase > SQL Editor NA 001_schema.sql. Herhaalbaar.
-- =====================================================================

alter table public.offers add column if not exists offer_price  numeric(10,2);
alter table public.offers add column if not exists size_text    text;
alter table public.offers add column if not exists link         text;
alter table public.offers add column if not exists ext_id       text;
alter table public.offers add column if not exists category     text;
alter table public.offers add column if not exists match_terms  text[] not null default '{}';
alter table public.offers add column if not exists fetched_at   timestamptz not null default now();

alter table public.offers drop constraint if exists offers_offer_type_check;
alter table public.offers add constraint offers_offer_type_check
  check (offer_type in ('percent','amount_off','1+1','2+1','nplusm','2e_half','multibuy','fixed','card','info'));

create index if not exists offers_public_store_idx on public.offers(store, valid_to) where household_id is null;

-- De sync schrijft met de service role; gewone gebruikers kunnen bron-acties alleen lezen (zie offers_select / offers_write in 001).
