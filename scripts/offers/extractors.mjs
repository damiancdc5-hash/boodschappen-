// Uitleesfuncties die IN de webpagina van de supermarkt draaien (via Playwright page.evaluate).
// Ze moeten volledig op zichzelf staan: geen imports, geen variabelen van buitenaf.
// Ze geven ruwe gegevens terug; normalize.mjs zet die om naar acties.

/** Albert Heijn (/bonus): de pagina bevat de bonusgegevens als JSON in self.__next_f. */
export function extractAH() {
  // De inline <script>self.__next_f.push([1,"…"])</script>-blokken blijven in de pagina staan.
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const sc of document.querySelectorAll('script:not([src])')) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(sc.textContent))) { try { parts.push(JSON.parse(m[1])); } catch { /* */ } }
  }
  const s = parts.join('');
  const out = [], ids = new Set();
  const marker = '"__typename":"Promotion"';
  let i = 0;
  while ((i = s.indexOf(marker, i)) >= 0) {
    const st = s.lastIndexOf('{', i);
    let d = 0, j = st;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '"') { j++; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; } continue; }
      if (c === '{') d++; else if (c === '}') { d--; if (!d) break; }
    }
    try {
      const p = JSON.parse(s.slice(st, j + 1));
      if (p.id && !ids.has(p.id)) {
        ids.add(p.id);
        const pr = p.product;
        out.push({
          id: p.id, title: p.title, subtitle: p.subtitle, category: p.category, storeOnly: p.storeOnly, segmentType: p.segmentType,
          start: p.periodStart, end: p.periodEnd, webPath: p.webPath, productCount: p.productCount, salesUnitSize: p.salesUnitSize,
          labels: (p.promotionLabels || []).map((l) => [l.topText, l.centerText, l.bottomText].filter(Boolean).join(' ')),
          product: pr ? { id: pr.id, title: pr.title, size: pr.salesUnitSize, webPath: pr.webPath,
            now: pr.priceV2?.now?.amount ?? null, was: pr.priceV2?.was?.amount ?? null, discount: pr.priceV2?.discount?.description || null } : null,
        });
      }
    } catch { /* onvolledig object overslaan */ }
    i = j;
  }
  return out;
}

