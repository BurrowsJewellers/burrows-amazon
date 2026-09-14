#!/usr/bin/env node
'use strict';
/**
 * Asks Amazon what is wrong with the listings we have sent.
 *
 * Sending an offer successfully is not the same as having a live, buyable listing.
 * Amazon accepts the offer, then decides separately whether to show it — and when it
 * suppresses one it says why, but only if you ask. This asks, and records the answer
 * in words someone can act on, so the interface shows real problems rather than a
 * green tick that means nothing.
 *
 * Read-only against Amazon. Writes only to our own amazon_errors table.
 */
const db = require('../src/db');
const { explain } = require('../src/amazon/listings');
const { fetchBySku } = require('../src/amazon/inventory');

/**
 * Every listing we have sent, asked about by SKU.
 *
 * Not an enumeration of the account: Amazon's listings search stops at 1,000 results
 * and then simply stops offering a next page, with nothing to distinguish that from
 * having reached the end. Everything past the thousandth listing was invisible here,
 * which made every count this job reported an undercount.
 */
async function liveListings() {
  const { rows } = await db.query(
    'select sku from amazon_listings where last_pushed_at is not null order by sku');
  const found = await fetchBySku(rows.map((r) => r.sku), 'summaries,issues,offers,attributes');

  const out = [];
  for (const [, item] of found) {
    const s = (item.summaries || [])[0] || {};
    const status = Array.isArray(s.status) ? s.status : (s.status ? [s.status] : []);
    out.push({
      sku: item.sku,
      asin: s.asin || null,
      status,
      buyable: status.includes('BUYABLE'),
      issues: item.issues || [],
      // Amazon takes a while to register a brand-new SKU's price and stock. Until it
      // has, there is no offer to buy — which is the usual reason a listing is visible
      // but not buyable, and nothing to worry about on the day it is sent.
      hasOffer: (item.offers || []).length > 0,
      // The price we submitted, against the price Amazon is actually charging. These
      // disagree for a while after a push, and on a SKU that was listed before, the
      // price Amazon keeps showing in the meantime is the OLD one.
      submittedPrice: Number(
        item.attributes?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax
      ) || null,
      shownPrice: Number((item.offers || [])[0]?.price?.amount) || null,
    });
  }
  return out;
}

