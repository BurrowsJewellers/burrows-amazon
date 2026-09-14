#!/usr/bin/env node
'use strict';
/**
 * Builds amazon_listings from the store mirror and the catalogue lookups.
 *
 * Every product on the Shopify store is considered — Burrows, Jewellery65 and
 * warehouse alike — and each one ends up in exactly one state with a reason a person
 * can read. Nothing is silently dropped: if a product is not going to Amazon, this
 * table says which rule stopped it.
 *
 * Read-only as far as Amazon is concerned. It never calls Amazon at all.
 */
const db = require('../src/db');
const { isValidGtin, explainGtin } = require('../src/match/gtin');
const { checkBrand } = require('../src/rules/brands');
const { scoreMatch } = require('../src/match/confidence');

const DROPSHIP_LOCATION = 96955793713;

async function main() {
  const started = await db.query(
    `insert into amazon_runs (job) values ('populate') returning id`
  );
  const runId = started.rows[0].id;

  // One row per product on the store, with the stock we actually hold, the cost
  // where Retail Edge knows it, and whatever the catalogue lookup found.
  const { rows } = await db.query(`
    select
      trim(v.barcode)                          as barcode,
      v.sku                                    as sku,
      coalesce(p.vendor, '')                   as vendor,
      coalesce(p.title, '')                    as our_title,
      v.price::numeric                         as our_price,
      r.cost_price::numeric                    as our_cost,
      r.supplier_id                            as supplier_id,
      coalesce((select sum(l.available)::int from shopify_inventory_levels l
                where l.inventory_item_id = v.inventory_item_id), 0) as qty,
      case when r.sku is not null then 'R' else 'W' end as source,
      m.match_state, m.asin, m.amazon_title, m.amazon_brand
    from shopify_product_variants v
    left join shopify_products p on p.product_id = v.product_id
    left join retail_edge_products r on r.sku = v.sku
    left join amazon_catalog_matches m on m.barcode = trim(v.barcode)
    where v.variant_id is not null
  `);

  console.log(`considering ${rows.length} products`);

  const counts = {};
  const bump = (k) => (counts[k] = (counts[k] || 0) + 1);
  let conflictsWritten = 0;

  for (const row of rows) {
    let state, reason = null, confidence = null, note = null;

    // 1. The brand ban comes first. It outranks everything, including a perfect match.
    const brand = checkBrand({ vendor: row.vendor, supplierId: row.supplier_id });
    if (!brand.allowed) {
      state = 'blocked';
      reason = brand.reason;
    }
    // 2. No usable barcode means no exact match is possible, and we never guess.
    else if (!isValidGtin(row.barcode)) {
      state = 'blocked';
      reason = explainGtin(row.barcode);
    }
    // 3. Nothing to sell.
    else if (row.qty <= 0) {
      state = 'blocked';
      reason = 'out of stock everywhere';
    }
    // 4. Not looked up yet.
    else if (!row.match_state) {
      state = 'candidate';
      reason = 'not yet looked up in Amazon’s catalogue';
    }
    // 5. Amazon has never heard of this barcode.
    else if (row.match_state !== 'hit') {
      state = 'no_match';
      reason = 'Amazon has no listing for this barcode';
    }
    // 6. Matched — but an exact barcode is not proof. Check what it points at.
    else {
      const scored = scoreMatch({
        ourVendor: row.vendor,
        ourTitle: row.our_title,
        ourPrice: Number(row.our_price) || 0,
        amazonBrand: row.amazon_brand,
        amazonTitle: row.amazon_title,
        amazonPrice: 0, // Amazon's own price needs a separate call; added in the pricing pass
      });
      confidence = scored.confidence;
      note = scored.note;

      if (scored.confidence === 'conflict') {
        state = 'conflict';
        reason = scored.note;
        await db.query(
          `insert into amazon_conflicts
             (barcode, sku, our_title, our_vendor, our_price, asin, amazon_title, amazon_brand, reason)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (barcode, asin) do update set last_seen_at = now(), reason = excluded.reason`,
          [row.barcode, row.sku, row.our_title, row.vendor, row.our_price,
           row.asin, row.amazon_title, row.amazon_brand, scored.note]
        );
        conflictsWritten++;
      } else if (scored.confidence === 'review') {
        state = 'review';
        reason = 'needs a person to confirm it is the same product';
      } else {
        state = 'ready';
      }
    }

    bump(state);

    await db.query(
      `insert into amazon_listings
         (barcode, sku, vendor, our_title, our_price, our_cost, qty, source,
          asin, amazon_title, amazon_brand, state, state_reason, confidence, match_note, checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       on conflict (barcode) do update set
         sku = excluded.sku, vendor = excluded.vendor, our_title = excluded.our_title,
         our_price = excluded.our_price, our_cost = excluded.our_cost, qty = excluded.qty,
         source = excluded.source, asin = excluded.asin, amazon_title = excluded.amazon_title,
         amazon_brand = excluded.amazon_brand,
         -- never quietly promote something out of listed; that is the pusher's job
         state = case when amazon_listings.state = 'listed' and excluded.state = 'ready'
                      then 'listed' else excluded.state end,
         state_reason = excluded.state_reason, confidence = excluded.confidence,
         match_note = excluded.match_note, checked_at = now(), updated_at = now()`,
      [row.barcode, row.sku, row.vendor, row.our_title, row.our_price, row.our_cost,
       row.qty, row.source, row.asin, row.amazon_title, row.amazon_brand,
       state, reason, confidence, note]
    );
  }

  await db.query(
    `update amazon_runs set finished_at = now(), ok = $2, note = $3 where id = $1`,
    [runId, rows.length, JSON.stringify(counts)]
  );

  console.log('\nwhere every product ended up:');
  for (const [state, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${state.padEnd(12)} ${n}`);
  }
  console.log(`\nbarcode conflicts recorded: ${conflictsWritten}`);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
