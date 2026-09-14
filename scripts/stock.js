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
const { setQuantity, readResult } = require('../src/amazon/listings');
const { checkBrand } = require('../src/rules/brands');

const DRY = process.argv.includes('--dry-run');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);

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

  // Sold out first, and in stock afterwards. If the run is interrupted half way, the
  // half that got done is the half that protects the account.
  const soldOut = rows.filter((r) => r.live_qty <= 0 && r.sent_qty > 0);
  const changed = rows.filter((r) => r.live_qty > 0 && r.live_qty !== r.sent_qty);
  const queue = [...soldOut, ...changed].slice(0, LIMIT || undefined);

  console.log(`${DRY ? '[dry run] ' : ''}${rows.length} listings on Amazon`);
  console.log(`  ${soldOut.length} have sold out and are still showing as available`);
  console.log(`  ${changed.length} have a different quantity than we last sent`);
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
    const quantity = brand.allowed ? Math.max(0, row.live_qty) : 0;
    if (!brand.allowed) {
      banned++;
      console.log(`  !! ${row.sku} is ${row.vendor} — ${brand.reason}. Taking it down.`);
    }

    if (DRY) {
      console.log(`  ${row.sku.padEnd(14)} ${String(row.sent_qty).padStart(3)} -> ${String(quantity).padStart(3)}${quantity === 0 ? '   (comes off sale)' : ''}`);
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
    [runId, ok, failed, JSON.stringify({ soldOut: soldOut.length, changed: changed.length, banned })]
  );
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
