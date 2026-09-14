#!/usr/bin/env node
'use strict';
/**
 * Sends offers to Amazon for everything in the ready state.
 *
 * Three things are re-checked immediately before each write, not just when the queue
 * was built: the brand, the barcode conflict, and the stock. A product can change
 * vendor, or be re-pointed at a different item on Amazon, or sell out, between being
 * queued and being sent — and the cost of getting any of those wrong is a customer
 * receiving the wrong ring.
 */
const db = require('../src/db');
const config = require('../src/config');
const { checkBrand } = require('../src/rules/brands');
const { amazonPrice } = require('../src/rules/pricing');
const { scoreMatch } = require('../src/match/confidence');
const { putOffer, readResult } = require('../src/amazon/listings');

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);
const DRY = process.argv.includes('--dry-run');

/**
 * --only=SKU,SKU re-sends named products, for the case where Amazon accepted an offer
 * but never registered it. Those sit in 'listed' rather than 'ready', so the normal
 * query would skip them — naming them explicitly is the whole point.
 */
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function recordError(row, err) {
  await db.query(
    `insert into amazon_errors (barcode, sku, operation, code, message, plain, fix)
     values ($1,$2,'offer_create',$3,$4,$5,$6)`,
    [row.barcode, row.sku, err.code || null, err.message || null, err.plain || null, err.fix || null]
  );
}

async function main() {
  if (!DRY && !config.channelEnabled) {
    console.log('AMAZON_CHANNEL_ENABLED is false — nothing will be sent. Use --dry-run to preview.');
    return;
  }
  if (!config.amazon.sellerId) {
    console.log('AMAZON_SELLER_ID is not set — cannot address listings.');
    return;
  }

  const run = await db.query(`insert into amazon_runs (job) values ('push') returning id`);
  const runId = run.rows[0].id;

  const { rows } = await db.query(`
    select a.barcode, a.sku, a.vendor, a.our_title, a.our_cost, a.asin,
           a.amazon_title, a.amazon_brand, a.qty,
           v.price as selling_price, v.compare_at_price, r.retail_price1, r.supplier_id
    from amazon_listings a
    join shopify_product_variants v on v.sku = a.sku
    left join retail_edge_products r on r.sku = a.sku
    where ${ONLY.length ? `a.sku = any($1) and a.state in ('ready','listed')` : `a.state = 'ready'`}
    order by a.vendor, a.sku
    ${LIMIT ? `limit ${LIMIT}` : ''}
  `, ONLY.length ? [ONLY] : []);

  console.log(`${DRY ? '[dry run] ' : ''}${rows.length} products queued${ONLY.length ? ` (of ${ONLY.length} named)` : ''}`);
  if (ONLY.length && rows.length < ONLY.length) {
    const found = new Set(rows.map((r) => r.sku));
    console.log(`  not found or not eligible: ${ONLY.filter((s) => !found.has(s)).join(', ')}`);
  }

  let sent = 0, failed = 0, pulled = 0;

  for (const row of rows) {
    // 1. The brand, again. Not because it changed a second ago, but because the one
    //    time it does is the time nobody checked.
    const brand = checkBrand({ vendor: row.vendor, supplierId: row.supplier_id });
    if (!brand.allowed) {
      await db.query(`update amazon_listings set state='blocked', state_reason=$2, updated_at=now() where barcode=$1`,
        [row.barcode, brand.reason]);
      pulled++;
      continue;
    }

    // 2. The match, again. Amazon can re-point a barcode at a different product.
    const scored = scoreMatch({
      sku: row.sku,
      ourVendor: row.vendor, ourTitle: row.our_title, ourPrice: Number(row.selling_price) || 0,
      amazonBrand: row.amazon_brand, amazonTitle: row.amazon_title, amazonPrice: 0,
    });
    if (scored.confidence !== 'high') {
      await db.query(
        `update amazon_listings set state=$2, state_reason=$3, confidence=$4, match_note=$3, updated_at=now() where barcode=$1`,
        [row.barcode, scored.confidence === 'conflict' ? 'conflict' : 'review', scored.note, scored.confidence]);
      pulled++;
      continue;
    }

    // 3. Stock, again.
    if (row.qty <= 0) {
      await db.query(`update amazon_listings set state='blocked', state_reason='out of stock everywhere', updated_at=now() where barcode=$1`,
        [row.barcode]);
      pulled++;
      continue;
    }

    // Amazon is charged the retail price. Store discounts are not passed on.
    const { price, basis } = amazonPrice({
      sellingPrice: row.selling_price,
      compareAtPrice: row.compare_at_price,
      retailTicketPrice: row.retail_price1,
    });

    if (DRY) {
      console.log(`  ${row.sku.padEnd(14)} ${String(row.asin).padEnd(12)} $${price.toFixed(2).padStart(8)} x${row.qty}  ${basis}`);
      sent++;
      continue;
    }

    try {
      const response = await putOffer({ sku: row.sku, asin: row.asin, price, quantity: row.qty });
      const result = readResult(response);

      if (result.ok) {
        await db.query(
          `update amazon_listings set state='listed', state_reason=$2, amazon_price=$3, amazon_qty=$4,
             last_pushed_at=now(), updated_at=now() where barcode=$1`,
          [row.barcode, basis, price, row.qty]);
        sent++;
      } else {
        for (const e of result.errors) await recordError(row, e);
        await db.query(`update amazon_listings set state='failed', state_reason=$2, updated_at=now() where barcode=$1`,
          [row.barcode, result.errors[0].plain]);
        failed++;
      }
    } catch (err) {
      await recordError(row, { message: err.message, plain: 'The request to Amazon failed', fix: 'Usually temporary. It retries on the next run.' });
      await db.query(`update amazon_listings set state='failed', state_reason=$2, updated_at=now() where barcode=$1`,
        [row.barcode, err.message.slice(0, 200)]);
      failed++;
    }

    if ((sent + failed) % 50 === 0) console.log(`  ${sent + failed}/${rows.length} — ${sent} listed, ${failed} failed`);
    await new Promise((r) => setTimeout(r, 250));
  }

  await db.query(`update amazon_runs set finished_at=now(), ok=$2, failed=$3, skipped=$4 where id=$1`,
    [runId, sent, failed, pulled]);
  console.log(`\n${DRY ? 'would send' : 'sent'} ${sent}, failed ${failed}, pulled back before sending ${pulled}`);
  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
