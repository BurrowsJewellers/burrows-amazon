#!/usr/bin/env node
'use strict';
/**
 * Reads back what Amazon actually holds and reports anything that should not be there.
 *
 * READ ONLY. This script removes nothing. It produces the list, and removal is a
 * separate, deliberate step against that explicit list — so the scope of any deletion
 * is something a person has seen before it happens.
 *
 * This is the backstop the brand ban depends on. Selection and the pre-flight check
 * both look at what we intend to send; only this looks at what Amazon actually has,
 * including anything added by hand or left over from an older tool.
 *
 * It enumerates rather than asking about our own SKUs, because the question here is
 * precisely "what is on Amazon that we have no record of" — which asking about our
 * records cannot answer.
 */
const fs = require('fs');
const db = require('../src/db');
const { enumerateAll, statusOf, quantityOf } = require('../src/amazon/inventory');
const { checkBrand } = require('../src/rules/brands');

const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] || '/tmp/amazon-strays.txt';

async function main() {
  const run = await db.query(`insert into amazon_runs (job) values ('audit') returning id`);
  const runId = run.rows[0].id;

  console.log('asking Amazon what it currently holds…');
  const { listings, truncated } = await enumerateAll('summaries,fulfillmentAvailability');
  console.log(`Amazon holds ${listings.size} listings\n`);

  if (truncated.length) {
    console.log(`!! ${truncated.length} time windows came back full even at their narrowest,`);
    console.log('   so this audit may be missing listings. Windows affected:');
    for (const w of truncated.slice(0, 5)) console.log(`     ${w}`);
    console.log('');
  }

  const ours = new Map(
    (await db.query('select sku, vendor, state from amazon_listings')).rows.map((r) => [r.sku, r])
  );
  const conflicts = new Set((await db.query('select sku from amazon_conflicts')).rows.map((r) => r.sku));

  const strays = [];
  let correct = 0;

  for (const [sku, item] of listings) {
    const mine = ours.get(sku);
    const qty = quantityOf(item);
    const onSale = qty === null ? false : qty > 0;
    let why = null;

    if (!mine) why = 'not in our records — listed by something other than this system';
    else if (!checkBrand({ vendor: mine.vendor }).allowed) why = `BANNED BRAND (${mine.vendor})`;
    else if (conflicts.has(sku)) why = 'barcode conflict — points at a different product';
    else if (mine.state !== 'listed' && mine.state !== 'ready') why = `we do not intend to list this (${mine.state})`;

    if (why) {
      strays.push({ sku, why, onSale, status: statusOf(item).join(',') });
    } else {
      correct++;
    }
  }

  // A stray nobody can buy is untidy. A stray with stock against it is selling.
  const selling = strays.filter((s) => s.onSale);

  console.log(`${correct} listings are ours and correct`);
  console.log(`${strays.length} should not be on Amazon, ${selling.length} of them with stock against them`);

  const banned = strays.filter((s) => s.why.startsWith('BANNED BRAND'));
  if (banned.length) {
    console.log(`\n!! ${banned.length} BANNED-BRAND listings are on the account !!`);
    for (const b of banned.slice(0, 15)) console.log(`   ${b.sku}  ${b.onSale ? 'ON SALE' : 'no stock'}`);
  }

  if (strays.length) {
    const byReason = {};
    for (const s of strays) {
      const key = s.why.replace(/\(.*\)/, '').trim();
      byReason[key] = (byReason[key] || 0) + 1;
    }
    console.log('\nby reason:');
    for (const [why, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${why}`);
    }
    // Only the ones actually on sale are worth acting on in a hurry.
    fs.writeFileSync(OUT, selling.map((s) => s.sku).join(',') + (selling.length ? '\n' : ''));
    console.log(`\n${selling.length} SKUs with stock written to ${OUT} — review before removing anything.`);
  } else {
    console.log('\nNothing to clean up. Amazon holds only what we intend.');
  }

  await db.query(
    'update amazon_runs set finished_at = now(), ok = $2, failed = $3, note = $4 where id = $1',
    [runId, correct, strays.length,
     JSON.stringify({ held: listings.size, selling: selling.length, banned: banned.length, truncated: truncated.length })]
  );
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
