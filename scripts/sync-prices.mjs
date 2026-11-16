#!/usr/bin/env node
// Prijssync: laadt de open prijsdataset van Checkjebon.nl (github.com/supermarkt/checkjebon) in Supabase.
// Draait dagelijks via GitHub Actions (.github/workflows/sync-prices.yml). Geen externe pakketten nodig (Node 20+).
//
//   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/sync-prices.mjs
//   node scripts/sync-prices.mjs --file data.json --dry-run      (lokaal testen)

import { readFileSync } from 'node:fs';
import { parseSize, unitPrice } from '../app/js/lib/units.js';

const DATA_URL = 'https://raw.githubusercontent.com/supermarkt/checkjebon/main/data/supermarkets.json';
const COMMITS_URL = 'https://api.github.com/repos/supermarkt/checkjebon/commits?path=data/supermarkets.json&per_page=1';

// Codes in de dataset → codes in de app. Onbekende ketens worden overgeslagen.
const STORE_ALIASES = {
  ah: 'ah', albertheijn: 'ah', jumbo: 'jumbo', lidl: 'lidl', aldi: 'aldi', plus: 'plus', dirk: 'dirk',
  dirkvandenbroek: 'dirk', vomar: 'vomar', hoogvliet: 'hoogvliet', dekamarkt: 'dekamarkt', deka: 'dekamarkt',
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return null; };

/** Zet de ruwe dataset om naar rijen voor store_products. Verdraagt korte (n,d,p,s,l) en lange veldnamen. */
export function parseDataset(raw, checkedAt) {
  const list = Array.isArray(raw) ? raw : raw?.supermarkets || Object.entries(raw || {}).map(([k, v]) => ({ n: k, ...(Array.isArray(v) ? { d: v } : v) }));
  const rows = [], perStore = {}, skipped = new Set();
  for (const s of list) {
    const codeRaw = pick(s, 'n', 'code', 'c', 'name', 'id');
    const code = STORE_ALIASES[norm(codeRaw)];
    if (!code) { skipped.add(String(codeRaw)); continue; }
    const base = pick(s, 'u', 'url');
    const products = pick(s, 'd', 'products', 'p') || [];
    const seen = new Set();
    for (const p of products) {
      const name = String(pick(p, 'n', 'name', 'title') || '').trim();
      const price = Number(pick(p, 'p', 'price'));
      if (!name || !isFinite(price) || price <= 0 || price > 1000) continue;
      const sizeText = pick(p, 's', 'size', 'amount', 'unit');
      let link = pick(p, 'l', 'link', 'url');
      if (link && !/^https?:\/\//.test(link) && base) link = String(base).replace(/\/$/, '') + '/' + String(link).replace(/^\//, '');
      const size = parseSize(sizeText);
      const extKey = (link || name + '|' + (sizeText || '')).slice(0, 500);
      if (seen.has(extKey)) continue;
      seen.add(extKey);
      rows.push({
        store: code, name: name.slice(0, 300), link, price: Math.round(price * 100) / 100, size_text: sizeText ? String(sizeText).slice(0, 60) : null,
        amount: size?.amount ?? null, unit: size?.unit ?? null, unit_price: size ? unitPrice(price, size) : null,
        source: 'checkjebon', checked_at: checkedAt, ext_key: extKey,
      });
      perStore[code] = (perStore[code] || 0) + 1;
    }
  }
  return { rows, perStore, skipped: [...skipped] };
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(url, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) } });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const fileIdx = args.indexOf('--file');
  let raw, checkedAt;
  if (fileIdx >= 0) { raw = JSON.parse(readFileSync(args[fileIdx + 1], 'utf8')); checkedAt = new Date().toISOString(); }
  else {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('Dataset downloaden mislukt: ' + res.status);
    raw = await res.json();
    // Moment waarop de bron de prijzen het laatst heeft bijgewerkt
    try {
      const c = await (await fetch(COMMITS_URL, { headers: { 'User-Agent': 'boodschappenassistent' } })).json();
      checkedAt = c?.[0]?.commit?.committer?.date || null;
    } catch { checkedAt = null; }
    checkedAt ||= res.headers.get('last-modified') ? new Date(res.headers.get('last-modified')).toISOString() : new Date().toISOString();
  }
  const { rows, perStore, skipped } = parseDataset(raw, checkedAt);
  console.log(`Prijzen bijgewerkt door bron op ${checkedAt}`);
  console.log('Producten per winkel:', perStore, skipped.length ? `(overgeslagen ketens: ${skipped.join(', ')})` : '');
  if (dry) { console.log(JSON.stringify(rows.slice(0, 3), null, 2)); return; }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn nodig');
  if (rows.length < 1000) throw new Error(`Verdacht weinig producten (${rows.length}); sync afgebroken om de bestaande data te beschermen.`);

  const [run] = await rest('price_sync_runs', { method: 'POST', body: { source: 'checkjebon' }, prefer: 'return=representation' });
  const startedAt = new Date().toISOString();
  try {
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000).map((r) => ({ ...r, seen_at: startedAt }));
      await rest('store_products?on_conflict=store,ext_key', { method: 'POST', body: batch, prefer: 'resolution=merge-duplicates,return=minimal' });
      process.stdout.write(`\r${Math.min(i + 1000, rows.length)}/${rows.length}`);
    }
    console.log();
    // Producten die niet meer in de bron staan verwijderen (alleen voor ketens die in deze run zaten)
    for (const store of Object.keys(perStore)) {
      await rest(`store_products?store=eq.${store}&source=eq.checkjebon&seen_at=lt.${encodeURIComponent(startedAt)}`, { method: 'DELETE', prefer: 'return=minimal' });
    }
    await rest(`price_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: { status: 'ok', finished_at: new Date().toISOString(), rows: rows.length, per_store: perStore,
      message: `bron bijgewerkt ${checkedAt.slice(0, 10)}` } });
    console.log('Klaar.');
  } catch (e) {
    await rest(`price_sync_runs?id=eq.${run.id}`, { method: 'PATCH', body: { status: 'fout', finished_at: new Date().toISOString(), message: String(e.message).slice(0, 500) } }).catch(() => {});
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
