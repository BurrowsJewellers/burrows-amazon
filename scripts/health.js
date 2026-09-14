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
const config = require('../src/config');
const { request } = require('../src/amazon/client');
const { explain } = require('../src/amazon/listings');

const SELLER = config.amazon.sellerId;

/** Every listing on the account, straight from the Listings API. */
async function liveListings() {
  const out = [];
  let token = null;
  for (let page = 0; page < 500; page++) {
    const query = {
      marketplaceIds: config.amazon.marketplaceId,
      includedData: 'summaries,issues,offers',
      pageSize: 20,
      issueLocale: 'en_AU',
    };
    if (token) query.pageToken = token;

    const res = await request(`/listings/2021-08-01/items/${encodeURIComponent(SELLER)}`, { query });
    for (const item of res.items || []) {
      const s = (item.summaries || [])[0] || {};
      const status = Array.isArray(s.status) ? s.status : (s.status ? [s.status] : []);
      out.push({
        sku: item.sku,
        asin: s.asin || null,
        status,
        buyable: status.includes('BUYABLE'),
        issues: item.issues || [],
        price: (item.offers || [])[0]?.price?.amount ?? null,
        // Amazon takes a while to register a brand-new SKU's price and stock. Until it
        // has, there is no offer to buy — which is the usual reason a listing is
        // visible but not buyable, and nothing to worry about on the day it is sent.
        hasOffer: (item.offers || []).length > 0,
      });
    }
    token = res.pagination?.nextToken || null;
    if (!token) break;
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
