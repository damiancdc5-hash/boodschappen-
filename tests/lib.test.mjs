// Unit tests voor de rekenlogica. Draaien: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, toBase, unitPrice, parseNumber, euro } from '../app/js/lib/units.js';
import { parseIngredientLine, parseRecipeText, scaleIngredients, mergeItems, subtractPantry, nameKey, guessCategory } from '../app/js/lib/ingredients.js';
import { costForPacks } from '../app/js/lib/offers.js';
import { computeScenarios, packsNeeded } from '../app/js/lib/optimizer.js';
import { buildMenu } from '../app/js/lib/menu.js';
import { extractJsonLd, recipeFromJsonLd } from '../app/js/lib/recipes.js';
import { bestRoute, nearestPerChain } from '../app/js/lib/geo.js';

test('getallen en verpakkingen', () => {
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber('1½'), 1.5);
  assert.equal(parseNumber('1/2'), 0.5);
  assert.equal(parseNumber('2-3'), 3);
  assert.deepEqual(parseSize('1 l'), { amount: 1000, unit: 'ml' });
  assert.deepEqual(parseSize('6 x 330 ml'), { amount: 1980, unit: 'ml' });
  assert.deepEqual(parseSize('1,5 kg'), { amount: 1500, unit: 'g' });
  assert.deepEqual(parseSize('per stuk'), { amount: 1, unit: 'st' });
  assert.deepEqual(parseSize('10 stuks'), { amount: 10, unit: 'st' });
  assert.deepEqual(parseSize('ca. 400 g'), { amount: 400, unit: 'g' });
  assert.equal(unitPrice(1.79, { amount: 1500, unit: 'ml' }), 1.1933);
  assert.deepEqual(toBase(2, 'el'), { amount: 30, unit: 'ml' });
  assert.match(euro(3.5), /3,50/);
});

test('ingrediëntregels herkennen', () => {
  assert.deepEqual(pick(parseIngredientLine('200 g gehakt')), { quantity: 200, unit: 'g', name: 'gehakt' });
  assert.deepEqual(pick(parseIngredientLine('2 teentjes knoflook, fijngesneden')), { quantity: 2, unit: 'st', name: 'knoflook' });
  assert.deepEqual(pick(parseIngredientLine('1 ui')), { quantity: 1, unit: 'st', name: 'ui' });
  assert.deepEqual(pick(parseIngredientLine('½ liter melk')), { quantity: 0.5, unit: 'l', name: 'melk' });
  assert.deepEqual(pick(parseIngredientLine('3 eieren')), { quantity: 3, unit: 'st', name: 'eieren' });
  assert.deepEqual(pick(parseIngredientLine('2 el olijfolie')), { quantity: 2, unit: 'el', name: 'olijfolie' });
  assert.deepEqual(pick(parseIngredientLine('peper en zout')), { quantity: null, unit: null, name: 'peper en zout' });
  assert.equal(parseIngredientLine('snufje zout (optioneel)').optional, true);
});

test('recepttekst', () => {
  const r = parseRecipeText(`Pasta bolognese
Voor 4 personen
Ingrediënten
400 g spaghetti
500 g rundergehakt
1 ui
2 teentjes knoflook
1 blik tomatenblokjes
Bereiding
Kook de pasta. Bak het gehakt rul.`);
  assert.equal(r.title, 'Pasta bolognese');
  assert.equal(r.servings, 4);
  assert.equal(r.ingredients.length, 5);
  assert.equal(r.ingredients[4].name, 'tomatenblokjes');
  assert.match(r.instructions, /Kook de pasta/);
  const s = scaleIngredients(r.ingredients, 4, 2);
  assert.equal(s[0].quantity, 200);
  assert.equal(s[2].quantity, 0.5);
});

