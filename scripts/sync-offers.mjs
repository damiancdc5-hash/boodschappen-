#!/usr/bin/env node
// Aanbiedingensync: bezoekt dagelijks de aanbiedingenpagina's van de supermarkten met een (onzichtbare) browser,
// leest de acties uit en zet ze in Supabase. Draait via GitHub Actions (.github/workflows/sync-offers.yml).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/sync-offers.mjs
//   node scripts/sync-offers.mjs --dry-run --only ah,dirk        (alleen tonen, niets opslaan)
//
// Vereist: npm i playwright && npx playwright install chromium

import * as X from './offers/extractors.mjs';
import * as N from './offers/normalize.mjs';

const STORES = {
  ah: { url: 'https://www.ah.nl/bonus', extract: X.extractAH, normalize: N.normalizeAH },
  jumbo: { url: 'https://www.jumbo.com/aanbiedingen/nu', extract: X.extractJumbo, normalize: N.normalizeJumbo, scroll: 'window', key: (x) => x.id || x.title },
  lidl: { url: 'https://www.lidl.nl/c/aanbiedingen/a10008785', extract: X.extractLidl, normalize: N.normalizeLidl },
  aldi: { url: 'https://www.aldi.nl/aanbiedingen.html', extract: X.extractAldi, normalize: N.normalizeAldi },
  plus: { url: 'https://www.plus.nl/aanbiedingen', extract: X.extractPlus, normalize: N.normalizePlus, scroll: 'wheel', key: (x) => (x.href || '') + '|' + x.name, settle: 5000 },
  dirk: { url: 'https://www.dirk.nl/aanbiedingen', extract: X.extractDetailresult, normalize: (r) => N.normalizeDetailresult('dirk', r) },
  dekamarkt: { url: 'https://www.dekamarkt.nl/aanbiedingen', extract: X.extractDetailresult, normalize: (r) => N.normalizeDetailresult('dekamarkt', r) },
};

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = (args[args.indexOf('--only') + 1] && args.includes('--only')) ? args[args.indexOf('--only') + 1].split(',') : Object.keys(STORES);

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(url, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) } });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function collect(page, cfg) {
  const res = await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const status = res?.status() ?? 0;
  if (status >= 400) throw new Error(`website antwoordt met ${status} (mogelijk geblokkeerd)`);
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(cfg.settle || 2500);
  if (!cfg.scroll) return page.evaluate(cfg.extract);
  // Pagina's die tijdens het scrollen bijladen: na elke stap uitlezen en samenvoegen
  const all = new Map();
  let stable = 0, lastSize = -1;
  const deadline = Date.now() + 120000;
  for (let i = 0; i < 400 && stable < 8 && Date.now() < deadline; i++) {
    for (const x of await page.evaluate(cfg.extract)) { const k = cfg.key(x); if (!all.has(k)) all.set(k, x); }
    if (cfg.scroll === 'wheel') { await page.mouse.move(600, 500); await page.mouse.wheel(0, 900); }
    else await page.evaluate(() => window.scrollBy(0, 900));
    await page.waitForTimeout(450);
    stable = all.size === lastSize ? stable + 1 : 0;
    lastSize = all.size;
  }
  return [...all.values()];
}

async function save(store, result, startedAt) {
  const { offers, products } = result;
  if (products?.length) {
    for (let i = 0; i < products.length; i += 500) {
      await rest('store_products?on_conflict=store,ext_key', { method: 'POST', body: products.slice(i, i + 500).map((p) => ({ ...p, seen_at: startedAt })),
        prefer: 'resolution=merge-duplicates,return=minimal' });
    }
    await rest(`store_products?store=eq.${store}&source=eq.${store}-website&seen_at=lt.${encodeURIComponent(startedAt)}`, { method: 'DELETE', prefer: 'return=minimal' });
  }
  await rest(`offers?household_id=is.null&store=eq.${store}&source=like.website*`, { method: 'DELETE', prefer: 'return=minimal' });
  for (let i = 0; i < offers.length; i += 500) {
    await rest('offers', { method: 'POST', body: offers.slice(i, i + 500).map((o) => ({ ...o, household_id: null, entered_by: null, fetched_at: startedAt })),
      prefer: 'return=minimal' });
  }
}

async function main() {
  if (!DRY && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error('SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn nodig (of gebruik --dry-run)');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !args.includes('--headed') });
  const context = await browser.newContext({ locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', viewport: { width: 1366, height: 900 } });
  // Geen afbeeldingen, video of lettertypes laden: sneller en minder belasting voor de websites
  await context.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  let failures = 0;
  for (const store of ONLY) {
    const base = STORES[store];
    if (!base) { console.warn(`Onbekende winkel: ${store}`); continue; }
    // Voor tests: OFFERS_FIXTURE_BASE=http://localhost:8000 laadt <base>/<winkel>.html in plaats van de echte website
    const cfg = process.env.OFFERS_FIXTURE_BASE ? { ...base, url: `${process.env.OFFERS_FIXTURE_BASE}/${store}.html`, settle: 300 } : base;
    const startedAt = new Date().toISOString();
    let run = null;
    if (!DRY) [run] = await rest('price_sync_runs', { method: 'POST', body: { source: `aanbiedingen:${store}` }, prefer: 'return=representation' });
    const page = await context.newPage();
    try {
      const raw = await collect(page, cfg);
      const result = cfg.normalize(raw);
      const n = result.offers.length;
      console.log(`${store}: ${raw.length} ruwe items → ${n} acties${result.products ? `, ${result.products.length} producten` : ''}`);
      if (DRY) { console.log(JSON.stringify(result.offers.slice(0, 3), null, 1)); continue; }
      if (!n) {
        // Niets gevonden: waarschijnlijk is de website veranderd of geblokkeerd. Bestaande acties laten staan (ze verlopen vanzelf).
        await rest(`price_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: { status: 'leeg', finished_at: new Date().toISOString(), rows: 0,
          message: `Geen acties gevonden (${raw.length} items op de pagina). Website mogelijk gewijzigd of geblokkeerd.` } });
        failures++;
        continue;
      }
      await save(store, result, startedAt);
      await rest(`price_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: { status: 'ok', finished_at: new Date().toISOString(), rows: n,
        per_store: { [store]: n, products: result.products?.length || 0 }, message: `${n} acties van de website` } });
    } catch (e) {
      failures++;
      console.error(`${store}: ${e.message}`);
      if (run) await rest(`price_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: { status: 'fout', finished_at: new Date().toISOString(), message: String(e.message).slice(0, 500) } }).catch(() => {});
    } finally {
      await page.close();
    }
  }
  await browser.close();
  if (failures === ONLY.length) process.exit(1); // alleen falen als niets lukte
}

main().catch((e) => { console.error(e.message); process.exit(1); });
