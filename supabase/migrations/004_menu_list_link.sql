-- =====================================================================
--  Weekmenu ↔ boodschappenlijst: per dag onthouden welke boodschappen erbij horen,
--  zodat een verwijderde dag ook direct van de lijst gaat. Herhaalbaar.
-- =====================================================================
alter table public.meal_plan_entries add column if not exists list_contrib jsonb not null default '[]'::jsonb;