test('ontdubbelen en voorraad', () => {
  assert.equal(nameKey('Uien'), 'ui');
  assert.equal(nameKey('tomaten'), 'tomaat');
  assert.equal(nameKey('champignons'), 'champignon');
  const { merged, updates, additions } = mergeItems(
    [{ id: 'a', name: 'gehakt', quantity: 500, unit: 'g' }, { id: 'b', name: 'ui', quantity: 1, unit: 'st' }],
    [{ name: 'Gehakt', quantity: 0.3, unit: 'kg' }, { name: 'uien', quantity: 2, unit: 'st' }, { name: 'rijst', quantity: 400, unit: 'g' }],
  );
  assert.equal(merged.length, 3);
  assert.deepEqual(updates.map((u) => [u.id, u.quantity]), [['a', 800], ['b', 3]]);
  assert.equal(additions.length, 1);
  const need = subtractPantry([{ name: 'rijst', quantity: 400, unit: 'g' }, { name: 'ei', quantity: 3, unit: 'st' }],
    [{ name: 'rijst', quantity: 1, unit: 'kg' }, { name: 'eieren', quantity: 2, unit: 'st' }]);
  assert.equal(need[0].toBuy, 0);
  assert.equal(need[1].toBuy, 1);
  assert.equal(guessCategory('halfvolle melk'), 'Zuivel & eieren');
  assert.equal(guessCategory('rode paprika'), 'Groente & fruit');
});

test('acties', () => {
  assert.equal(costForPacks(2, 2, { offer_type: '1+1' }).total, 2);
  assert.equal(costForPacks(2, 1, { offer_type: '1+1' }).packsTaken, 2);
  assert.equal(costForPacks(2, 2, { offer_type: '2e_half' }).total, 3);
  assert.equal(costForPacks(1.5, 3, { offer_type: 'multibuy', params: { n: 3, total: 3 } }).total, 3);
  assert.equal(costForPacks(1.5, 2, { offer_type: 'multibuy', params: { n: 3, total: 2.5 } }).total, 2.5); // aanvullen tot set
  assert.equal(costForPacks(2, 3, { offer_type: '2+1' }).total, 4);
  assert.equal(costForPacks(4, 1, { offer_type: 'percent', params: { pct: 25 } }).total, 3);
  assert.equal(costForPacks(4, 1, { offer_type: 'card', params: { price: 3 } }, { useCard: false }).total, 4);
});

test('winkelscenario\'s', () => {
  const items = [
    { id: 'm', name: 'melk', quantity: 2, unit: 'st' },
    { id: 'k', name: 'kaas', quantity: 500, unit: 'g' },
    { id: 'p', name: 'pindakaas', quantity: 1, unit: 'st' },
  ];
  const c = (store, price, amount, unit, extra = {}) => ({ id: store + price, store, price, amount, unit, ...extra });
  const cand = {
    m: [c('ah', 1.29, 1000, 'ml'), c('dirk', 1.09, 1000, 'ml'), c('jumbo', 1.25, 1000, 'ml')],
    k: [c('ah', 6.0, 500, 'g'), c('dirk', 4.5, 500, 'g'), c('jumbo', 5.0, 500, 'g', { offer: { offer_type: '1+1' } })],
    p: [c('ah', 3.0, 350, 'g'), c('jumbo', 2.2, 600, 'g')],
  };
  assert.equal(packsNeeded(items[0], cand.m[0]).packs, 2);
  const home = { lat: 52.37, lng: 4.89 };
  const r = computeScenarios(items, cand, {
    stores: ['ah', 'jumbo', 'dirk', 'lidl'], maxStores: 3, home, mode: 'car', costPerKm: 0.23, timeValue: 0,
    locations: { ah: { lat: 52.371, lng: 4.891 }, jumbo: { lat: 52.375, lng: 4.9 }, dirk: { lat: 52.40, lng: 4.95 } },
  });
  assert.deepEqual(r.available.sort(), ['ah', 'dirk', 'jumbo']);
  // Eén winkel: jumbo heeft alles en is goedkoopst van de complete winkels
  assert.equal(r.single[0].store, 'jumbo');
  assert.equal(r.single[0].total, 9.7);
  // Goedkoopste combinatie: melk bij dirk, kaas (1+1, 1 nodig → 5) bij jumbo vs 4.5 dirk → dirk; pindakaas jumbo
  assert.equal(r.cheapest.total, 8.88);
  assert.deepEqual(r.cheapest.stores.sort(), ['dirk', 'jumbo']);
  // Balans: dirk ligt verder weg; extra winkel kost €1,50 + reiskosten → alleen jumbo
  assert.deepEqual(r.balanced.stores, ['jumbo']);
  assert.ok(r.balanced.travel.km > 0);
  assert.equal(r.unpriced.length, 0);
});

