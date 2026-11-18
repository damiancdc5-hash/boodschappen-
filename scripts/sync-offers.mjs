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
  aldi: { url: 'https://www.aldi.nl/aanbiedingen.html', extract: X.extractAldi, normalize: N.normalizeAldi,
    assortmentUrl: 'https://www.aldi.nl/producten.html', assortmentLinks: X.aldiCategoryLinks, assortmentExtract: X.extractAldi,
    normalizeProducts: N.normalizeAldiProducts, minProducts: 300 }, // Aldi ontbreekt in de gewone prijsbron
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
  let withImages = true;
  for (let i = 0; i < offers.length; i += 500) {
    const batch = offers.slice(i, i + 500).map((o) => ({ ...o, household_id: null, entered_by: null, fetched_at: startedAt }));
    try {
      await rest('offers', { method: 'POST', body: withImages ? batch : batch.map(({ image_url, ...o }) => o), prefer: 'return=minimal' });
    } catch (e) {
      // database nog zonder kolom image_url (003_invite_only.sql niet uitgevoerd): zonder foto's opslaan
      if (withImages && /image_url/.test(e.message)) { withImages = false; i -= 500; continue; }
      throw e;
    }
  }
}

async function main() {
  if (!DRY && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error('SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn nodig (of gebruik --dry-run)');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !args.includes('--headed'), args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5' } });
  // Geen afbeeldingen, video of lettertypes laden: sneller en minder belasting voor de websites
  await context.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  let failures = 0;
  const summary = ['| Winkel | Acties | Producten | Resultaat |', '|---|---:|---:|---|'];
  for (const store of ONLY) {
    const base = STORES[store];
    if (!base) { console.warn(`Onbekende winkel: ${store}`); continue; }
    // Voor tests: OFFERS_FIXTURE_BASE=http://localhost:8000 laadt <base>/<winkel>.html in plaats van de echte website
    const cfg = process.env.OFFERS_FIXTURE_BASE ? { ...base, url: `${process.env.OFFERS_FIXTURE_BASE}/${store}.html`, settle: 300 } : base;
    const startedAt = new Date().toISOString();
    let run = null, assortmentNote = '';
    if (!DRY) [run] = await rest('price_sync_runs', { method: 'POST', body: { source: `aanbiedingen:${store}` }, prefer: 'return=representation' });
    const page = await context.newPage();
    try {
      const raw = await collect(page, cfg);
      const result = cfg.normalize(raw);
      if (cfg.assortmentUrl) {
        // volledig assortiment met prijzen, voor de prijsvergelijking: elke categoriepagina gewoon openen
        const all = new Map();
        let pages = 0, failed = 0;
        try {
          const home = process.env.OFFERS_FIXTURE_BASE ? `${process.env.OFFERS_FIXTURE_BASE}/producten.html` : cfg.assortmentUrl;
          const first = await page.goto(home, { waitUntil: 'load', timeout: 60000 });
          await page.waitForSelector('a[href*="/producten/"]', { timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(3000);
          const links = await page.evaluate(cfg.assortmentLinks);
          console.log(`::notice title=Aldi assortiment::status ${first?.status()}, titel "${await page.title()}", ${links.length} categorielinks`);
          for (const link of links) {
            const url = process.env.OFFERS_FIXTURE_BASE ? `${process.env.OFFERS_FIXTURE_BASE}/${link.split('/').pop()}` : link;
            try {
              const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
              if (r && r.status() >= 400) { failed++; continue; }
              for (const p of await page.evaluate(cfg.assortmentExtract)) if (!all.has(p.id)) all.set(p.id, p);
              pages++;
            } catch { failed++; }
            await page.waitForTimeout(300);
          }
        } catch (e) { console.warn(`${store}: assortiment mislukt: ${e.message}`); }
        const products = cfg.normalizeProducts([...all.values()]);
        assortmentNote = `assortiment: ${products.length} producten uit ${pages} pagina's${failed ? `, ${failed} mislukt` : ''}`;
        if (products.length >= Number(process.env.OFFERS_MIN_PRODUCTS || cfg.minProducts || 1)) result.products = [...(result.products || []), ...products];
        else assortmentNote += ' — te weinig, prijzen niet bijgewerkt';
      }
      const n = result.offers.length;
      console.log(`${store}: ${raw.length} ruwe items → ${n} acties${result.products ? `, ${result.products.length} producten` : ''}`);
      summary.push(`| ${store} | ${n} | ${result.products?.length ?? '–'} | ${n ? 'ok' : 'niets gevonden'} (${raw.length} items op de pagina)${assortmentNote ? '; ' + assortmentNote : ''} |`);
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
      summary.push(`| ${store} | – | – | mislukt: ${String(e.message).replace(/\|/g, '/').slice(0, 120)} |`);
      if (run) await rest(`price_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: { status: 'fout', finished_at: new Date().toISOString(), message: String(e.message).slice(0, 500) } }).catch(() => {});
    } finally {
      await page.close();
    }
  }
  await browser.close();
  // overzicht op de openbare pagina van deze run (GitHub → Actions → run)
  if (process.env.GITHUB_ACTIONS) {
    // ook als melding (zichtbaar op de openbare run-pagina, zonder in te loggen)
    console.log(`::notice title=Aanbiedingen per winkel::${summary.slice(2).map((l) => l.replace(/^\| | \|$/g, '').replace(/ \| /g, ' · ')).join(' ‖ ')}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Aanbiedingen per winkel\n\n${summary.join('\n')}\n`);
  }
  if (failures === ONLY.length) process.exit(1); // alleen falen als niets lukte
}

main().catch((e) => { console.error(e.message); process.exit(1); });
