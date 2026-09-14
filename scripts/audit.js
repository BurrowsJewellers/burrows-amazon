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
 */
const fs = require('fs');
const db = require('../src/db');
const config = require('../src/config');
const { request } = require('../src/amazon/client');
const { checkBrand } = require('../src/rules/brands');

const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] || '/tmp/amazon-strays.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchLiveListings() {
  const created = await request('/reports/2021-06-30/reports', {
    method: 'POST',
    allowWrite: true, // requests a report; writes nothing to the catalogue
    body: { reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA', marketplaceIds: [config.amazon.marketplaceId] },
  });

  let doc = null;
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const status = await request(`/reports/2021-06-30/reports/${created.reportId}`);
    if (['DONE', 'FATAL', 'CANCELLED'].includes(status.processingStatus)) { doc = status.reportDocumentId; break; }
  }
  if (!doc) throw new Error('Amazon did not finish the listings report in time');

  const meta = await request(`/reports/2021-06-30/documents/${doc}`);
  const res = await fetch(meta.url);
  let text;
  if (meta.compressionAlgorithm === 'GZIP') {
    text = require('zlib').gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  } else {
    text = await res.text();
  }
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [header[i], v])));
}

async function main() {
  console.log('asking Amazon what it currently holds…');
  const live = await fetchLiveListings();
  console.log(`Amazon holds ${live.length} listings\n`);

  const ours = new Map(
    (await db.query('select sku, vendor, state from amazon_listings')).rows.map((r) => [r.sku, r])
  );
  const conflicts = new Set((await db.query('select sku from amazon_conflicts')).rows.map((r) => r.sku));

  const strays = [];
  let correct = 0;

  for (const listing of live) {
    const sku = (listing['seller-sku'] || '').trim();
    if (!sku) continue;
    const mine = ours.get(sku);
    let why = null;

    if (!mine) why = 'not in our records — listed by something other than this system';
    else if (!checkBrand({ vendor: mine.vendor }).allowed) why = `BANNED BRAND (${mine.vendor})`;
    else if (conflicts.has(sku)) why = 'barcode conflict — points at a different product';
    else if (mine.state !== 'listed') why = `we do not intend to list this (state: ${mine.state})`;

    if (why) strays.push({ sku, why, title: (listing['item-name'] || '').slice(0, 60) });
    else correct++;
  }

  console.log(`${correct} listings are ours and correct`);
  console.log(`${strays.length} should not be on Amazon`);

  const banned = strays.filter((s) => s.why.startsWith('BANNED BRAND'));
  if (banned.length) {
    console.log(`\n!! ${banned.length} BANNED-BRAND listings are live on the account !!`);
    for (const b of banned.slice(0, 15)) console.log(`   ${b.sku}  ${b.title}`);
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
    fs.writeFileSync(OUT, strays.map((s) => s.sku).join('\n') + '\n');
    console.log(`\nSKUs written to ${OUT} — review that list before removing anything.`);
  } else {
    console.log('\nNothing to clean up. Amazon holds only what we intend.');
  }

  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
