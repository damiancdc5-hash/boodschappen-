// Tests voor actielabels, koppelen aan producten en de omzetting per supermarkt (met echte voorbeelddata van 16-11-2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOfferLabel, matchTerms, offerMatches, costForPacks } from '../app/js/lib/offers.js';
import { normalizeAH, normalizeJumbo, normalizeLidl, normalizeAldi, normalizeDetailresult, normalizePlus, toDate, dutchDate } from '../scripts/offers/normalize.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/offers/${n}.json`, import.meta.url)));

test('actielabels herkennen', () => {
  const t = (s) => parseOfferLabel(s);
  assert.deepEqual(t('1+1 gratis'), { offer_type: '1+1', params: {} });
  assert.deepEqual(t('2+1 GRATIS'), { offer_type: '2+1', params: {} });
  assert.deepEqual(t('2+3 GRATIS'), { offer_type: 'nplusm', params: { n: 2, m: 3 } });
  assert.deepEqual(t('2e halve prijs'), { offer_type: '2e_half', params: {} });
  assert.deepEqual(t('2 voor 4.99'), { offer_type: 'multibuy', params: { n: 2, total: 4.99 } });
  assert.deepEqual(t('3 voor €5,00'), { offer_type: 'multibuy', params: { n: 3, total: 5 } });
  assert.deepEqual(t('2 stuks 17.99'), { offer_type: 'multibuy', params: { n: 2, total: 17.99 } });
  assert.deepEqual(t('voor 0.89'), { offer_type: 'fixed', params: { price: 0.89 } });
  assert.deepEqual(t('voor 2,49'), { offer_type: 'fixed', params: { price: 2.49 } });
  assert.deepEqual(t('30% korting'), { offer_type: 'percent', params: { pct: 30 } });
  assert.deepEqual(t('€1 korting'), { offer_type: 'amount_off', params: { amount: 1 } });
  assert.equal(t('Feestfavoriet'), null);
  assert.equal(t('OP=OP'), null);
});

test('nieuwe actietypes doorrekenen', () => {
  assert.equal(costForPacks(1, 5, { offer_type: 'nplusm', params: { n: 2, m: 3 } }).total, 2);
  assert.equal(costForPacks(1, 2, { offer_type: 'nplusm', params: { n: 2, m: 3 } }).packsTaken, 5);
  assert.equal(costForPacks(3, 2, { offer_type: 'amount_off', params: { amount: 1 } }).total, 4);
  assert.equal(costForPacks(3, 2, { offer_type: 'info', params: {} }).total, 6);
});

test('acties koppelen aan producten', () => {
  assert.deepEqual(matchTerms('Page Compleet Schoon, Kussenzacht of Sensitive'), ['page compleet schoon', 'page kussenzacht', 'page sensitive']);
  assert.deepEqual(matchTerms('Alle Bonduelle'), ['bonduelle']);
  const o = { store: 'ah', product_name: 'Alle Bonduelle', match_terms: ['bonduelle'] };
  assert.ok(offerMatches(o, { store: 'ah', name: 'Bonduelle Mais 3-pack' }));
  assert.ok(!offerMatches(o, { store: 'jumbo', name: 'Bonduelle Mais' }));
  assert.ok(!offerMatches(o, { store: 'ah', name: 'AH Mais' }));
  const w = { store: 'ah', product_name: 'AH Witlof', ext_id: 'wi238834', match_terms: ['zzz'] };
  assert.ok(offerMatches(w, { store: 'ah', name: 'x', link: 'https://www.ah.nl/producten/product/wi238834/ah-witlof' }));
  assert.ok(!offerMatches(w, { store: 'ah', name: 'x', link: 'https://www.ah.nl/producten/product/wi2388341/iets' }));
  const hak = normalizeAH(fx('ah')).offers.find((x) => /Hak/.test(x.product_name));
  assert.ok(offerMatches(hak, { store: 'ah', name: 'Hak Sperziebonen extra fijn' }));
  assert.ok(offerMatches(hak, { store: 'ah', name: 'Hak Witte bonen in tomatensaus' }));
});

test('datums', () => {
  assert.equal(toDate('2026-11-17T23:59:59+01:00'), '2026-11-17');
  assert.equal(toDate(1795388399), '2026-11-22');
  assert.equal(toDate('2026-11-17T23:59:00.000Z'), '2026-11-18'); // 00:59 Nederlandse tijd
  assert.equal(dutchDate('t/m 17 nov', new Date('2026-11-16')), '2026-11-17');
  assert.equal(dutchDate('5 jan', new Date('2026-12-20')), '2027-01-05');
});

