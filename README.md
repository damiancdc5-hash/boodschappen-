# Slimme Boodschappenassistent

Een installeerbare webapp (PWA) voor het hele huishouden: gedeelde boodschappenlijst met live synchronisatie,
prijsvergelijker met drie winkelscenario's, recepten importeren, automatisch goedkoop weekmenu, digitale voorraadkast,
budgetbeheer en een winkelroute op de kaart. Werkt in de browser op iPhone, Android, iPad, Windows en Mac, en is te installeren op het beginscherm.

| Onderdeel | Techniek |
|---|---|
| Frontend | HTML/CSS/JavaScript (ES-modules), geen build-stap. Map `app/` |
| Database, accounts, realtime | [Supabase](https://supabase.com) (PostgreSQL + Auth + Realtime), gratis abonnement volstaat |
| Beveiliging | Row Level Security: elk huishouden ziet alleen zijn eigen gegevens. Beheerders en gezinsleden |
| Prijzen | Dagelijkse sync van de open dataset van [Checkjebon.nl](https://www.checkjebon.nl) via GitHub Actions |
| Aanbiedingen | Dagelijks uitgelezen van de aanbiedingenpagina's van AH, Jumbo, Lidl, Aldi, PLUS, Dirk en DekaMarkt (GitHub Actions + onzichtbare browser) |
| Recept via URL | Supabase Edge Function `import-recipe` |
| Kaart en route | OpenStreetMap (Leaflet, Overpass, Nominatim, routing.openstreetmap.de) |
| Hosting | GitHub Pages (workflow inbegrepen), of Netlify/Vercel/Cloudflare Pages |

---

## Installatie (± 30 minuten, eenmalig)

### 1. Supabase-project aanmaken
1. Maak een gratis account op <https://supabase.com> → **New project**. Kies regio **Frankfurt (eu-central-1)**.
2. Ga naar **SQL Editor** → **New query**, plak de volledige inhoud van `supabase/migrations/001_schema.sql` en klik **Run**.
   Doe daarna hetzelfde met `supabase/migrations/002_website_offers.sql` en `supabase/migrations/003_invite_only.sql`.
3. Ga naar **Project Settings → API** en noteer:
   - *Project URL* (bijv. `https://abcd.supabase.co`)
   - *anon public* key (mag in de browser staan)
   - *service_role* key (**geheim**, alleen voor de prijssync)

### 2. Recept-import installeren (Edge Function)
Supabase Dashboard → **Edge Functions** → **Deploy a new function** → *Via editor* → naam **`import-recipe`** →
plak de inhoud van `supabase/functions/import-recipe/index.ts` → **Deploy**. Laat "Verify JWT" aan.

### 3. App online zetten (GitHub Pages)
1. Maak op GitHub een nieuwe repository en upload de volledige inhoud van deze map (inclusief `.github/`).
   GitHub Pages werkt gratis met een **publieke** repository; er staan geen geheimen in de code.
2. Repository → **Settings → Pages** → *Source*: **GitHub Actions**.
3. **Settings → Secrets and variables → Actions**:
   - tabblad **Variables**: `SUPABASE_URL` en `SUPABASE_ANON_KEY`
   - tabblad **Secrets**: `SUPABASE_URL` en `SUPABASE_SERVICE_ROLE_KEY`
4. Tabblad **Actions** → "App publiceren (GitHub Pages)" → **Run workflow**. Na ± 1 minuut staat de app op
   `https://<gebruikersnaam>.github.io/<repository>/`.

*Andere hosting?* Vul dan `SUPABASE_URL` en `SUPABASE_ANON_KEY` in `app/js/config.js` in en publiceer de map `app/`.

### 4. Prijzen inladen
Tabblad **Actions** → "Prijzen bijwerken" → **Run workflow**. Daarna draait dit elke ochtend automatisch.
In de app staat onder **Prijzen → Databronnen** per supermarkt hoeveel producten er zijn en wanneer ze laatst gecontroleerd zijn.

### 4b. Aanbiedingen ophalen
Tabblad **Actions** → "Aanbiedingen bijwerken" → **Run workflow** (eerste keer ± 5 minuten). Daarna draait dit elke ochtend automatisch.
In de app staat onder **Prijzen → Aanbiedingen** per supermarkt hoeveel acties er zijn gevonden en wanneer. Eén winkel testen:
vul bij *Run workflow* bijvoorbeeld `ah,dirk` in.

### 5. Inloggen instellen
Supabase → **Authentication → URL Configuration**:
- *Site URL*: het adres van je app
- *Redirect URLs*: hetzelfde adres (voor bevestigingsmails en wachtwoordherstel)

### 5b. Alleen op uitnodiging
Na `003_invite_only.sql` kan alleen het allereerste account zich vrij aanmelden. Daarna nodigt een beheerder gezinsleden uit via
**Huishouden → Gezinslid uitnodigen** (e-mailadres invullen). Wie zich aanmeldt met dat adres, komt automatisch in het huishouden.

Zet in Supabase **Authentication → Sign In / Providers → Email → Confirm email** uit. De ingebouwde mailservice van Supabase
stuurt namelijk alleen mail naar leden van je Supabase-team; gezinsleden zouden de bevestigingsmail nooit krijgen. Omdat alleen
uitgenodigde adressen een account kunnen maken, is dat veilig. (Wil je wel mail, zoals "wachtwoord vergeten" voor gezinsleden?
Stel dan onder Authentication → Emails → SMTP een eigen mailserver in.)

### 6. Gebruiken
1. Open de app, maak een account aan en bevestig je e-mailadres.
2. Kies **Nieuw huishouden starten** (jij wordt beheerder). Vul onder **Huishouden** jullie adres, vervoer en supermarkten in.
3. Ga naar **Huishouden → Gezinslid uitnodigen**, vul het e-mailadres in en stuur het bericht door. Het gezinslid maakt met dat adres een account aan en zit direct in het huishouden.
4. Installeren op het beginscherm: iPhone/iPad → Safari → deelknop → *Zet op beginscherm*. Android → Chrome-menu → *App installeren*.
   Laptop → installatie-icoon in de adresbalk van Chrome/Edge.

---

## Wat de app doet

- **Boodschappenlijst** – meerdere lijsten, aantallen, gewicht/inhoud, categorieën (automatisch herkend), favorieten.
  Afvinken en toevoegen verschijnt binnen een seconde bij alle gezinsleden. Zonder bereik in de winkel blijft de lijst zichtbaar;
  afvinken wordt verstuurd zodra er weer verbinding is. Dubbele producten worden opgeteld in plaats van twee keer toegevoegd.
- **Prijsvergelijker** – per product de kandidaten per supermarkt met prijs per kilo/liter/stuk en "laatst gecontroleerd".
  Drie scenario's: (1) alles bij één winkel, (2) goedkoopste combinatie over max. *n* winkels, (3) beste balans tussen prijs,
  reiskosten, reistijd en gemak. Je kunt per product een specifiek artikel vastzetten.
- **Aanbiedingen** – 1+1, 2+1, 2e halve prijs, "3 voor €5", % korting, actieprijs en klantenkaartprijs worden correct doorgerekend.
- **Recepten** – importeren via website-link, geplakte tekst, foto (tekstherkenning op het eigen apparaat) of PDF.
  Ingrediënten, hoeveelheden en aantal personen worden herkend; schalen naar ander aantal personen; ontbrekende ingrediënten
  (na aftrek van de voorraad) op de lijst.
- **Weekmenu** – kiest automatisch recepten die samen het goedkoopst zijn: rekent met hele verpakkingen (minder restjes),
  beloont gedeelde ingrediënten, gebruikt de voorraad, actuele prijzen en jullie acties, houdt rekening met budget en voorkeuren
  ("vegetarisch", "geen vis"). Toont goedkopere alternatieven, is handmatig aan te passen; goedkeuren zet één gecombineerde lijst klaar.
- **Voorraadkast** – hoeveelheid, houdbaarheidsdatum, locatie; waarschuwing bij producten die bijna over datum zijn;
  wordt meegenomen in recepten en weekmenu. Bij afrekenen gaan afgevinkte producten automatisch de voorraad in.
- **Budget** – week- en maandbudget (alleen beheerders), gepland vs. werkelijk, resterend, besparing door acties en t.o.v.
  de gemiddelde supermarktprijs, waarschuwing bij een instelbaar percentage, grafieken per week en maand.
- **Winkelroute** – dichtstbijzijnde vestiging per keten, kortste volgorde langs de winkels, werkelijke afstand en reistijd
  (auto/fiets/lopen), reiskosten, en doorsturen naar Google Maps / Apple Kaarten.

## Eerlijk over de gegevens

- **Er worden nooit verzonnen prijzen getoond.** Ontbreekt een prijs, dan staat er "geen prijs" en telt het product niet mee in het totaal (dat wordt er dan bij gemeld).
- **Normale prijzen** komen uit de open dataset van Checkjebon.nl (open source op GitHub; de makers geven aan dat de data hergebruikt mag worden).
  Die dekt AH, Jumbo, Aldi, PLUS, Dirk, Vomar, Hoogvliet en DekaMarkt. **Lidl** zit er niet in; van Lidl gebruikt de app de producten uit de wekelijkse aanbiedingen op lidl.nl.
  "Laatst gecontroleerd" is het moment waarop de bron haar prijzen voor het laatst heeft bijgewerkt.
- **Aanbiedingen** worden elke ochtend automatisch van de websites van de supermarkten gehaald:

  | Winkel | Hoe | Opmerking |
  |---|---|---|
  | Albert Heijn | bonuspagina (ah.nl/bonus) | alle bonusacties incl. 1+1, 2e halve prijs, "2 voor"; Etos, Gall & Gall en alleen-online overgeslagen |
  | Dirk, DekaMarkt | aanbiedingenpagina | per product met actieprijs en normale prijs |
  | Aldi | aanbiedingenpagina | met doorgestreepte normale prijs en "2 voor" |
  | Lidl | aanbiedingenpagina | incl. Lidl Plus-prijs; deze producten tellen ook mee in de prijsvergelijking |
  | Jumbo | aanbiedingenpagina | Jumbo toont niet alle acties op één pagina; de app ziet de acties die daar staan (± 30–40) |
  | PLUS | aanbiedingenpagina | laadt in delen; mogelijk niet alle acties |
  | Vomar, Hoogvliet | — | niet automatisch; voer acties zelf in |

  De acties worden aan producten gekoppeld via productnummer (AH, PLUS, Lidl) of via de productnaam ("Alle Bonduelle" → alle Bonduelle-producten van AH)
  en automatisch meegerekend in de prijsvergelijking, de winkelscenario's en het weekmenu. Onder **Prijzen → Aanbiedingen** zie je welke acties
  op jullie lijst van toepassing zijn.
- **Let op bij het uitlezen van websites**: supermarkten bieden deze gegevens niet officieel aan. Hun websites kunnen automatische bezoeken blokkeren
  of hun opbouw wijzigen; dan staat er bij die winkel "mislukt" of "niets gevonden" en moet het uitleesprogramma (`scripts/offers/extractors.mjs`)
  worden aangepast. De andere winkels werken dan gewoon door. De gebruiksvoorwaarden van supermarktwebsites kunnen automatisch uitlezen verbieden;
  de app bezoekt elke pagina één keer per dag, laadt geen afbeeldingen en is bedoeld voor eigen huishoudelijk gebruik.
- Zelf acties invoeren kan altijd nog (voor Vomar, Hoogvliet of een actie in de winkel).
- Supermarktprijzen kunnen per vestiging verschillen (vooral bij Jumbo en PLUS). De app toont de landelijke online prijs.
- De sync stopt bewust als de bron opeens verdacht weinig producten levert, zodat bestaande prijzen niet worden gewist.

## Nog niet gebouwd (volgende fases)

- Barcode scannen in de voorraadkast (het barcodeveld bestaat al; scannen met de camera volgt).
- Pushmeldingen (bijv. "budget bijna op", "melk verloopt morgen"). Nu staan waarschuwingen in de app zelf.

## Testen

```bash
node --test tests/lib.test.mjs          # rekenlogica (eenheden, acties, scenario's, weekmenu, recepten)
sh tests/sql/run.sh                     # schema + beveiligingsregels op een lokale PostgreSQL
python3 tests/e2e/run_e2e.py            # volledige UI-test met twee gebruikers (Playwright)
node --test tests/offers.test.mjs       # actielabels en omzetting per supermarkt (echte voorbeelddata)
python3 tests/e2e-offers/make_pages.py && node tests/e2e-offers/run.mjs   # aanbiedingensync in een echte browser
node scripts/sync-offers.mjs --dry-run --only ah,dirk                    # echte websites uitlezen zonder op te slaan
node scripts/sync-prices.mjs --file tests/fixtures/checkjebon-sample.json --dry-run
```

De UI-test gebruikt een nagebootste database (`tests/e2e/mock-supabase.js`) met testprijzen; die wordt nooit met de app meegeleverd.

## Mappen

```
app/                     de webapp (dit wordt gepubliceerd)
  js/lib/                rekenlogica zonder afhankelijkheden (getest)
  js/views/              schermen: dashboard, lijst, prijzen, recepten, weekmenu, voorraad, budget, route, huishouden
supabase/migrations/     databaseschema met beveiligingsregels
supabase/functions/      Edge Function voor recept-import
scripts/sync-prices.mjs  dagelijkse prijssync
scripts/sync-offers.mjs  dagelijkse aanbiedingensync (scripts/offers/: uitlezen en omzetten per winkel)
.github/workflows/       publiceren + prijssync
tests/                   unit-, database- en UI-tests
```
