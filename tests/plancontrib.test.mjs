// Tests: boodschappen per dag van het weekmenu bijhouden en weer van de lijst halen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planContributions, mergePlanIntoList, removalOps, fallbackContrib } from '../app/js/lib/plancontrib.js';

const R = (ings) => ({ servings: 2, ingredients: ings.map(([name, quantity, unit]) => ({ name, quantity, unit })) });
const pasta = R([['spaghetti', 250, 'g'], ['tomatenblokjes', 1, 'st'], ['ui', 1, 'st']]);
const pesto = R([['spaghetti', 250, 'g'], ['pesto', 1, 'st']]);

test('per dag, voorraad op volgorde verbruikt', () => {
  const per = planContributions([{ id: 'ma', recipe: pasta, servings: 2 }, { id: 'wo', recipe: pesto, servings: 4 }], [{ name: 'spaghetti', quantity: 300, unit: 'g' }]);
  assert.deepEqual(per[0].items.map((i) => [i.key, i.quantity]), [['tomatenblokje', 1], ['ui', 1]]); // spaghetti uit voorraad
  assert.deepEqual(per[1].items.map((i) => [i.key, i.quantity]), [['spaghetti', 450], ['pesto', 2]]); // 500 nodig, 50 nog in voorraad
});

test('samenvoegen met bestaande lijst en weer weghalen', () => {
  const per = planContributions([{ id: 'ma', recipe: pasta, servings: 2 }, { id: 'wo', recipe: pesto, servings: 2 }], []);
  const existing = [{ id: 'a', name: 'Spaghetti', quantity: 500, unit: 'g', checked: false }, { id: 'b', name: 'melk', quantity: 1, unit: 'st' }];
  const m = mergePlanIntoList(existing, per);
  assert.deepEqual(m.updates, [{ id: 'a', quantity: 1000, unit: 'g' }]);
  assert.equal(m.inserts.length, 3);
  assert.equal(m.contribs.wo.find((c) => c.ref === 'a').quantity, 250);
  // na opslaan: tmp-refs vervangen door echte id's
  const ids = Object.fromEntries(m.inserts.map((x, i) => [x.tmp, 'n' + i]));
  const list = [{ id: 'a', name: 'Spaghetti', quantity: 1000, unit: 'g' }, ...m.inserts.map((x, i) => ({ id: 'n' + i, name: x.name, quantity: x.quantity, unit: x.unit }))];
  const wo = m.contribs.wo.map((c) => ({ ...c, ref: ids[c.ref] || c.ref }));
  const ops = removalOps(list, wo);
  assert.deepEqual(ops.updates, [{ id: 'a', quantity: 750 }]); // eigen 500 g + maandag blijft staan
  assert.equal(ops.deletes.length, 1); // pesto weg
  // al afgevinkt? dan blijft het staan
  const ops2 = removalOps(list.map((i) => (i.name === 'pesto' ? { ...i, checked: true } : i)), wo);
  assert.equal(ops2.deletes.length, 0); assert.equal(ops2.kept, 1);
});

test('oude weekmenu\'s: terugvallen op regels met bron weekmenu', () => {
  const per = planContributions([{ id: 'wo', recipe: pesto, servings: 2 }], [])[0].items;
  const list = [{ id: 'x', name: 'spaghetti', quantity: 500, unit: 'g', source: 'weekmenu' }, { id: 'y', name: 'pesto', quantity: 1, unit: 'st', source: null }];
  const c = fallbackContrib(list, per);
  assert.deepEqual(c, [{ ref: 'x', quantity: 250, unit: 'g' }]);
});