test('Albert Heijn', () => {
  const { offers } = normalizeAH(fx('ah'));
  const by = (re) => offers.find((o) => re.test(o.product_name));
  assert.equal(offers.length, 9); // gratis bezorging, Feestfavoriet zonder prijs, online-only en Gall overgeslagen
  assert.equal(by(/Bonduelle/).offer_type, '1+1');
  assert.deepEqual(by(/Snoepgroente/).params, { n: 2, total: 4.99 });
  assert.equal(by(/Snoepgroente/).ext_id, 'wi471641');
  assert.equal(by(/Witlof/).regular_price, 2.29);
  assert.equal(by(/Stoofvlees/).offer_type, 'fixed');
  assert.deepEqual(by(/Omo/).params, { n: 2, total: 17.99 });
  assert.equal(by(/Bonduelle/).valid_to, '2026-11-22');
  assert.ok(!offers.some((o) => /Red Bull|Mucho|bezorging/.test(o.product_name)));
});

test('Jumbo', () => {
  const { offers } = normalizeJumbo(fx('jumbo'));
  assert.ok(!offers.some((o) => /melk/i.test(o.product_name)), 'alleen-online overgeslagen');
  assert.equal(offers.find((o) => /Verse maaltijden/.test(o.product_name)).params.pct, 25);
  assert.equal(offers.find((o) => /Kanzi/.test(o.product_name)).offer_type, 'fixed');
  assert.equal(offers.find((o) => /Lay/.test(o.product_name)).offer_type, '1+1');
  assert.equal(offers.find((o) => /Page/.test(o.product_name)).valid_to, '2026-11-17');
});

test('Lidl (incl. Lidl Plus en prijzen voor de vergelijking)', () => {
  const { offers, products } = normalizeLidl(fx('lidl'), '2026-11-16T06:00:00Z');
  assert.ok(!offers.some((o) => o.product_name === 'Conifeer'), 'planten overgeslagen');
  const mango = offers.find((o) => o.product_name === 'Mango');
  assert.equal(mango.offer_type, 'card'); assert.equal(mango.params.price, 0.99); assert.equal(mango.regular_price, 1.79);
  const olie = offers.find((o) => /Olijfolie/.test(o.product_name));
  assert.equal(olie.regular_price, 9.19); assert.equal(olie.params.price, 6.99);
  const p = products.find((x) => /Olijfolie/.test(x.name));
  assert.equal(p.price, 9.19); assert.equal(p.unit, 'ml'); assert.equal(p.unit_price, 9.19);
  assert.equal(p.link, 'https://www.lidl.nl/p/primadonna-olijfolie-extra-vierge/p11208738');
  assert.ok(offerMatches(olie, { store: 'lidl', name: p.name, link: p.link }));
});

test('Aldi', () => {
  const { offers } = normalizeAldi(fx('aldi'));
  assert.ok(!offers.some((o) => /Hummus|Verzamelfiguur/.test(o.product_name)), 'gewoon assortiment overgeslagen');
  const wijn = offers.find((o) => /Adega/.test(o.product_name));
  assert.deepEqual(wijn.params, { n: 2, total: 6 });
  const kaas = offers.find((o) => /kaasplakken/.test(o.product_name));
  assert.equal(kaas.product_name, 'Molenland Goudse kaasplakken 48+');
  assert.deepEqual(kaas.params, { price: 1.89 }); assert.equal(kaas.regular_price, 3.14);
  assert.equal(offers.find((o) => /Appels/.test(o.product_name)).link, 'https://www.aldi.nl/product/appels-1204033.html');
});

test('DekaMarkt / Dirk', () => {
  const { offers } = normalizeDetailresult('dekamarkt', fx('dekamarkt'));
  const peen = offers.find((o) => /Winterpeen/.test(o.product_name));
  assert.deepEqual(peen.params, { price: 0.99 }); assert.equal(peen.regular_price, 1.29);
  const uien = offers.filter((o) => /uien/.test(o.product_name));
  assert.equal(uien.length, 2); assert.deepEqual(uien[0].params, { n: 2, total: 1.49 });
  assert.equal(offers.find((o) => /Lay/.test(o.product_name)).offer_type, '1+1');
  assert.ok(!offers.some((o) => o.product_name === 'Zonder product'), 'geen normale prijs bekend → geen actie');
});

test('PLUS', () => {
  const { offers } = normalizePlus(fx('plus'), new Date('2026-11-16'));
  assert.ok(!offers.some((o) => o.product_name === 'Bolletje'), 'gratis bezorging overgeslagen');
  const k = offers.find((o) => /Kruidnoten/.test(o.product_name));
  assert.deepEqual(k.params, { price: 1 }); assert.equal(k.regular_price, 1.49); assert.equal(k.valid_to, '2026-11-17'); assert.equal(k.ext_id, '-288999');
  assert.deepEqual(offers.find((o) => /Courgette/.test(o.product_name)).params, { n: 2, total: 1 });
  assert.deepEqual(offers.find((o) => /Snoepgroente/.test(o.product_name)).params, { n: 3, total: 5 });
  assert.equal(offers.find((o) => /druiven/.test(o.product_name)).regular_price, 2.99);
  assert.equal(offers.find((o) => /Spruiten/.test(o.product_name)).valid_from, '2026-11-11');
});
