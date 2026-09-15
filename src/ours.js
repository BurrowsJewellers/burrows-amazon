'use strict';
/**
 * What we have put on Amazon — by either route.
 *
 * There are two, and forgetting the second is a mistake with teeth. Stage 1 sends an
 * offer against a page someone else authored and records it in `amazon_listings`.
 * Stage 2 authors the page itself and records it in `amazon_own_brand`. A job that
 * reads only the first is not merely missing some rows; it is wrong about what exists,
 * and every job here draws a conclusion from that:
 *
 *   the stock sync    left Stage 2 listings unguarded, so a one-of-a-kind piece sold
 *                     in the shop stayed on sale — the very thing it exists to prevent
 *   the audit         would call them strays, because they are on Amazon and not in
 *                     the table it was looking at, and its output feeds a removal step
 *   health, pricing   never examined them at all
 *
 * So the question "is this ours?" is answered in one place, and answered the same way
 * everywhere.
 */
const db = require('./db');

/** Every SKU we have put on Amazon, whichever route put it there. */
async function skus() {
  const { rows } = await db.query(`
    select sku from amazon_listings where last_pushed_at is not null
    union
    select sku from amazon_own_brand where state = 'listed'
  `);
  return rows.map((r) => r.sku);
}

/**
 * The same set, with the brand and the state a caller needs to judge it.
 *
 * Where a SKU exists on both sides the Stage 1 row wins: it carries the richer state,
 * and a listing must not be reasoned about twice.
 *
 * @returns {Promise<Map<string, {sku, vendor, state, route}>>}
 */
async function records() {
  const { rows } = await db.query(`
    select a.sku, a.vendor, a.state, 'stage1' as route
    from amazon_listings a
    where a.last_pushed_at is not null
    union all
    select o.sku, o.vendor, o.state, 'stage2' as route
    from amazon_own_brand o
    where o.state = 'listed'
      and not exists (select 1 from amazon_listings a
                       where a.sku = o.sku and a.last_pushed_at is not null)
  `);
  return new Map(rows.map((r) => [r.sku, r]));
}

module.exports = { skus, records };
