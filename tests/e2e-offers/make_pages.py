"""Maakt nagebootste aanbiedingenpagina's (zelfde opbouw als de echte websites op 16-11-2026) voor de pipeline-test."""
import json, pathlib, html
ROOT = pathlib.Path(__file__).resolve().parent
FX = ROOT.parent / 'fixtures' / 'offers'
OUT = ROOT / 'pages'; OUT.mkdir(exist_ok=True)
load = lambda n: json.loads((FX / f'{n}.json').read_text())

# --- AH: Next.js flight-data in inline scripts
promos = []
for p in load('ah'):
    lab = p['labels'][0] if p['labels'] else ''
    parts = lab.split(' ', 1)
    promos.append({"__typename": "Promotion", "id": p['id'], "title": p['title'], "subtitle": None, "category": p['category'], "storeOnly": False,
        "productCount": p['productCount'], "salesUnitSize": "", "webPath": p['webPath'], "promotionType": "NATIONAL", "segmentType": p['segmentType'],
        "periodStart": p['start'], "periodEnd": p['end'],
        "promotionLabels": [{"__typename": "PantryPromotionLabel", "topText": l.split(' ', 1)[0], "centerText": None, "bottomText": (l.split(' ', 1) + [''])[1] or None} for l in p['labels']],
        "product": None if not p['product'] else {"__typename": "Product", "id": p['product']['id'], "title": p['product']['title'], "salesUnitSize": p['product']['size'],
            "webPath": p['product']['webPath'], "priceV2": {"__typename": "ProductPriceV2", "now": {"amount": p['product']['now']}, "was": {"amount": p['product']['was']},
            "discount": {"__typename": "ProductPriceDiscountV2", "description": p['product']['discount']}}}})
flight = '5:["$","div",null,{"promotions":' + json.dumps(promos, separators=(",", ":")) + '}]\n'
half = len(flight) // 2
pushes = ''.join(f'<script>self.__next_f.push([1,{json.dumps(chunk)}])</script>' for chunk in (flight[:half], flight[half:]))
(OUT / 'ah.html').write_text(f'<!doctype html><html><body><h1>Bonus</h1><script>(self.__next_f=self.__next_f||[]).push([0])</script>{pushes}</body></html>')

# --- Jumbo: actiekaarten die bij scrollen bijladen
arts = []
for p in load('jumbo'):
    tags = ''.join(f'<span class="jum-tag" data-testid="jum-tag">{html.escape(t)}</span>' for t in p['tags'])
    arts.append(f'<article class="jum-card card-promotion" id="{p["id"]}" group="{p["group"]}" start-date="{p["start"]}" expiration-date="{p["end"]}"><div class="tag">{tags}</div>'
                f'<h3><a class="title-link" href="{p["href"]}">{html.escape(p["title"])}</a></h3><p class="subtitle">{p["subtitle"]}</p></article>')
(OUT / 'jumbo.html').write_text('<!doctype html><html><body><main id="m">' + ''.join(arts[:3]) + '</main><div style="height:3000px"></div><script>const rest=' + json.dumps(arts[3:]) +
    ';addEventListener("scroll",()=>{if(rest.length&&scrollY>200){document.getElementById("m").insertAdjacentHTML("beforeend",rest.shift())}})</script></body></html>')

# --- Lidl: data-grid-data in de server-HTML
boxes = []
for p in load('lidl'):
    d = {"productId": int(p['id']), "fullTitle": p['title'], "title": p['title'], "category": p['category'], "canonicalUrl": p['url'],
         "storeStartDate": p['start'], "storeEndDate": p['end'], "price": {"price": p['price'], "packaging": {"text": p['packaging']} if p['packaging'] else {}}}
    if p['oldPrice']: d['price']['oldPrice'] = p['oldPrice']
    if p['plusPrice']: d['lidlPlus'] = [{"highlightText": p['plusText'], "price": {"price": p['plusPrice']}}]
    boxes.append(f'<div class="product-grid-box" data-grid-data="{html.escape(json.dumps(d))}"></div>')
(OUT / 'lidl.html').write_text('<!doctype html><html><body>' + ''.join(boxes) + '</body></html>')

