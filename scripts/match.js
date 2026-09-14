#!/usr/bin/env node
'use strict';
/**
 * Looks barcodes up in Amazon's catalogue.
 *
 * This is the step that decides whether a product can be listed at all, and it is
 * barcode-only by instruction: titles have matched the wrong product before and cost
 * real refunds, so a product Amazon does not carry under our exact barcode is simply
 * not listed. Nothing here guesses.
 *
 * Read-only against Amazon — it only reads the catalogue. It writes to our own
 * amazon_catalog_matches table, which the populate pass then turns into decisions.
 *
 * Two kinds of work:
 *   new     barcodes never looked up — a product added to the store since last time
 *   recheck barcodes Amazon did not have a while ago, in case it carries them now
 */
const db = require('../src/db');
const { lookupByBarcode, summarise } = require('../src/amazon/client');
const { isValidGtin } = require('../src/match/gtin');
const { checkBrand } = require('../src/rules/brands');

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);
/** How long a "Amazon does not have this" answer is trusted before asking again. */
const RECHECK_AFTER_DAYS = Number(
  process.argv.find((a) => a.startsWith('--recheck-after='))?.split('=')[1] || 30
);

async function main() {
  const run = await db.query(`insert into amazon_runs (job) values ('match') returning id`);
  const runId = run.rows[0].id;

  // Only barcodes worth spending a lookup on: a real GTIN, in stock, and not a brand
  // we are never allowed to list. Checking a banned brand against Amazon would be
  // harmless but pointless, and it is a lot of pointless.
  const { rows } = await db.query(`
    select distinct on (trim(v.barcode))
           trim(v.barcode)        as barcode,
           v.sku                  as sku,
           coalesce(p.vendor, '') as vendor,
           coalesce(p.title, '')  as our_title,
           v.price::numeric       as our_price,
           r.supplier_id          as supplier_id,
           coalesce((select sum(l.available)::int from shopify_inventory_levels l
                      where l.inventory_item_id = v.inventory_item_id), 0) as qty,
           m.match_state, m.checked_at
    from shopify_product_variants v
    left join shopify_products p on p.product_id = v.product_id
    left join retail_edge_products r on r.sku = v.sku
    left join amazon_catalog_matches m on m.barcode = trim(v.barcode)
    where v.variant_id is not null
      and v.barcode is not null and trim(v.barcode) <> ''
      and (
        m.barcode is null
        or (m.match_state = 'miss' and m.checked_at < now() - ($1 || ' days')::interval)
      )
    order by trim(v.barcode), v.sku
  `, [String(RECHECK_AFTER_DAYS)]);

  const worth = rows.filter((r) => {
    if (!isValidGtin(r.barcode)) return false;
    if (r.qty <= 0) return false;
    return checkBrand({ vendor: r.vendor, supplierId: r.supplier_id }).allowed;
  });

  const queue = LIMIT ? worth.slice(0, LIMIT) : worth;
  const fresh = queue.filter((r) => !r.match_state).length;

  console.log(`${rows.length} barcodes need looking at, ${worth.length} worth a lookup`);
  console.log(`  ${fresh} never looked up before`);
  console.log(`  ${queue.length - fresh} were a miss more than ${RECHECK_AFTER_DAYS} days ago`);
  if (!queue.length) {
    console.log('\nNothing to look up. Every listable barcode has an answer.');
    await db.query('update amazon_runs set finished_at = now() where id = $1', [runId]);
    await db.pool.end();
    return;
  }

  let hits = 0, misses = 0, newlyFound = 0;

  // Twenty per call is Amazon's limit, and the reason a full pass takes minutes.
  for (let i = 0; i < queue.length; i += 20) {
    const batch = queue.slice(i, i + 20);
    let found;
    try {
      found = await lookupByBarcode(batch.map((r) => r.barcode));
    } catch (err) {
      console.log(`  batch failed, skipping: ${String(err.message).slice(0, 120)}`);
      continue;
    }

    for (const row of batch) {
      const item = found.get(row.barcode);
      const wasMiss = row.match_state === 'miss';

      if (item) {
        const s = summarise(item);
        hits++;
        if (wasMiss) newlyFound++;
        await db.query(`
          insert into amazon_catalog_matches
            (barcode, sku, vendor, our_title, our_price, qty, asin, amazon_title,
             amazon_brand, match_state, checked_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'hit', now())
          on conflict (barcode) do update set
            sku = excluded.sku, vendor = excluded.vendor, our_title = excluded.our_title,
            our_price = excluded.our_price, qty = excluded.qty, asin = excluded.asin,
            amazon_title = excluded.amazon_title, amazon_brand = excluded.amazon_brand,
            match_state = 'hit', checked_at = now()`,
          [row.barcode, row.sku, row.vendor, row.our_title, row.our_price, row.qty,
           s.asin, s.title, s.brand]);
      } else {
        misses++;
        await db.query(`
          insert into amazon_catalog_matches
            (barcode, sku, vendor, our_title, our_price, qty, match_state, checked_at)
          values ($1,$2,$3,$4,$5,$6,'miss', now())
          on conflict (barcode) do update set
            sku = excluded.sku, vendor = excluded.vendor, our_title = excluded.our_title,
            our_price = excluded.our_price, qty = excluded.qty,
            match_state = 'miss', checked_at = now()`,
          [row.barcode, row.sku, row.vendor, row.our_title, row.our_price, row.qty]);
      }
    }

    const done = Math.min(i + 20, queue.length);
    if (done % 200 === 0 || done === queue.length) {
      console.log(`  ${done}/${queue.length} — ${hits} on Amazon, ${misses} not`);
    }
  }

  console.log(`\n${hits} barcodes Amazon carries, ${misses} it does not`);
  if (newlyFound) console.log(`${newlyFound} of the hits were misses before — Amazon carries them now`);

  await db.query(
    'update amazon_runs set finished_at = now(), ok = $2, skipped = $3, note = $4 where id = $1',
    [runId, hits, misses, JSON.stringify({ fresh, rechecked: queue.length - fresh, newlyFound })]
  );
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
