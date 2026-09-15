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
const { fetchBySku, quantityOf } = require('../src/amazon/inventory');
const { soldSince } = require('../src/amazon/orders');
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

  // Ask about our own SKUs rather than enumerating the account: the listings search
  // stops at 1,000 and gives no sign it has, so anything past that would silently stop
  // being watched — and the single pieces this protects are the tail of the catalogue.
  const onAmazon = await fetchBySku(rows.map((r) => r.sku), 'fulfillmentAvailability');

  // What has sold on Amazon recently, so a sale can be told apart from Amazon simply
  // holding a lower number. Fourteen days is comfortably longer than it takes the shop
  // to record a sale in Retail Edge, which is the gap this exists to cover.
  let sold = new Map();
  try {
    sold = await soldSince(new Date(Date.now() - 14 * 86400000));
  } catch (err) {
    // Without this we cannot safely raise a quantity, so say so rather than carry on
    // and quietly put sold stock back on sale.
    console.log('could not read recent orders: ' + String(err.message).slice(0, 140));
    console.log('refusing to raise any quantity this run — a sold item must not come back.');
    sold = null;
  }

  // Compare the store against Amazon itself. A SKU Amazon has not finished setting up
  // reports null rather than zero, and is left alone — re-sending a quantity it has not
  // processed yet only adds to the queue it is already working through.
  const needsChange = [];
  const heldBack = [];
  let settling = 0;
  let notOnAmazon = 0;
  for (const row of rows) {
    const item = onAmazon.get(row.sku);
    if (!item) { notOnAmazon++; continue; }
    const amazonQty = quantityOf(item);
    if (amazonQty === null) { settling++; continue; }

    // Stock is not the only reason something should come off sale. A product that has
    // fallen out of the states we list from — because the match is now in doubt, or a
    // rule caught it — is still sitting on Amazon with stock against it until someone
    // sets that to zero. Withdrawing it is this job's business too: it is the only
    // thing that talks to Amazon on a schedule.
    const weWouldList = row.state === 'listed' || row.state === 'ready';
    const want = weWouldList ? Math.max(0, row.live_qty) : 0;

    if (amazonQty === want) continue;

    // Raising a quantity is the only direction that can do harm, and there is one case
    // where it does real harm: Amazon takes stock down the moment something sells, and
    // the shop records that sale in Retail Edge some time later. In between, our figure
    // still shows the item in stock, and putting Amazon back up to it offers a piece
    // that is already sold and, for a one-off, already gone.
    //
    // The tell is that our own figure has not moved since we last sent it. If the shop
    // had recorded the sale our number would be lower; if we had genuinely restocked it
    // would be higher. Unchanged means the drop is Amazon's and we have not caught up.
    if (want > amazonQty) {
      if (!sold) { heldBack.push({ ...row, amazon_qty: amazonQty, want, why: 'recent orders unavailable' }); continue; }
      const sale = sold.get(row.sku);
      const ourFigureUnmoved = Number(row.live_qty) === Number(row.sent_qty);
      if (sale && sale.units >= want - amazonQty && ourFigureUnmoved) {
        heldBack.push({ ...row, amazon_qty: amazonQty, want,
          why: `sold ${sale.units} on Amazon (${sale.orders[0]}) and the shop has not recorded it yet` });
        continue;
      }
    }

    needsChange.push({ ...row, amazon_qty: amazonQty, want, withdrawn: !weWouldList });
  }

  // Sold out first, and in stock afterwards. If the run is interrupted half way, the
  // half that got done is the half that protects the account.
  const soldOut = needsChange.filter((r) => r.want === 0);
  const restock = needsChange.filter((r) => r.want > 0);
  const queue = [...soldOut, ...restock].slice(0, LIMIT || undefined);

  const withdrawing = needsChange.filter((r) => r.withdrawn).length;

  console.log(`${DRY ? '[dry run] ' : ''}${rows.length} sent, ${onAmazon.size} found on Amazon`);
  console.log(`  ${soldOut.length - withdrawing} have sold out and Amazon still shows them available`);
  if (withdrawing) console.log(`  ${withdrawing} we no longer intend to list and are coming off sale`);
  console.log(`  ${restock.length} have a quantity on Amazon that is not what we hold`);
  console.log(`  ${settling} are still being set up by Amazon and were left alone`);
  if (notOnAmazon) console.log(`  ${notOnAmazon} are not on Amazon at all`);
  if (heldBack.length) {
    console.log(`\n  ${heldBack.length} left alone rather than put back on sale:`);
    for (const h of heldBack.slice(0, 10)) {
      console.log(`    ${h.sku.padEnd(14)} Amazon has ${h.amazon_qty}, we still say ${h.want} — ${h.why}`);
    }
    console.log('    These correct themselves once the sale is recorded in Retail Edge.');
  }
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
      const why = row.withdrawn ? `   (withdrawing — ${row.state})`
                : quantity === 0 ? '   (sold out — comes off sale)'
                : row.amazon_qty === 0 ? '   (closed — would reopen)' : '';
      console.log(`  ${row.sku.padEnd(14)} Amazon has ${String(row.amazon_qty).padStart(3)}, we hold ${String(quantity).padStart(3)}${why}`);
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
