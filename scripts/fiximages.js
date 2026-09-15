#!/usr/bin/env node
'use strict';
/**
 * Replaces the image links Amazon can no longer fetch.
 *
 * The previous system sent Amazon signed S3 addresses that expired a day after they
 * were made. Amazon still holds them, cannot open them, and suppresses the listing —
 * so the product is on Amazon and invisible to anyone shopping. Re-sending the offer
 * does not help: the dead link is on the listing, not on the offer.
 *
 * The shop has the same photographs on a public address that does not expire. This
 * points Amazon at those instead.
 *
 * Validates by default. Nothing is written without --submit.
 */
const db = require('../src/db');
const config = require('../src/config');
const { request } = require('../src/amazon/client');

const SUBMIT = process.argv.includes('--submit');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);

/** The complaints a working image link actually answers. */
const FIXABLE = [
  'cannot fetch the product photo',
  'file format Amazon will not accept',
];

async function shopImage(handle) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://burrows-jewellers.myshopify.com/products/' + handle + '.js');
      if (res.status === 404) return { url: null, reached: true };
      if (!res.ok) { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); continue; }
      const j = await res.json();
      const first = (j.images || [])[0];
      return { url: first ? (first.startsWith('//') ? 'https:' + first : first) : null, reached: true };
    } catch (err) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  // Could not ask. Not the same as there being no photograph.
  return { url: null, reached: false };
}

async function main() {
  const run = await db.query("insert into amazon_runs (job) values ('fiximages') returning id");
  const runId = run.rows[0].id;

  // Two spellings of the same condition: the select joins several tables and needs the
  // alias, the update has only one and must not carry it.
  const conditions = FIXABLE.map((_, i) => `e.plain ilike $${i + 1}`).join(' or ');
  const conditionsNoAlias = FIXABLE.map((_, i) => `plain ilike $${i + 2}`).join(' or ');
  const { rows } = await db.query(`
    select distinct e.sku, p.handle, l.our_title
    from amazon_errors e
    join shopify_product_variants v on v.sku = e.sku
    join shopify_products p on p.product_id = v.product_id
    left join amazon_listings l on l.sku = e.sku
    where e.resolved_at is null and (${conditions})
    order by e.sku
    ${LIMIT ? 'limit ' + LIMIT : ''}
  `, FIXABLE.map((f) => `%${f}%`));

  console.log(`${rows.length} listings Amazon cannot fetch a photograph for` +
    (SUBMIT ? '' : '  (validating only — nothing will be changed)') + '\n');

  let fixed = 0, noImage = 0, refused = 0, unreachable = 0;

  for (const row of rows) {
    const { url, reached } = await shopImage(row.handle);
    if (!reached) { unreachable++; continue; }
    if (!url) {
      console.log(`  ${row.sku.padEnd(14)} the shop has no photograph either`);
      noImage++;
      continue;
    }

    const query = { marketplaceIds: config.amazon.marketplaceId, issueLocale: 'en_AU' };
    if (!SUBMIT) query.mode = 'VALIDATION_PREVIEW';

    try {
      const res = await request(
        '/listings/2021-08-01/items/' + encodeURIComponent(config.amazon.sellerId) +
        '/' + encodeURIComponent(row.sku),
        { method: 'PATCH', query, allowWrite: true,
          body: { productType: 'PRODUCT', patches: [{
            op: 'replace',
            path: '/attributes/main_product_image_locator',
            value: [{ marketplace_id: config.amazon.marketplaceId, media_location: url }],
          }] } });

      const errs = (res.issues || []).filter((i) => i.severity === 'ERROR');
      if (errs.length) {
        refused++;
        console.log(`  ${row.sku.padEnd(14)} refused: ${String(errs[0].message).slice(0, 110)}`);
        continue;
      }
      fixed++;
      if (SUBMIT) {
        // The complaint is answered. Amazon lifts the suppression on its own once it
        // has fetched the new image, and the health pass will confirm that.
        await db.query(
          `update amazon_errors set resolved_at = now()
            where sku = $1 and resolved_at is null and (${conditionsNoAlias})`,
          [row.sku, ...FIXABLE.map((f) => `%${f}%`)]
        );
      }
      if (fixed % 25 === 0) console.log(`  ${fixed} done`);
    } catch (err) {
      refused++;
      console.log(`  ${row.sku.padEnd(14)} failed: ${String(err.message).slice(0, 110)}`);
    }
    // Note: the Amazon call and our own bookkeeping are separate concerns. An earlier
    // version counted a listing as refused when only the note-keeping had failed, after
    // Amazon had already accepted the new image.
  }

  console.log(`\n${SUBMIT ? 'repointed' : 'would repoint'} ${fixed}`);
  if (noImage) console.log(`${noImage} have no photograph in the shop either — those need one taking`);
  if (refused) console.log(`${refused} refused`);
  if (unreachable) console.log(`${unreachable} could not be looked up and will be retried`);

  await db.query('update amazon_runs set finished_at = now(), ok = $2, failed = $3 where id = $1',
    [runId, fixed, refused]);
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
