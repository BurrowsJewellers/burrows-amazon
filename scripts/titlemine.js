#!/usr/bin/env node
'use strict';
/**
 * Read-only. What do our own titles and descriptions actually say?
 *
 * Before writing rules to read attributes out of text, find out what the text holds.
 * Guessing at the shape of the data is how you end up with rules that fire on nothing,
 * or worse, fire on the wrong thing.
 */
const db = require('../src/db');

async function photosFor(handle) {
  try {
    const res = await fetch('https://burrows-jewellers.myshopify.com/products/' + handle + '.js');
    if (!res.ok) return '';
    const j = await res.json();
    return String(j.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  } catch (err) { return ''; }
}

const WORDS = {
  metal: /stainless steel|sterling silver|\bsilver\b|yellow gold|rose gold|white gold|gold[- ]?plated|\bgold\b|titanium|ceramic|leather|\bsteel\b|\bbrass\b|rubber|silicone|\bresin\b|nylon|\bmesh\b/gi,
  shape: /\bround\b|\bsquare\b|rectangular|\brectangle\b|\boval\b|\btonneau\b|cushion|\bbarrel\b/gi,
  calendar: /\bchronograph\b|\bday[- ]date\b|\bdate\b|\bdigital\b|\banalog(?:ue)?\b|perpetual|\bmoon ?phase\b/gi,
  gender: /\bmen'?s?\b|\bwomen'?s?\b|\bladies\b|\bgents?\b|\bunisex\b|\bboys?\b|\bgirls?\b/gi,
  colour: /\bblack\b|\bwhite\b|\bblue\b|\bgreen\b|\bbrown\b|\bpink\b|\bred\b|\bgrey\b|\bgray\b|\bcream\b|\bchampagne\b|\bnavy\b|\btan\b/gi,
};

async function main() {
  const { rows } = await db.query(`
    select a.sku, a.vendor, a.our_title as title, p.handle, p.product_type
    from amazon_listings a
    join shopify_product_variants v on v.sku = a.sku
    join shopify_products p on p.product_id = v.product_id
    left join retail_edge_products r on r.sku = a.sku
    where a.state = 'no_match' and a.qty > 0 and p.media_count > 0
      and r.sku is null
    order by random() limit 40`);

  const found = { metal: 0, shape: 0, calendar: 0, gender: 0, colour: 0 };
  const fromTitle = { metal: 0, shape: 0, calendar: 0, gender: 0, colour: 0 };

  console.log('a sample of what we hold for dropship stock:\n');
  let shown = 0;
  for (const row of rows) {
    const desc = await photosFor(row.handle);
    const both = row.title + ' ' + desc;
    const hits = {};
    for (const [k, re] of Object.entries(WORDS)) {
      const inBoth = [...new Set((both.match(re) || []).map((x) => x.toLowerCase()))];
      const inTitle = [...new Set((row.title.match(re) || []).map((x) => x.toLowerCase()))];
      if (inBoth.length) found[k]++;
      if (inTitle.length) fromTitle[k]++;
      hits[k] = inBoth;
    }
    if (shown++ < 8) {
      console.log(`${row.vendor} / ${row.product_type} — ${row.title.slice(0, 62)}`);
      console.log(`   description: ${desc.slice(0, 90) || '(empty)'}`);
      for (const [k, v] of Object.entries(hits)) if (v.length) console.log(`   ${k}: ${v.join(', ')}`);
      console.log('');
    }
  }

  console.log(`across ${rows.length} products, how often each is findable:`);
  for (const k of Object.keys(WORDS)) {
    console.log(`  ${k.padEnd(9)} ${String(found[k]).padStart(3)}/${rows.length}  (title alone: ${fromTitle[k]})`);
  }
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