/** Jumbo (/aanbiedingen/nu): actiekaarten in de pagina (na scrollen). */
export function extractJumbo() {
  return [...document.querySelectorAll('article.card-promotion')].map((a) => ({
    id: a.getAttribute('id'),
    start: a.getAttribute('start-date'), end: a.getAttribute('expiration-date'), group: a.getAttribute('group'),
    title: a.querySelector('.title-link, h3')?.textContent.trim() || '',
    href: a.querySelector('a.title-link')?.getAttribute('href') || null,
    subtitle: a.querySelector('.subtitle')?.textContent.trim() || '',
    tags: [...a.querySelectorAll('[data-testid="jum-tag"]')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
  })).filter((x) => x.title);
}

/** Lidl (/c/aanbiedingen/…): de server-HTML bevat per product een data-grid-data JSON met prijzen en Lidl Plus-prijs. */
export async function extractLidl() {
  const html = await (await fetch(location.href, { credentials: 'omit' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('[data-grid-data]')].map((e) => {
    try {
      const d = JSON.parse(e.getAttribute('data-grid-data'));
      const plus = (d.lidlPlus || [])[0];
      return { id: String(d.productId || d.itemId || ''), title: d.fullTitle || d.title, category: d.category,
        price: d.price?.price ?? null, oldPrice: d.price?.oldPrice ?? null, packaging: d.price?.packaging?.text || null,
        plusPrice: plus?.price?.price ?? null, plusText: plus?.highlightText || null,
        start: d.storeStartDate || null, end: d.storeEndDate || null, url: d.canonicalUrl || d.canonicalPath || null };
    } catch { return null; }
  }).filter((x) => x && x.id && x.title && x.price != null);
}

/** Aldi (/aanbiedingen.html): productgegevens zitten als JSON-tekst in __NEXT_DATA__. */
export function extractAldi() {
  const el = document.getElementById('__NEXT_DATA__');
  if (!el) return [];
  const out = new Map(), seen = new Set();
  const walk = (o, depth) => {
    if (depth > 40 || o == null) return;
    if (typeof o === 'string') {
      const t = o.trim();
      if ((t[0] === '{' || t[0] === '[') && t.includes('currentPrice')) { try { walk(JSON.parse(t), depth + 1); } catch { /* */ } }
      return;
    }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && o.name && o.currentPrice && typeof o.currentPrice === 'object') {
      const id = o.objectID || o.productSlug || o.name;
      if (!out.has(id)) out.set(id, { id, name: o.name, brand: o.brandName || o.brand || null, salesUnit: o.salesUnit || null, slug: o.productSlug || null,
        price: o.currentPrice.priceValue ?? null, strike: o.currentPrice.strikePrice?.strikePriceValue ?? null,
        label: o.currentPrice.priceTagLabels?.promoText1 || null, label2: o.currentPrice.priceTagLabels?.promoText2 || null,
        from: o.promotionPrices?.[0]?.validFromLocalDate || null, to: o.promotionPrices?.[0]?.validUntilLocalDate || null,
        validFrom: o.currentPrice.validFrom || null, validUntil: o.currentPrice.validUntil || null, category: o.mainCategoryID || null });
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(JSON.parse(el.textContent), 0);
  return [...out.values()];
}

/** Dirk en DekaMarkt (/aanbiedingen): Nuxt-gegevens met offerId, offerPrice, normalPrice en producten. */
export function extractDetailresult() {
  const el = document.getElementById('__NUXT_DATA__');
  if (!el) return [];
  const raw = JSON.parse(el.textContent);
  const memo = new Map();
  const WRAP = ['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'Date', 'Set', 'Map', 'EmptyRef', 'EmptyShallowRef'];
  const h = (i) => {
    if (typeof i !== 'number') return i;
    if (memo.has(i)) return memo.get(i);
    const v = raw[i];
    let out;
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && WRAP.includes(v[0])) out = v.length > 1 ? h(v[1]) : null;
      else { out = []; memo.set(i, out); v.forEach((x) => out.push(h(x))); }
    } else if (v && typeof v === 'object') { out = {}; memo.set(i, out); for (const [k, x] of Object.entries(v)) out[k] = h(x); }
    else out = v;
    memo.set(i, out);
    return out;
  };
  const res = [];
  raw.forEach((v, i) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'offerId' in v && 'offerPrice' in v) {
      const o = h(i);
      res.push({ offerId: o.offerId, headerText: o.headerText, packaging: o.packaging, offerPrice: o.offerPrice, normalPrice: o.normalPrice,
        sign: o.textPriceSign, subText: o.subText || null, start: o.startDate, end: o.endDate,
        products: (o.products || []).filter((p) => p && p.productInformation).map((p) => ({ id: p.productId, offerPrice: p.offerPrice, normalPrice: p.normalPrice,
          name: p.productInformation?.headerText, packaging: p.productInformation?.packaging, brand: p.productInformation?.brand })) });
    }
  });
  const ids = new Set();
  return res.filter((r) => !ids.has(r.offerId) && ids.add(r.offerId));
}

/** PLUS (/aanbiedingen): producttegels; de pagina laadt in delen, de sync scrolt eerst. */
export function extractPlus() {
  const header = (document.body.innerText.match(/(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\s+\d{1,2}\s+\w+\s+t\/m\s+\w+\s+\d{1,2}\s+\w+/i) || [])[0] || null;
  const out = [], ids = new Set();
  for (const e of document.querySelectorAll('.plp-item-wrapper')) {
    const id = (e.className.match(/item__(\d+)/) || [])[1];
    const name = e.querySelector('.plp-item-name')?.textContent.replace(/\s+/g, ' ').trim();
    const href = e.closest('a')?.getAttribute('href') || e.querySelector('a')?.getAttribute('href') || null;
    const key = (href || '') + '|' + name;
    if (!name || ids.has(key)) continue; // let op: item__-nummers zijn niet uniek
    ids.add(key);
    const int = e.querySelector('.product-header-price-integer')?.textContent.replace(/[^\d]/g, '');
    const dec = e.querySelector('.product-header-price-decimals')?.textContent.replace(/[^\d]/g, '');
    out.push({ id, name, header,
      complementary: e.querySelector('.plp-item-complementary')?.innerText.replace(/\s+/g, ' ').trim() || '',
      label: e.querySelector('.promo-offer-label, [class*="promo-offer"]')?.textContent.replace(/\s+/g, ' ').trim() || '',
      price: int ? parseFloat(int + '.' + (dec || '00')) : null,
      previous: e.querySelector('.product-header-price-previous')?.textContent.replace(/\s+/g, ' ').trim() || '',
      href,
      text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  return out;
}