async function main() {
  const run = await db.query(`insert into amazon_runs (job) values ('health') returning id`);
  const runId = run.rows[0].id;

  const live = await liveListings();
  console.log(`Amazon holds ${live.length} listings\n`);

  const buyable = live.filter((l) => l.buyable).length;
  const noStatus = live.filter((l) => !l.status.length).length;
  console.log(`  buyable now:          ${buyable}`);
  console.log(`  visible, not buyable: ${live.length - buyable - noStatus}`);
  console.log(`  still settling:       ${noStatus}`);

  // Record what Amazon is doing with each offer, so the screen can tell "we sent it"
  // apart from "people can buy it" — they are not the same thing and the gap is where
  // the work is.
  for (const l of live) {
    await db.query(
      `update amazon_listings
          set listing_status = $2, buyable = $3, status_checked_at = now()
        where sku = $1`,
      [l.sku, l.status.join(',') || null, l.buyable]
    );
  }

  // Anything we recorded before that Amazon no longer complains about is closed off,
  // so the interface shows current problems rather than a growing pile of history.
  const stillBroken = new Set();
  let opened = 0;
  const byPlain = {};

  for (const l of live) {
    const errors = l.issues.filter((i) => i.severity === 'ERROR');
    for (const issue of errors) {
      stillBroken.add(l.sku);
      const { plain, fix } = explain(issue.code, issue.message);
      byPlain[plain] = (byPlain[plain] || 0) + 1;

      const existing = await db.query(
        `select id from amazon_errors
          where sku = $1 and code is not distinct from $2 and resolved_at is null limit 1`,
        [l.sku, issue.code || null]
      );
      if (!existing.rows.length) {
        await db.query(
          `insert into amazon_errors (sku, operation, code, message, plain, fix)
           values ($1, 'listing_health', $2, $3, $4, $5)`,
          [l.sku, issue.code || null, issue.message || null, plain, fix]
        );
        opened++;
      }
    }
  }

  const closed = await db.query(
    `update amazon_errors set resolved_at = now()
      where operation = 'listing_health' and resolved_at is null and not (sku = any($1))
      returning id`,
    [[...stillBroken]]
  );

  console.log(`\nlistings Amazon is unhappy with: ${stillBroken.size}`);
  for (const [plain, n] of Object.entries(byPlain).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${plain.slice(0, 110)}`);
  }
  console.log(`\n${opened} new problems recorded, ${closed.rowCount} previously recorded now resolved`);

  // Amazon always gets the full retail price — that is the rule. But a SKU that was
  // listed before keeps showing its previous price until Amazon ingests the new one,
  // and the previous price was often a discounted one. While that is true AND the
  // listing is buyable, someone can buy at the old price. That window is the thing
  // worth knowing about; a difference on a listing nobody can buy yet is just lag.
  const mispriced = live.filter(
    (l) => l.submittedPrice && l.shownPrice && Math.abs(l.submittedPrice - l.shownPrice) > 0.01
  );
  const sellingAtWrongPrice = mispriced.filter((l) => l.buyable && l.shownPrice < l.submittedPrice);

  // Recorded, not just printed. This runs from cron, and a discount nobody authorised
  // is exactly the thing that must not be sitting in a log file waiting to be noticed.
  for (const l of sellingAtWrongPrice) {
    const short = `Selling at $${l.shownPrice} when it should be $${l.submittedPrice}`;
    const existing = await db.query(
      `select id from amazon_errors
        where sku = $1 and operation = 'price_check' and resolved_at is null limit 1`,
      [l.sku]
    );
    if (!existing.rows.length) {
      await db.query(
        `insert into amazon_errors (sku, operation, code, message, plain, fix)
         values ($1, 'price_check', 'UNDERPRICED', $2, $3, $4)`,
        [l.sku, short,
         'On sale for less than the retail price we set',
         'Amazon is still charging the price these had under the old system, which was ' +
         'usually a shop sale price. It normally corrects itself within a few hours of the ' +
         'offer being sent. If it has not, re-send them with scripts/underpriced.js, which ' +
         'writes the current list ready for push.js --only=']
      );
    }
  }
  const pricesFixed = await db.query(
    `update amazon_errors set resolved_at = now()
      where operation = 'price_check' and resolved_at is null and not (sku = any($1))
      returning id`,
    [sellingAtWrongPrice.map((l) => l.sku)]
  );

  if (mispriced.length) {
    console.log(`\n${mispriced.length} listings show a different price than we sent`);
    if (sellingAtWrongPrice.length) {
      console.log(`  ${sellingAtWrongPrice.length} of those are BUYABLE BELOW our price right now:`);
      for (const l of sellingAtWrongPrice.slice(0, 10)) {
        console.log(`    ${l.sku.padEnd(14)} selling at $${l.shownPrice}, should be $${l.submittedPrice}`);
      }
      console.log('  Amazon has not taken the new price yet. If this persists past a day,');
      console.log('  re-send them: node scripts/push.js --only=' +
        sellingAtWrongPrice.slice(0, 5).map((l) => l.sku).join(','));
    } else {
      console.log('  none of them are buyable yet, so nobody can buy at the old price.');
    }
  }
  if (pricesFixed.rowCount) {
    console.log(`  ${pricesFixed.rowCount} previously underpriced listings are now at the right price`);
  }

  // A new SKU with no offer yet is normal for a few hours. A day later it is not: it
  // means the offer we sent never took, and nobody would otherwise notice, because the
  // push reported success and Amazon never says anything more about it.
  const noOffer = [...new Set(live.filter((l) => !l.hasOffer).map((l) => l.sku))];
  if (noOffer.length) {
    const stale = await db.query(
      `select sku from amazon_listings
        where sku = any($1) and last_pushed_at < now() - interval '24 hours'`,
      [noOffer]
    );
    console.log(`\n${noOffer.length} listings have no offer registered yet`);
    if (stale.rows.length) {
      console.log(`  ${stale.rows.length} of them were sent more than a day ago — that is too long.`);
      console.log('  Amazon accepted the offer but never registered the price and stock.');
      console.log('  Re-send these with: node scripts/push.js --only=' + stale.rows.slice(0, 5).map((r) => r.sku).join(','));
    } else {
      console.log('  all sent within the last day — Amazon is still working through them, which is normal.');
    }
  }

  await db.query(
    `update amazon_runs set finished_at = now(), ok = $2, failed = $3, note = $4 where id = $1`,
    [runId, live.length, stillBroken.size, JSON.stringify({ buyable, opened, closed: closed.rowCount, byPlain })]
  );
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
