#!/usr/bin/env node
'use strict';
/**
 * Is anything on Amazon buyable for less than we said it should be?
 *
 * Amazon always gets the full retail price — shop discounts are not passed to a
 * marketplace that takes a referral fee off the top. But Amazon ingests a new price
 * some time after accepting it, and a SKU that was listed before keeps charging its
 * previous price until then. Where that previous price was a sale price and the
 * listing is already buyable, we are selling at a discount nobody authorised.
 *
 * Read-only. Prints the SKUs and writes them where `push.js --only=` can read them,
 * so correcting it is a separate, deliberate step.
 */
const fs = require('fs');
const config = require('../src/config');
const { request } = require('../src/amazon/client');

const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] || '/tmp/underpriced.txt';
const QUIET = process.argv.includes('--quiet');

async function everyListing() {
  const seen = new Map();
  let token = null;
  for (let page = 0; page < 500; page++) {
    const query = {
      marketplaceIds: config.amazon.marketplaceId,
      includedData: 'summaries,offers,attributes',
      pageSize: 20,
    };
    if (token) query.pageToken = token;
    const res = await request(
      `/listings/2021-08-01/items/${encodeURIComponent(config.amazon.sellerId)}`, { query });
    // Keyed by SKU: Amazon's paging can repeat one across two pages.
    for (const item of res.items || []) seen.set(item.sku, item);
    token = res.pagination?.nextToken || null;
    if (!token) break;
  }
  return seen;
}

async function main() {
  const listings = await everyListing();
  const under = [];

  for (const [sku, item] of listings) {
    const summary = (item.summaries || [])[0] || {};
    const status = Array.isArray(summary.status) ? summary.status : [summary.status].filter(Boolean);
    const sent = Number(item.attributes?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax) || null;
    const shown = Number((item.offers || [])[0]?.price?.amount) || null;
    // Only a buyable listing is a problem. A price that disagrees on something nobody
    // can buy yet is Amazon still catching up, and it corrects itself.
    if (status.includes('BUYABLE') && sent && shown && shown < sent - 0.01) {
      under.push({ sku, sent, shown, under: sent - shown });
    }
  }
  under.sort((a, b) => b.under - a.under);

  fs.writeFileSync(OUT, under.map((u) => u.sku).join(',') + (under.length ? '\n' : ''));

  if (QUIET) {
    console.log(`${under.length} buyable below our price`);
    return;
  }

  console.log(`${listings.size} distinct listings on Amazon`);
  console.log(`${under.length} buyable below the price we set\n`);
  for (const u of under) {
    console.log(`  ${u.sku.padEnd(14)} showing $${String(u.shown).padStart(8)}  should be $${String(u.sent).padStart(8)}   $${u.under.toFixed(2)} under`);
  }
  if (under.length) {
    console.log(`\nif every one sold at that price we would be $${under.reduce((t, u) => t + u.under, 0).toFixed(2)} short`);
    console.log(`correct them with: node scripts/push.js --only=$(cat ${OUT})`);
  } else {
    console.log('Everything buyable is at the price we set.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
