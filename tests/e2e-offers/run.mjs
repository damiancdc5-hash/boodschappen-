// Pipeline-test: draait scripts/sync-offers.mjs met een echte (onzichtbare) browser tegen nagebootste supermarktpagina's
// en een nagebootste Supabase-REST-server, en controleert wat er opgeslagen zou worden.
//   python3 tests/e2e-offers/make_pages.py && node tests/e2e-offers/run.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const pages = http.createServer((req, res) => {
  const f = path.join(here, 'pages', path.basename(req.url.split('?')[0]));
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync(f));
});
const calls = [];
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: decodeURIComponent(req.url), body: json, auth: req.headers.authorization });
    if (req.method === 'POST' && req.url.startsWith('/rest/v1/price_sync_runs')) {
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify([{ id: calls.length }]));
    }
    res.writeHead(204); res.end();
  });
});
await new Promise((r) => pages.listen(8771, r));
await new Promise((r) => api.listen(8772, r));

const code = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(here, '../../scripts/sync-offers.mjs')], {
    env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:8772', SUPABASE_SERVICE_ROLE_KEY: 'test-key', OFFERS_FIXTURE_BASE: 'http://127.0.0.1:8771', OFFERS_MIN_PRODUCTS: '1' },
    stdio: 'inherit',
  });
  p.on('exit', resolve);
});
pages.close(); api.close();

assert.equal(code, 0, 'sync moet slagen');
assert.ok(calls.every((c) => c.auth === 'Bearer test-key'));
const inserted = {};
for (const c of calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/offers'))) {
  for (const o of c.body) { (inserted[o.store] ||= []).push(o); assert.equal(o.household_id, null); assert.ok(o.valid_from && o.valid_to); }
}
const expected = { ah: 9, jumbo: 7, lidl: 6, aldi: 5, plus: 8, dirk: 4, dekamarkt: 4 };
for (const [s, n] of Object.entries(expected)) assert.equal(inserted[s]?.length, n, `${s}: ${inserted[s]?.length} acties, verwacht ${n}`);
// oude bron-acties per winkel worden eerst verwijderd, nooit die van huishoudens
const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/offers?'));
assert.equal(deletes.length, 7);
assert.ok(deletes.every((d) => d.url.includes('household_id=is.null') && d.url.includes('source=like.website*')));
// Lidl-producten komen in de prijsvergelijking
const productCalls = calls.filter((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/store_products'));
const lidlProducts = productCalls.find((c) => c.body[0].store === 'lidl');
assert.equal(lidlProducts.body.length, 6);
assert.ok(lidlProducts.url.includes('on_conflict=store,ext_key'));
// Aldi-assortiment komt in de prijsvergelijking (merkenpagina overgeslagen, doorgestreepte prijs = normale prijs)
const aldiProducts = productCalls.find((c) => c.body[0].store === 'aldi').body;
assert.deepEqual(aldiProducts.map((p) => [p.name, p.price, p.unit_price]), [['Milsani Halfvolle melk', 0.99, 0.99], ['Milsani Yoghurt naturel', 1.39, 1.39]]);
assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('store_products?store=eq.aldi&source=eq.aldi-website')));
// elke winkel krijgt een statusregel 'ok'
const oks = calls.filter((c) => c.method === 'PATCH' && c.body?.status === 'ok');
assert.equal(oks.length, 7);
console.log('PIPELINE OK —', Object.entries(inserted).map(([s, a]) => `${s}: ${a.length}`).join(', '));