# --- Aldi: productgegevens als JSON-tekst binnen __NEXT_DATA__
prods = {}
for p in load('aldi'):
    cp = {"priceValue": p['price'], "priceTagLabels": {"promoText1": p['label']} if p['label'] else {}, "validFrom": p['validFrom'], "validUntil": p['validUntil']}
    if p['strike']: cp['strikePrice'] = {"strikePriceValue": p['strike']}
    prods[p['id']] = {"name": p['name'], "brandName": p['brand'], "salesUnit": p['salesUnit'], "productSlug": p['slug'], "objectID": p['id'], "mainCategoryID": p['category'],
        "currentPrice": cp, "promotionPrices": [{"validFromLocalDate": p['from'], "validUntilLocalDate": p['to']}]}
nd = {"props": {"pageProps": {"page": {"offers": json.dumps({"products": prods})}}}}
(OUT / 'aldi.html').write_text(f'<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">{json.dumps(nd)}</script></body></html>')

# --- Dirk/DekaMarkt: Nuxt "devalue"-formaat
def devalue(root):
    arr = []
    def enc(v):
        i = len(arr); arr.append(None)
        if isinstance(v, dict): arr[i] = {k: enc(x) for k, x in v.items()}
        elif isinstance(v, list): arr[i] = [enc(x) for x in v]
        else: arr[i] = v
        return i
    enc(root); return arr
offers = []
for o in load('dekamarkt'):
    offers.append({"offerId": o['offerId'], "headerText": o['headerText'], "packaging": o['packaging'], "offerPrice": o['offerPrice'], "normalPrice": o['normalPrice'],
        "textPriceSign": o['sign'], "subText": o['subText'], "startDate": o['start'], "endDate": o['end'],
        "products": [{"productId": p['id'], "offerPrice": p['offerPrice'], "normalPrice": p['normalPrice'],
                      "productInformation": {"headerText": p['name'], "packaging": p['packaging'], "brand": p['brand']}} for p in o['products']] + [None]})
nuxt = devalue({"data": {"offers-currentOffers": [{"currentOffers": offers}]}})
for store in ('dirk', 'dekamarkt'):
    (OUT / f'{store}.html').write_text(f'<!doctype html><html><body><script type="application/json" id="__NUXT_DATA__">{json.dumps(nuxt)}</script></body></html>')

# --- PLUS: tegels in een eigen scrollcontainer, bijladen bij muiswiel
items = []
for p in load('plus'):
    price = p['price'] or 0
    i, d = (f'{price:.2f}').split('.')
    items.append(f'<div class="plp-item-wrapper item__{p.get("id","0")}"><a href="{p["href"]}">' + (f'<span class="promo-round">{html.escape(p["text"].split(" PLUS")[0])}</span>' if not p["label"] and not p["text"].startswith(p["name"]) else '') + f'<div class="plp-item-name"><h3><span>{html.escape(p["name"])}</span></h3></div>'
        f'<div class="plp-item-complementary">{html.escape(p["complementary"])}</div>' + (f'<div class="promo-offer-label">{html.escape(p["label"])}</div>' if p['label'] else '') +
        (f'<div class="product-header-price-integer">{i}.</div><div class="product-header-price-decimals">{d}</div>' if p['price'] else '') +
        f'<div class="product-header-price-previous">{html.escape(p["previous"])}</div></a></div>')
(OUT / 'plus.html').write_text('<!doctype html><html><body><p>Woensdag 11 november t/m dinsdag 17 november</p><div id="m">' + ''.join(items[:4]) +
    '</div><script>const rest=' + json.dumps(items[4:]) + ';addEventListener("wheel",()=>{if(rest.length){document.getElementById("m").insertAdjacentHTML("beforeend",rest.shift())}})</script></body></html>')
print('pagina\'s gemaakt in', OUT)

# --- Aldi assortiment: overzichtspagina + één subcategorie
(OUT / 'producten.html').write_text('<!doctype html><html><body><a href="https://example.test/producten/zuivel-eieren-boter/verse-zuivel.html">Verse zuivel</a>'
    '<a href="/producten/aldi-merken/milsani.html">Milsani</a></body></html>')
zuivel = {"z1": {"name": "Halfvolle melk", "brandName": "MILSANI", "salesUnit": "1 l", "productSlug": "halfvolle-melk-1", "objectID": "z1",
                 "currentPrice": {"priceValue": 0.99}}, "z2": {"name": "Yoghurt naturel", "brandName": "MILSANI", "salesUnit": "1 kg", "productSlug": "yoghurt-2",
                 "objectID": "z2", "currentPrice": {"priceValue": 1.15, "strikePrice": {"strikePriceValue": 1.39}}}}
(OUT / 'verse-zuivel.html').write_text('<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">' +
    json.dumps({"props": {"pageProps": {"x": json.dumps({"hits": zuivel})}}}) + '</script></body></html>')