test('weekmenu deelt ingrediënten en blijft binnen voorraad', () => {
  const R = (id, title, ings, tags = []) => ({ id, title, servings: 2, tags, ingredients: ings.map(([name, quantity, unit]) => ({ name, quantity, unit })) });
  const recipes = [
    R('a', 'Pasta tomaat', [['spaghetti', 250, 'g'], ['tomatenblokjes', 1, 'st']], ['vegetarisch']),
    R('b', 'Pasta pesto', [['spaghetti', 250, 'g'], ['pesto', 1, 'st']], ['vegetarisch']),
    R('c', 'Biefstuk', [['biefstuk', 300, 'g'], ['aardappel', 600, 'g']]),
    R('d', 'Rijst kip', [['rijst', 250, 'g'], ['kipfilet', 300, 'g']]),
  ];
  const P = (price, amount, unit) => ({ price, amount, unit, store: 'ah' });
  const priceIndex = new Map([
    ['spaghetti', P(1.0, 500, 'g')], ['tomatenblokjes', P(0.6, 1, 'st')], ['pesto', P(1.8, 1, 'st')],
    ['biefstuk', P(9, 300, 'g')], ['aardappel', P(2, 1500, 'g')], ['rijst', P(1.5, 1000, 'g')], ['kipfilet', P(4.5, 300, 'g')],
  ].map(([k, v]) => [nameKey(k), v]));
  const m = buildMenu({ recipes, persons: 2, days: 2, priceIndex, pantry: [] });
  assert.deepEqual(m.entries.map((e) => e.recipe.id).sort(), ['a', 'b']);
  assert.equal(m.total, 3.4);
  assert.equal(m.sharedIngredients, 1);
  const veg = buildMenu({ recipes, persons: 2, days: 2, priceIndex, preferences: ['geen spaghetti'] });
  assert.ok(!veg.entries.some((e) => ['a', 'b'].includes(e.recipe.id)));
  const withPantry = buildMenu({ recipes, persons: 2, days: 2, priceIndex, pantry: [{ name: 'spaghetti', quantity: 1, unit: 'kg' }] });
  assert.equal(withPantry.total, 2.4);
});

test('recept uit JSON-LD', () => {
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
  {"@type":"Recipe","name":"Stamppot boerenkool","recipeYield":"4 personen","recipeIngredient":["1 kg kruimige aardappelen","500 g boerenkool","1 rookworst"],
  "recipeInstructions":[{"@type":"HowToStep","text":"Kook de aardappelen."},{"@type":"HowToStep","text":"Stamp alles."}],"image":["https://x/img.jpg"],"keywords":"winter, hollands"}]}</script></html>`;
  const r = recipeFromJsonLd(extractJsonLd(html), 'https://x');
  assert.equal(r.title, 'Stamppot boerenkool');
  assert.equal(r.servings, 4);
  assert.equal(r.ingredients.length, 3);
  assert.equal(r.ingredients[0].quantity, 1);
  assert.equal(r.ingredients[0].unit, 'kg');
  assert.match(r.instructions, /Stamp alles/);
  assert.ok(r.tags.includes('winter'));
});

test('route en dichtstbijzijnde vestiging', () => {
  const home = { lat: 52, lng: 5 };
  const r = bestRoute(home, [{ lat: 52.1, lng: 5 }, { lat: 52.05, lng: 5 }]);
  assert.ok(Math.abs(r.km - 22.24) < 0.1);
  const n = nearestPerChain(home, [
    { lat: 52.2, lon: 5, tags: { brand: 'Albert Heijn', name: 'Albert Heijn' } },
    { lat: 52.01, lon: 5, tags: { brand: 'Albert Heijn', name: 'AH Dorp' } },
    { center: { lat: 52.02, lon: 5 }, tags: { name: 'Lidl' } },
    { lat: 52.02, lon: 5, tags: { name: 'Bakker Bart' } },
  ]);
  assert.equal(n.ah.name, 'AH Dorp');
  assert.ok(n.lidl);
  assert.equal(Object.keys(n).length, 2);
});

function pick(o) { return { quantity: o.quantity, unit: o.unit, name: o.name }; }
