\set ON_ERROR_STOP 1
insert into auth.users(id,email,raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111','anna@x.nl','{"display_name":"Anna"}'),
 ('22222222-2222-2222-2222-222222222222','bram@x.nl','{}'),
 ('33333333-3333-3333-3333-333333333333','eve@x.nl','{}');
insert into store_products(store,name,price,amount,unit,unit_price,source,checked_at,ext_key) values
 ('ah','AH Halfvolle melk',1.29,1000,'ml',1.29,'test',now(),'a1'),
 ('ah','AH Halfvolle melk 1,5 l',1.79,1500,'ml',1.19,'test',now(),'a2'),
 ('jumbo','Jumbo Halfvolle Melk',1.25,1000,'ml',1.25,'test',now(),'j1'),
 ('dirk','Melkunie Halfvolle melk',1.09,1000,'ml',1.09,'test',now(),'d1'),
 ('dirk','Chocolade melk',1.49,1000,'ml',1.49,'test',now(),'d2');

-- Anna maakt huishouden
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select create_household('Familie Test') as hid \gset
select display_name from profiles;
select invite_code from households \gset
select set_config('my.hid', :'hid', false);
insert into list_items(household_id,list_id,name) select :'hid', id, 'halfvolle melk' from shopping_lists;
-- Eve ziet niets en kan niets toevoegen
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select 'eve ziet items: ' || count(*) from list_items;
select 'eve ziet huishoudens: ' || count(*) from households;
do $$ begin
  begin insert into list_items(household_id,list_id,name) select h, l, 'hack' from (select '00000000-0000-0000-0000-000000000000'::uuid h, gen_random_uuid() l) x;
        raise notice 'FOUT: insert toegestaan';
  exception when others then raise notice 'ok: eve insert geweigerd (%)', sqlerrm; end;
end $$;
-- Bram joint
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select join_household(:'invite_code') = :'hid' as bram_joined;
select 'bram ziet items: ' || count(*) from list_items;
select string_agg(display_name, ',' order by display_name) as namen from profiles;
update list_items set checked = true, checked_by = auth.uid();
-- Bram (member) mag budget niet wijzigen
update budgets set weekly = 999;
select 'budget na bram-update: ' || coalesce(weekly::text,'null') from budgets;
-- Bram mag geen prijzen schrijven
do $$ begin
  begin insert into store_products(store,name,price,source,checked_at,ext_key) values ('ah','x',1,'x',now(),'x'); raise notice 'FOUT';
  exception when others then raise notice 'ok: prijs-insert geweigerd'; end;
end $$;
-- Bram kan Anna (laatste admin) niet degraderen
do $$ begin
  begin perform set_member_role(current_setting('my.hid')::uuid, '11111111-1111-1111-1111-111111111111','member'); raise notice 'FOUT';
  exception when others then raise notice 'ok: %', sqlerrm; end;
end $$;
-- Anna: budget + rollen
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update budgets set weekly = 120, monthly = 500;
select 'budget: ' || weekly || ' / ' || monthly from budgets;
select set_member_role(:'hid','22222222-2222-2222-2222-222222222222','admin');
select set_member_role(:'hid','11111111-1111-1111-1111-111111111111','member');
select string_agg(role, ',' order by role) as rollen from household_members;
-- Prijzen
select count(*) as zoek_melk from search_products('halfvolle melk');
select jsonb_pretty(match_products(array['halfvolle melk','xyz onbekend'], null, 1));
select * from price_status order by store;
