// Recepten uit websites halen (schema.org/Recipe JSON-LD) — gedeeld door frontend en Edge Function.
import { parseIngredientLine, detectServings } from './ingredients.js';

function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

function findRecipeNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipeNode(n); if (r) return r; } return null; }
  const t = asArray(node['@type']).map(String);
  if (t.some((x) => x.toLowerCase() === 'recipe')) return node;
  if (node['@graph']) return findRecipeNode(node['@graph']);
  for (const v of Object.values(node)) if (v && typeof v === 'object') { const r = findRecipeNode(v); if (r) return r; }
  return null;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function instructionsText(ins) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (typeof x === 'string') { out.push(stripTags(x)); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.itemListElement) { walk(x.itemListElement); return; }
    if (x.text) out.push(stripTags(x.text));
    else if (x.name) out.push(stripTags(x.name));
  };
  walk(ins);
  return out.filter(Boolean).join('\n');
}

/** Haalt alle <script type="application/ld+json"> blokken uit HTML. */
export function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch { /* ongeldige JSON overslaan */ }
  }
  return blocks;
}

/** Zet een schema.org Recipe-object om naar ons formaat. */
export function recipeFromJsonLd(blocks, url = null) {
  const node = findRecipeNode(blocks);
  if (!node) return null;
  const yieldRaw = asArray(node.recipeYield).map(String).join(' ');
  const servings = parseInt((yieldRaw.match(/\d+/) || [])[0], 10) || detectServings(yieldRaw) || 4;
  const ingredients = asArray(node.recipeIngredient || node.ingredients).map((l) => parseIngredientLine(stripTags(l))).filter(Boolean);
  const img = asArray(node.image)[0];
  const tags = [...asArray(node.recipeCategory), ...asArray(node.recipeCuisine),
    ...String(node.keywords || '').split(',')].map((t) => stripTags(t).toLowerCase()).filter((t) => t && t.length < 30).slice(0, 12);
  if (asArray(node.suitableForDiet).some((d) => /vegetarian/i.test(d))) tags.push('vegetarisch');
  if (asArray(node.suitableForDiet).some((d) => /vegan/i.test(d))) tags.push('veganistisch');
  return {
    title: stripTags(node.name) || 'Recept',
    servings,
    ingredients,
    instructions: instructionsText(node.recipeInstructions),
    image_url: typeof img === 'string' ? img : img?.url || null,
    source_url: url,
    tags: [...new Set(tags)],
  };
}
