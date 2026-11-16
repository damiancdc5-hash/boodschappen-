"""End-to-end UI-test met twee 'apparaten' (Anna op laptop, Bram op telefoon) tegen een nagebootste Supabase.
Draaien:  python3 tests/e2e/run_e2e.py   (start zelf een lokale webserver)"""
import json, os, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'tests' / 'e2e' / 'screens'
OUT.mkdir(exist_ok=True)
MOCK = (ROOT / 'tests/e2e/mock-supabase.js').read_text()
PORT = 8765
BASE = f'http://127.0.0.1:{PORT}/'

# Testprijzen (alleen in de test-database; de echte app gebruikt de Checkjebon-sync)
P = lambda store, name, price, amount, unit: dict(id=abs(hash(store + name)) % 10**9, store=store, name=name, price=price, size_text=f'{amount} {unit}',
    amount=amount, unit=unit, unit_price=round(price / (amount / 1000 if unit in ('g', 'ml') else amount), 4), link=None, source='test', checked_at='2026-11-16T06:00:00Z')
PRODUCTS = [P('ah', 'AH Halfvolle melk', 1.29, 1000, 'ml'), P('dirk', 'Melkunie Halfvolle melk', 1.09, 1000, 'ml'), P('jumbo', 'Jumbo Halfvolle melk', 1.25, 1000, 'ml'),
    P('ah', 'AH Pindakaas', 2.99, 600, 'g'), P('jumbo', 'Jumbo Pindakaas', 2.29, 600, 'g'), P('ah', 'AH Spaghetti', 1.09, 500, 'g'), P('jumbo', 'Jumbo Spaghetti', 0.99, 500, 'g'),
    P('dirk', 'Dirk Spaghetti', 0.89, 500, 'g'), P('ah', 'AH Rundergehakt', 4.99, 500, 'g'), P('jumbo', 'Jumbo Rundergehakt', 4.79, 500, 'g'),
    P('ah', 'AH Ui', 0.25, 1, 'st'), P('ah', 'AH Tomatenblokjes', 0.69, 1, 'st'), P('jumbo', 'Jumbo Tomatenblokjes', 0.59, 1, 'st'), P('ah', 'AH Knoflook', 0.89, 1, 'st')]

TODAY = time.strftime('%Y-%m-%d')
OFFERS = [dict(id='web1', household_id=None, store='dirk', product_name='Dirk Spaghetti', offer_type='multibuy', params={'n': 2, 'total': 1.5}, regular_price=0.89,
    valid_from=TODAY, valid_to='2099-01-01', source='website dirk', match_terms=['dirk spaghetti'], size_text='500 g')]

errors = []

