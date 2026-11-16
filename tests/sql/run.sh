#!/bin/sh
# Laadt het schema in een verse lokale database en draait de beveiligingstests.
cd "$(dirname "$0")/../.."
su postgres -c "psql -q -c 'drop database if exists bs_test' -c 'create database bs_test'" >/dev/null 2>&1
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d bs_test -f tests/sql/01_stub_in_db.sql -f supabase/migrations/001_schema.sql -f supabase/migrations/002_website_offers.sql -f supabase/migrations/003_invite_only.sql" 2>&1 | grep ERROR
su postgres -c "psql -q -d bs_test -f tests/sql/10_rls_test.sql -f tests/sql/20_invite_test.sql" 2>&1
