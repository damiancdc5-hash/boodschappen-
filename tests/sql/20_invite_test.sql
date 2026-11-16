\set ON_ERROR_STOP 0
-- (na 10_rls_test.sql: Anna en Bram zijn lid, Eve heeft een account zonder huishouden)
set role postgres;
-- Vreemde kan zich niet meer aanmelden
do $$ begin
  begin insert into auth.users(id,email) values (gen_random_uuid(),'vreemd@x.nl'); raise notice 'FOUT: aanmelden zonder uitnodiging toegestaan';
  exception when others then raise notice 'ok: aanmelden geweigerd (%)', sqlerrm; end;
end $$;
set role authenticated;
-- Bram is inmiddels beheerder (zie rollen-test); Anna gezinslid → Anna mag niet uitnodigen
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin
  begin perform invite_member((select id from households limit 1), 'kind@x.nl'); raise notice 'FOUT: lid mocht uitnodigen';
  exception when others then raise notice 'ok: %', sqlerrm; end;
end $$;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select invite_member((select id from households limit 1), 'Kind@X.nl') as resultaat_nieuw;
select invite_member((select id from households limit 1), 'eve@x.nl') as resultaat_bestaand;
select email, accepted_at is not null as geaccepteerd from household_invites order by email;
set role postgres;
insert into auth.users(id,email,raw_user_meta_data) values ('44444444-4444-4444-4444-444444444444','kind@x.nl','{"display_name":"Kind"}');
select 'kind is lid: ' || count(*) from household_members where user_id = '44444444-4444-4444-4444-444444444444';
select 'eve is lid: ' || count(*) from household_members where user_id = '33333333-3333-3333-3333-333333333333';