def setup(page, name):
    page.on('console', lambda m: m.type == 'error' and errors.append(f'[{name}] {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'[{name}] {e}'))

def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '-d', str(ROOT / 'app')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context(viewport={'width': 1280, 'height': 860}, locale='nl-NL', service_workers='block')
            ctx.route('https://esm.sh/**', lambda r: r.fulfill(body=MOCK, content_type='application/javascript'))
            ctx.route(lambda u: not u.startswith(BASE) and 'esm.sh' not in u, lambda r: r.abort())
            ctx.add_init_script(f"""localStorage.setItem('bs.config', JSON.stringify({{url:'https://test.supabase.co', key:'test'}}));
              if (!localStorage.getItem('mockdb')) localStorage.setItem('mockdb', JSON.stringify({{store_products: {json.dumps(PRODUCTS)}, price_sync_runs: [{{id:1,source:'checkjebon',status:'ok',started_at:'2026-11-16T06:00:00Z',finished_at:'2026-11-16T06:03:00Z',message:'test'}},{{id:2,source:'aanbiedingen:dirk',status:'ok',started_at:'2026-11-16T05:41:00Z',finished_at:'2026-11-16T05:42:00Z',message:'1 acties'}}], offers: {json.dumps(OFFERS)}}}));""")

            # --- Anna (laptop): registreren + huishouden
            anna = ctx.new_page(); setup(anna, 'anna')
            anna.goto(BASE)
            expect(anna.get_by_role('heading', name='Inloggen')).to_be_visible()
            anna.screenshot(path=OUT / '01-login.png')
            anna.get_by_text('Nieuw account').click()
            anna.fill('#n', 'Anna'); anna.fill('#e', 'anna@test.nl'); anna.fill('#p', 'geheim123')
            anna.get_by_role('button', name='Account aanmaken').click()
            expect(anna.get_by_text('Of: nieuw huishouden starten')).to_be_visible()
            anna.fill('#create input[name=name]', 'Familie Test')
            anna.get_by_role('button', name='Huishouden aanmaken').click()
            expect(anna.get_by_role('heading', name='Gezinsleden')).to_be_visible()
            # Anna nodigt Bram uit (alleen op uitnodiging)
            anna.fill('#inv input[name=email]', 'bram@test.nl'); anna.click('#inv button')
            expect(anna.locator('.item', has_text='bram@test.nl')).to_be_visible()
            # budget instellen
            anna.goto(BASE + '#/budget'); anna.get_by_role('button', name='Budget instellen').click()
            anna.fill('input[name=weekly]', '60'); anna.fill('input[name=monthly]', '250'); anna.get_by_role('button', name='Opslaan').click()
            expect(anna.get_by_text('€ 60,00').first).to_be_visible()

            # --- lijst
            anna.goto(BASE + '#/lijst')
            add = lambda pg, n, q='', u='st': (pg.fill('#add input[name=name]', n), pg.fill('#add input[name=quantity]', q), pg.select_option('#add select[name=unit]', u), pg.click('#add button'))
            add(anna, 'halfvolle melk', '2'); add(anna, 'pindakaas'); add(anna, 'spaghetti', '500', 'g')
            expect(anna.locator('.item .name', has_text='halfvolle melk')).to_be_visible()
            add(anna, 'Halfvolle melk', '1')   # dubbel → optellen
            expect(anna.locator('.item .name', has_text='halfvolle melk')).to_contain_text('3×')
            assert anna.locator('.item').count() == 3, 'dubbel product toegevoegd'

            # --- Bram (telefoon) sluit aan
            bram = ctx.new_page(); setup(bram, 'bram'); bram.set_viewport_size({'width': 390, 'height': 844})
            # Iemand zonder uitnodiging kan zich niet aanmelden
            bram.goto(BASE)
            bram.get_by_text('Nieuw account').click()
            expect(bram.get_by_text('Aanmelden kan alleen op uitnodiging').first).to_be_visible()
            bram.fill('#n', 'Vreemde'); bram.fill('#e', 'vreemd@test.nl'); bram.fill('#p', 'geheim123')
            bram.get_by_role('button', name='Account aanmaken').click()
            expect(bram.locator('#toast')).to_contain_text('alleen op uitnodiging')
            # Bram (uitgenodigd) wel, en komt direct in het huishouden
            bram.fill('#n', 'Bram'); bram.fill('#e', 'bram@test.nl')
            bram.get_by_role('button', name='Account aanmaken').click()
            expect(bram.get_by_role('heading', name='Goedenavond, Bram').or_(bram.get_by_role('heading', name='Goedemiddag, Bram')).or_(bram.get_by_role('heading', name='Goedemorgen, Bram'))).to_be_visible()
            bram.goto(BASE + '#/lijst')
            expect(bram.locator('.item .name', has_text='pindakaas')).to_be_visible()

            # realtime: Bram vinkt af → Anna ziet het; Anna voegt toe → Bram ziet het
            bram.locator('.item', has_text='pindakaas').locator('[data-toggle]').click()
            expect(anna.locator('.item.done', has_text='pindakaas')).to_be_visible(timeout=4000)
            expect(anna.get_by_text('afgevinkt door Bram')).to_be_visible()
            add(anna, 'tomatenblokjes', '2')
            expect(bram.locator('.item .name', has_text='tomatenblokjes')).to_be_visible(timeout=4000)
            bram.screenshot(path=OUT / '02-lijst-telefoon.png', full_page=True)

            # --- prijzen
            anna.goto(BASE + '#/prijzen')
            expect(anna.get_by_text('1 · Eén winkel')).to_be_visible(timeout=8000)
            anna.screenshot(path=OUT / '03-prijzen.png', full_page=True)
            body = anna.locator('#res').inner_text()
            assert 'Beste balans' in body and '€' in body, body[:400]
            anna.get_by_role('button', name='Product zoeken').click()
            anna.fill('#s', 'spaghetti')
            expect(anna.locator('tr.best', has_text='Dirk Spaghetti')).to_be_visible()
            anna.get_by_role('button', name='Aanbiedingen').click()
            expect(anna.get_by_role('heading', name='Aanbiedingen', exact=True)).to_be_visible()
            expect(anna.get_by_text('Voor jullie lijst')).to_be_visible()
            expect(anna.locator('.offer-card', has_text='Dirk Spaghetti').first).to_contain_text('2 voor')
            anna.locator('#add').click()
            anna.fill('input[name=product]', 'Jumbo Rundergehakt'); anna.select_option('select[name=store]', 'jumbo'); anna.select_option('select[name=type]', '1+1')
            anna.get_by_role('button', name='Opslaan').click()
            expect(anna.locator('.offer-card', has_text='Jumbo Rundergehakt').first).to_contain_text('1+1 gratis')
            anna.screenshot(path=OUT / '03b-aanbiedingen.png', full_page=True)
            anna.goto(BASE + '#/prijzen')
            anna.get_by_role('button', name='Databronnen').click()
            expect(anna.get_by_text('geen data beschikbaar').first).to_be_visible()

            # --- recepten (tekst-import) + op lijst
            anna.goto(BASE + '#/recepten')
            anna.get_by_role('button', name='＋ Recept toevoegen').click()
            anna.locator('#it [data-m=text]').click()
            anna.fill('textarea[name=text]', 'Pasta bolognese\nVoor 4 personen\nIngrediënten\n400 g spaghetti\n500 g rundergehakt\n1 ui\n2 teentjes knoflook\n1 blik tomatenblokjes\nBereiding\nKook de pasta en bak het gehakt rul.')
            anna.get_by_role('button', name='Herkennen').click()
            expect(anna.locator('input[name=title]')).to_have_value('Pasta bolognese')
            anna.get_by_role('button', name='Opslaan').click()
            for t, ings in [('Pasta pesto', '250 g spaghetti\n1 pot pesto'), ('Spaghetti tomaat', '400 g spaghetti\n2 blik tomatenblokjes\n1 ui')]:
                anna.get_by_role('button', name='＋ Recept toevoegen').click(); anna.locator('#it [data-m=manual]').click()
                anna.fill('input[name=title]', t); anna.fill('textarea[name=ings]', ings); anna.get_by_role('button', name='Opslaan').click()
                expect(anna.locator('.card h3', has_text=t)).to_be_visible()
            # keukengerei uit een online recept komt niet op de lijst
            anna.get_by_role('button', name='＋ Recept toevoegen').click(); anna.locator('#it [data-m=manual]').click()
            anna.fill('input[name=title]', 'Ovenschotel kip'); anna.fill('textarea[name=ings]', '300 g kipfilet\n1 ovenschaal\nbakpapier'); anna.get_by_role('button', name='Opslaan').click()
            anna.locator('.card h3', has_text='Ovenschotel kip').click()
            expect(anna.get_by_text('keukengerei — niet op de lijst').first).to_be_visible()
            anna.get_by_role('button', name='Ontbrekende ingrediënten op lijst').click()
            expect(anna.locator('#toast')).to_contain_text('1 toegevoegd')
            anna.locator('[data-close]').click()
            # recepten zoeken op zin
            anna.fill('#zin input[name=q]', 'ik heb zin in pasta'); anna.click('#zin button')
            expect(anna.locator('#sug .chip', has_text='Pasta bolognese')).to_be_visible()
            expect(anna.locator('#sug .offer-card', has_text='Pasta met spinazie')).to_be_visible()
            anna.locator('.card h3', has_text='Pasta bolognese').click()
            anna.get_by_role('button', name='Ontbrekende ingrediënten op lijst').click()
            expect(anna.locator('#toast')).to_contain_text('opgeteld')
            anna.keyboard.press('Escape'); anna.locator('[data-close]').click()

            # --- voorraad
            anna.goto(BASE + '#/voorraad'); anna.get_by_role('button', name='＋ Toevoegen').click()
            anna.fill('input[name=name]', 'spaghetti'); anna.fill('input[name=quantity]', '1'); anna.select_option('select[name=unit]', 'kg')
            anna.fill('input[name=expires_on]', time.strftime('%Y-%m-%d', time.localtime(time.time() + 86400))); anna.fill('input[name=location]', 'Voorraadkast')
            anna.get_by_role('button', name='Opslaan').click()
            expect(anna.get_by_text('Bijna over datum')).to_be_visible()

            # --- weekmenu
            anna.goto(BASE + '#/weekmenu')
            anna.fill('input[name=days]', '3'); anna.fill('input[name=persons]', '2')
            anna.get_by_role('button', name='Stel goedkoop menu samen').click()
            expect(anna.get_by_role('heading', name='Voorstel')).to_be_visible(timeout=8000)
            anna.screenshot(path=OUT / '04-weekmenu.png', full_page=True)
            anna.get_by_role('button', name='Goedkeuren → boodschappenlijst').first.click()
            expect(anna.locator('#toast')).to_contain_text('Boodschappenlijst bijgewerkt')
            # een dag uit het goedgekeurde menu halen → bijbehorende boodschappen gaan van de lijst
            anna.goto(BASE + '#/lijst'); anna.wait_for_timeout(400)
            assert anna.locator('.item .name', has_text='ovenschaal').count() == 0, 'ovenschaal op de lijst'
            before = anna.locator('.item').count()
            names_before = anna.locator('.item .name').all_inner_texts()
            anna.goto(BASE + '#/weekmenu')
            anna.locator('[data-delentry]').first.click()
            anna.get_by_role('button', name='Verwijderen').last.click()
            expect(anna.locator('#toast')).to_contain_text('Lijst bijgewerkt')
            assert anna.locator('[data-delentry]').count() == 2, 'dag niet verwijderd'
            anna.goto(BASE + '#/lijst'); anna.wait_for_timeout(400)
            after = anna.locator('.item').count()
            names_after = anna.locator('.item .name').all_inner_texts()
            assert names_after != names_before, f'lijst onveranderd: {names_after}'
            print('lijst voor/na dag verwijderen:', before, '→', after, '\nVOOR:', names_before, '\nNA:', names_after)

            # --- afrekenen op telefoon → budget
            bram.goto(BASE + '#/lijst')
            bram.get_by_role('button', name='Afrekenen (1)').click()
            bram.fill('input[name=amount]', '23,45'); bram.get_by_role('button', name='Opslaan').click()
            expect(bram.locator('#toast')).to_contain_text('Uitgave opgeslagen')
            anna.goto(BASE + '#/budget')
            expect(anna.get_by_text('€ 23,45').first).to_be_visible(timeout=4000)
            anna.screenshot(path=OUT / '05-budget.png', full_page=True)
            anna.goto(BASE + '#/dashboard'); expect(anna.get_by_text('Goed', exact=False).first).to_be_visible()
            anna.screenshot(path=OUT / '06-dashboard.png', full_page=True)
            bram.goto(BASE + '#/dashboard'); bram.wait_for_timeout(500); bram.screenshot(path=OUT / '07-dashboard-telefoon.png', full_page=True)
            anna.goto(BASE + '#/route'); expect(anna.get_by_text('Stel eerst jullie adres in')).to_be_visible()
            # rollen: Bram (gezinslid) kan budget niet instellen
            bram.goto(BASE + '#/budget'); expect(bram.get_by_role('button', name='Budget instellen')).to_be_disabled()
            bram.goto(BASE + '#/meer'); bram.screenshot(path=OUT / '08-meer-telefoon.png')
            br.close()
    except Exception:
        for pg in ctx.pages:
            try: print('--- PAGINA', pg.url, '\n', pg.locator('main').inner_text()[:600])
            except Exception: pass
        print('\n'.join(errors)); raise
    finally:
        srv.terminate()
    real = [e for e in errors if 'ERR_FAILED' not in e and 'net::' not in e]
    if real: print('CONSOLE-FOUTEN:\n' + '\n'.join(real)); sys.exit(1)
    print('E2E OK')

main()
