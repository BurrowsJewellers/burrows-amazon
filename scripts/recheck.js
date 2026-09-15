#!/usr/bin/env node
'use strict';
/**
 * Re-checks products we recorded as absent from Amazon's catalogue.
 *
 * Stage 2 kept refusing to author pages because Amazon said it already had the barcode
 * — which means our own catalogue lookup was wrong about them. Those products do not
 * need a page written; they need an offer against the listing Amazon already has, and
 * that is Stage 1's job.
 *
 * Read-only against Amazon: it looks barcodes up and records what it finds. The
 * populate pass then moves anything found into the queue, and push sends the offer.
 */
const db = require('../src/db');
const { lookupByBarcode, summarise } = require('../src/amazon/client');
const { isValidGtin } = require('../src/match/gtin');
const { checkBrand } = require('../src/rules/brands');

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);
const BRANDS = (process.argv.find((a) => a.startsWith('--brands='))?.split('=')[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  const run = await db.query("insert into amazon_runs (job) values ('recheck') returning id");
  const runId = run.rows[0].id;

  const params = [];
  let brandFilter = '';
  if (BRANDS.length) {
    params.push(BRANDS);
    brandFilter = `and a.vendor = any($${params.length})`;
  }

  const { rows } = await db.query(`
    select a.barcode, a.sku, a.vendor, a.our_title, a.our_price, a.qty
    from amazon_listings a
    where a.state = 'no_match' and a.qty > 0
      ${brandFilter}
    order by a.vendor, a.sku
    ${LIMIT ? 'limit ' + LIMIT : ''}
  `, params);

  const worth = rows.filter((r) => isValidGtin(r.barcode) && checkBrand({ vendor: r.vendor }).allowed);
  console.log(`${rows.length} recorded as absent from Amazon; ${worth.length} worth asking about again\n`);

  let hits = 0, misses = 0;
  const byBrand = {};

  for (let i = 0; i < worth.length; i += 20) {
    const batch = worth.slice(i, i + 20);
    let found;
    try {
      found = await lookupByBarcode(batch.map((r) => r.barcode));
    } catch (err) {
      console.log(`  a batch failed, skipping: ${String(err.message).slice(0, 100)}`);
      continue;
    }

    for (const row of batch) {
      const item = found.get(row.barcode);
      if (!item) { misses++; continue; }

      const s = summarise(item);
      hits++;
      byBrand[row.vendor] = (byBrand[row.vendor] || 0) + 1;
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
    }

    const done = Math.min(i + 20, worth.length);
    if (done % 200 === 0 || done === worth.length) {
      console.log(`  ${done}/${worth.length} — ${hits} Amazon does carry after all`);
    }
  }

  console.log(`\n${hits} were on Amazon all along, ${misses} genuinely are not`);
  if (hits) {
    console.log('\nby brand:');
    for (const [b, n] of Object.entries(byBrand).sort((a, b2) => b2[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${b}`);
    }
    console.log('\nRun populate then push to turn these into offers.');
  }

  await db.query('update amazon_runs set finished_at = now(), ok = $2, skipped = $3 where id = $1',
    [runId, hits, misses]);
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
