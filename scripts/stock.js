#!/usr/bin/env node
'use strict';
/**
 * Keeps the quantity on Amazon in step with the quantity we actually hold.
 *
 * This is the job that makes listing one-of-a-kind pieces safe. A single piece can
 * sell over the counter and still show as available on Amazon, and cancelling an
 * Amazon order is the thing that damages the account — far more than never having
 * listed the piece at all. So stock going to zero is the urgent direction, and it is
 * done first.
 *
 * Works from `last_pushed_at`, not from the listing's state. Anything we have ever
 * sent to Amazon is Amazon's until we say otherwise: a product that sold out is moved
 * to `blocked` by the populate pass, and if this job only looked at `listed` rows it
 * would stop watching the very listings most in need of being taken down.
 */
const db = require('../src/db');
const config = require('../src/config');
const { request } = require('../src/amazon/client');
const { setQuantity, readResult } = require('../src/amazon/listings');
const { checkBrand } = require('../src/rules/brands');

const DRY = process.argv.includes('--dry-run');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);

/**
 * What Amazon actually holds, by SKU — not what we believe we sent.
 *
 * Comparing our own record against the store would miss the case that matters most:
 * Amazon quietly dropping a quantity to zero on its own. Thirteen listings were sitting
 * closed that way while we held stock, and nothing would have noticed, because our
 * record and the store agreed with each other and neither had been asked.
 *
 * Returns null for a SKU Amazon has not finished setting up, which is not the same as
 * zero and must not be corrected as though it were.
 */
async function quantitiesOnAmazon() {
  const held = new Map();
  let token = null;
  for (let page = 0; page < 500; page++) {
    const query = {
      marketplaceIds: config.amazon.marketplaceId,
      includedData: 'fulfillmentAvailability',
      pageSize: 20,
    };
    if (token) query.pageToken = token;
    const res = await request(
      `/listings/2021-08-01/items/${encodeURIComponent(config.amazon.sellerId)}`, { query });
    for (const item of res.items || []) {
      const fa = item.fulfillmentAvailability || [];
      // An entry can exist with no quantity on it. That is "not set yet", the same as
      // having no entry — and emphatically not zero, which would read as sold out.
      const qty = fa.length ? Number(fa[0].quantity) : null;
      held.set(item.sku, Number.isFinite(qty) ? qty : null);
    }
    token = res.pagination?.nextToken || null;
    if (!token) break;
  }
  return held;
}

async function main() {
  if (!DRY && !config.channelEnabled) {
    console.log('AMAZON_CHANNEL_ENABLED is false — nothing will be sent. Use --dry-run to preview.');
    return;
  }

  const run = await db.query(`insert into amazon_runs (job) values ('stock') returning id`);
  const runId = run.rows[0].id;

  // The live figure comes from the Shopify mirror, the same place the listing decision
  // came from, so the two can never disagree about what "in stock" means.
  const { rows } = await db.query(`
    select a.sku, a.vendor, a.qty as sent_qty, a.state, r.supplier_id,
           coalesce((select sum(l.available)::int from shopify_inventory_levels l
                      where l.inventory_item_id = v.inventory_item_id), 0) as live_qty
    from amazon_listings a
    join shopify_product_variants v on v.sku = a.sku
    left join retail_edge_products r on r.sku = a.sku
    where a.last_pushed_at is not null
    order by a.sku
  `);

  const onAmazon = await quantitiesOnAmazon();

  // Compare the store against Amazon itself. A SKU Amazon has not finished setting up
  // reports null rather than zero, and is left alone — re-sending a quantity it has not
  // processed yet only adds to the queue it is already working through.
  const needsChange = [];
  let settling = 0;
  for (const row of rows) {
    const amazonQty = onAmazon.has(row.sku) ? onAmazon.get(row.sku) : undefined;
    if (amazonQty === undefined) continue;       // not on Amazon at all
    if (amazonQty === null) { settling++; continue; }
    const want = Math.max(0, row.live_qty);
    if (amazonQty !== want) needsChange.push({ ...row, amazon_qty: amazonQty, want });
  }

  // Sold out first, and in stock afterwards. If the run is interrupted half way, the
  // half that got done is the half that protects the account.
  const soldOut = needsChange.filter((r) => r.want === 0);
  const restock = needsChange.filter((r) => r.want > 0);
  const queue = [...soldOut, ...restock].slice(0, LIMIT || undefined);

  console.log(`${DRY ? '[dry run] ' : ''}${onAmazon.size} listings on Amazon, ${rows.length} in our records`);
  console.log(`  ${soldOut.length} have sold out and Amazon still shows them available`);
  console.log(`  ${restock.length} have a quantity on Amazon that is not what we hold`);
  console.log(`  ${settling} are still being set up by Amazon and were left alone`);
  if (!queue.length) {
    console.log('\nNothing to change. Amazon matches what we hold.');
    await db.query(`update amazon_runs set finished_at = now() where id = $1`, [runId]);
    await db.pool.end();
    return;
  }
  console.log('');

  let ok = 0, failed = 0, banned = 0;

  for (const row of queue) {
    // The brand ban, immediately before a write, as everywhere else. A banned brand
    // that has somehow reached Amazon gets taken down rather than merely reported.
    const brand = checkBrand({ vendor: row.vendor, supplierId: row.supplier_id });
    const quantity = brand.allowed ? row.want : 0;
    if (!brand.allowed) {
      banned++;
      console.log(`  !! ${row.sku} is ${row.vendor} — ${brand.reason}. Taking it down.`);
    }

    if (DRY) {
      console.log(`  ${row.sku.padEnd(14)} Amazon has ${String(row.amazon_qty).padStart(3)}, we hold ${String(quantity).padStart(3)}` +
                  `${quantity === 0 ? '   (comes off sale)' : row.amazon_qty === 0 ? '   (closed — would reopen)' : ''}`);
      ok++;
      continue;
    }

    try {
      const res = await setQuantity({ sku: row.sku, quantity });
      const result = readResult(res);
      if (!result.ok) {
        failed++;
        const first = result.errors[0];
        await db.query(
          `insert into amazon_errors (sku, operation, code, message, plain, fix)
           values ($1, 'qty_push', $2, $3, $4, $5)`,
          [row.sku, first.code || null, first.message || null, first.plain, first.fix]
        );
        console.log(`  ${row.sku} refused: ${first.plain}`);
        continue;
      }
      await db.query(
        `update amazon_listings set qty = $2, updated_at = now() where sku = $1`,
        [row.sku, quantity]
      );
      ok++;
      if (ok % 50 === 0) console.log(`  ${ok}/${queue.length} updated`);
    } catch (err) {
      failed++;
      console.log(`  ${row.sku} failed: ${String(err.message).slice(0, 120)}`);
    }
  }

  console.log(`\n${DRY ? 'would update' : 'updated'} ${ok}, failed ${failed}`);
  if (banned) console.log(`${banned} banned-brand listings were taken off sale — find out how they got there.`);

  await db.query(
    `update amazon_runs set finished_at = now(), ok = $2, failed = $3, note = $4 where id = $1`,
    [runId, ok, failed, JSON.stringify({ soldOut: soldOut.length, restock: restock.length, settling, banned })]
  );
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
