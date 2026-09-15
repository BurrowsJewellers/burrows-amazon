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
const db = require('../src/db');
const { fetchBySku, statusOf } = require('../src/amazon/inventory');
const ours = require('../src/ours');

const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] || '/tmp/underpriced.txt';
const QUIET = process.argv.includes('--quiet');

async function main() {
  // Our own SKUs, not an enumeration of the account: the listings search stops at
  // 1,000 without saying so, and a listing selling below our price is exactly the
  // thing that must not fall off the end of a truncated list.
  const listings = await fetchBySku(await ours.skus(), 'summaries,offers,attributes');
  const under = [];

  for (const [sku, item] of listings) {
    const status = statusOf(item);
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
    await db.pool.end();
    return;
  }

  console.log(`${listings.size} listings checked`);
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
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
