#!/usr/bin/env node
'use strict';
/**
 * Read-only. Which metal and stone descriptions does our mapping not recognise?
 *
 * Every one of these is a product we could otherwise list, failing on vocabulary
 * rather than on anything Amazon has said. Printed by how many products each costs, so
 * the mapping tables get extended where it actually pays.
 */
const db = require('../src/db');
const { metalOf, stoneOf, PRODUCT_TYPES } = require('../src/stage2/attributes');

async function main() {
  const { rows } = await db.query(`
    select a.vendor, a.sku, a.our_price as price,
           coalesce(r.s_metal_type,'') as metal,
           coalesce(r.s_stone_type,'') as stone,
           coalesce(p.product_type,'') as product_type
    from amazon_listings a
    join shopify_product_variants v on v.sku = a.sku
    join shopify_products p on p.product_id = v.product_id
    left join retail_edge_products r on r.sku = a.sku
    where a.state = 'no_match' and a.qty > 0 and p.media_count > 0`);

  const metalGaps = {};
  const stoneGaps = {};
  const typeGaps = {};
  let listable = 0;

  for (const r of rows) {
    let blocked = false;
    if (!PRODUCT_TYPES[r.product_type]) {
      typeGaps[r.product_type || '(none)'] = (typeGaps[r.product_type || '(none)'] || 0) + 1;
      blocked = true;
    }
    if (!metalOf(r.metal)) {
      const k = r.metal || '(nothing recorded)';
      metalGaps[k] = metalGaps[k] || { n: 0, value: 0 };
      metalGaps[k].n++; metalGaps[k].value += Number(r.price) || 0;
      blocked = true;
    }
    // A stone we cannot name is only a problem when one is recorded at all.
    if (r.stone && !/^n\/?a$/i.test(r.stone.trim()) && !stoneOf(r.stone)) {
      const k = r.stone;
      stoneGaps[k] = stoneGaps[k] || { n: 0, value: 0 };
      stoneGaps[k].n++; stoneGaps[k].value += Number(r.price) || 0;
      blocked = true;
    }
    if (!blocked) listable++;
  }

  const show = (title, obj) => {
    const entries = Object.entries(obj).sort((a, b) => (b[1].n || b[1]) - (a[1].n || a[1])).slice(0, 15);
    if (!entries.length) return;
    console.log(`\n${title}`);
    for (const [k, v] of entries) {
      const n = v.n ?? v;
      const val = v.value ? `  $${Math.round(v.value).toLocaleString()}` : '';
      console.log(`  ${String(n).padStart(5)}${val.padStart(12)}   ${k}`);
    }
  };

  console.log(`${rows.length} branded products Amazon has no listing for, with photos`);
  console.log(`${listable} of them our mapping already handles\n`);
  show('metal descriptions we do not recognise:', metalGaps);
  show('stone descriptions we do not recognise:', stoneGaps);
  show('product types with no Amazon category:', typeGaps);
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
