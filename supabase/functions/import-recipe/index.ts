// Supabase Edge Function: haalt een receptpagina op (de browser mag dat zelf niet door CORS)
// en geeft de schema.org-receptgegevens (JSON-LD) en platte tekst terug. Alleen voor ingelogde gebruikers.
//
// Installeren: Supabase Dashboard → Edge Functions → "Deploy a new function" → naam: import-recipe → plak dit bestand.
// Of met de CLI: supabase functions deploy import-recipe

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function isPrivateHost(host: string) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return h.includes(':'); // IPv6-literals niet toestaan
}

function extractJsonLd(html: string) {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* overslaan */ }
  }
  return out;
}

function pageText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|header|footer|nav)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/li|\/h\d|\/div|li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
    .slice(0, 20000);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Alleen POST' }, 405);
  let url: URL;
  try {
    const body = await req.json();
    url = new URL(String(body.url || ''));
  } catch { return json({ error: 'Ongeldige link' }, 400); }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return json({ error: 'Deze link is niet toegestaan' }, 400);

  try {
    const res = await fetch(url.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Boodschappenassistent/1.0; recept-import)', 'Accept': 'text/html', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return json({ error: `De website gaf foutcode ${res.status}` }, 200);
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4_000_000) break;
      chunks.push(value);
    }
    const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    const html = new TextDecoder().decode(buf);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
    return json({ url: res.url, title, jsonld: extractJsonLd(html), text: pageText(html) });
  } catch (e) {
    return json({ error: 'Pagina ophalen mislukt: ' + (e instanceof Error ? e.message : String(e)) }, 200);
  }
});
