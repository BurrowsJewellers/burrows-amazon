#!/usr/bin/env node
'use strict';
/**
 * Stage 2 — listing our own pieces by creating the product page.
 *
 * Stage 1 can only offer against a product Amazon already carries. This is the other
 * route: authoring the page ourselves.
 *
 * It began limited to brands we make, on the assumption that Amazon would refuse to let
 * us author anyone else's. Tested against the live API on 15 Sep 2026, that assumption
 * was wrong — of every brand we stock, not one was refused. What keeps those products
 * off Amazon is gaps in our own data, not permission. So this covers the catalogue, and
 * the two cases differ only in the product identifier: our own pieces have never had a
 * barcode and claim the exemption, everything else supplies its real one.
 *
 * It asks Amazon to validate every piece before anything is created, and by default
 * that is all it does. Validation costs nothing and changes nothing, but tells us per
 * piece whether our data is good enough — so fixing data can start long before the
 * brand approval that lets any of it go live.
 *
 * Nothing is created unless --submit is passed AND the channel is switched on.
 */
const db = require('../src/db');
const config = require('../src/config');
const { request } = require('../src/amazon/client');
const { buildListing } = require('../src/stage2/attributes');
const { checkBrand } = require('../src/rules/brands');
const { isValidGtin } = require('../src/match/gtin');
const { toAmazonSize } = require('../src/stage2/ringsize');

const SUBMIT = process.argv.includes('--submit');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0);
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OWN_ONLY = process.argv.includes('--own-brand-only');

/**
 * Brands we make ourselves. These are the ones with no barcode, so they are the ones
 * that need the identifier exemption — everything else carries a real one.
 */
const OWN_BRANDS = ['burrows collection', 'burrows jewellers'];

/**
 * Other people's brands were left out of this at first, on the assumption that Amazon
 * would refuse to let us author their pages. Tested against the live API on 15 Sep
 * 2026 and that assumption was wrong: of every brand we stock, not one was refused.
 * What stops those products is our own data, not Amazon's permission — so they belong
 * in this pass, where the gaps get measured instead of assumed.
 *
 * The brand ban still applies, and is applied explicitly here rather than relied upon
 * as a side effect of the old filter.
 */

/**
 * Photographs, from the shop's own public product feed.
 *
 * The store mirror keeps only a count, and Amazon needs a URL it can fetch itself. The
 * public feed needs no credentials, which keeps this job from depending on a token
 * that can expire without anyone noticing.
 */
async function photosFor(handle) {
  try {
    const res = await fetch('https://burrows-jewellers.myshopify.com/products/' + handle + '.js');
    if (!res.ok) return { images: [], description: '' };
    const j = await res.json();
    const images = (j.images || []).map((u) => (u.startsWith('//') ? 'https:' + u : u));
    const description = String(j.description || '')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { images, description };
  } catch (err) {
    return { images: [], description: '' };
  }
}

const UPSERT = [
  'insert into amazon_own_brand',
  ' (sku, vendor, title, description, price, qty, product_type, amazon_type, metal, stone,',
  '  colour, ring_size, us_ring_size, image_url, image_count, state, state_reason, issues,',
  '  assumed, validated_at, listed_at)',
  'values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now(),',
  "        case when $16 = 'listed' then now() else null end)",
  'on conflict (sku) do update set',
  ' vendor = excluded.vendor, title = excluded.title, description = excluded.description,',
  ' price = excluded.price, qty = excluded.qty, product_type = excluded.product_type,',
  ' amazon_type = excluded.amazon_type, metal = excluded.metal, stone = excluded.stone,',
  ' colour = excluded.colour, ring_size = excluded.ring_size,',
  ' us_ring_size = excluded.us_ring_size, image_url = excluded.image_url,',
  ' image_count = excluded.image_count, state = excluded.state,',
  ' state_reason = excluded.state_reason, issues = excluded.issues,',
  ' assumed = excluded.assumed, validated_at = now(),',
  ' listed_at = coalesce(amazon_own_brand.listed_at, excluded.listed_at), updated_at = now()',
].join('\n');

async function record(row, built, state, reason, issues) {
  await db.query(UPSERT, [
    row.sku, row.vendor, row.title, row.description, row.price, row.qty,
    row.product_type, built.productType || null, row.metal, row.stone, row.colour,
    row.ring_size, row.us_ring_size || null, row.image_url, row.image_count || 0,
    state, reason, issues ? JSON.stringify(issues) : null, row.assumed || null,
  ]);
}

const SELECT = [
  'select a.sku, a.vendor, a.our_title as title, a.our_price as price, a.qty,',
  '       p.product_type, p.handle, p.tags,',
  '       r.s_metal_type as metal, r.s_stone_type as stone,',
  '       r.metal_colour as colour, r.ring_size, r.bracelet_length as length,',
  '       a.barcode,',
  '       r.marketing_description as description',
  'from amazon_listings a',
  'join shopify_product_variants v on v.sku = a.sku',
  'join shopify_products p on p.product_id = v.product_id',
  'left join retail_edge_products r on r.sku = a.sku',
].join('\n');

async function main() {
  const run = await db.query("insert into amazon_runs (job) values ('stage2') returning id");
  const runId = run.rows[0].id;

  if (SUBMIT && !config.channelEnabled) {
    console.log('AMAZON_CHANNEL_ENABLED is false — refusing to create anything.');
    return;
  }

  // Only bind the brand names when they are actually used — an unreferenced parameter
  // leaves Postgres unable to infer its type.
  const params = OWN_ONLY ? [...OWN_BRANDS] : [];
  const brandFilter = OWN_ONLY
    ? OWN_BRANDS.map((_, i) => 'lower(a.vendor) = $' + (i + 1)).join(' or ')
    : 'true';
  let skuFilter = '';
  if (ONLY.length) {
    params.push(ONLY);
    skuFilter = ' and a.sku = any($' + params.length + ')';
  }

  const sql = SELECT +
    '\nwhere (' + brandFilter + ")\n  and a.qty > 0\n  and a.state in ('blocked','no_match')" +
    // Never author a page for something Stage 1 has already sent. Those SKUs exist on
    // Amazon as offers against someone else's page; writing a new page under the same
    // SKU would fight with them.
    '\n  and a.last_pushed_at is null' +
    skuFilter + '\norder by a.our_price desc' + (LIMIT ? '\nlimit ' + LIMIT : '');

  const { rows } = await db.query(sql, params);

  console.log(rows.length + (OWN_ONLY ? ' of our own pieces' : ' products') + ' to consider' +
    (SUBMIT ? '' : '  (validating only — nothing will be created)') + '\n');

  const counts = {};
  const bump = (k) => (counts[k] = (counts[k] || 0) + 1);
  const gaps = {};
  const assumedTally = {};
  const assumedFields = {};
  let done = 0;

  for (const row of rows) {
    const photos = await photosFor(row.handle);
    row.image_url = photos.images[0] || null;
    row.extra_images = photos.images.slice(1);
    row.image_count = photos.images.length;
    row.description = row.description || photos.description;
    if (row.ring_size) row.us_ring_size = toAmazonSize(row.ring_size).us;

    // Never for a banned brand, whatever else is true of it.
    const brand = checkBrand({ vendor: row.vendor });
    if (!brand.allowed) {
      await record(row, {}, 'blocked', brand.reason, null);
      bump('blocked');
      continue;
    }

    // Our own pieces have no barcode and need the exemption. Everything else has a
    // real one, and supplying it is both more honest and more likely to be accepted.
    const own = OWN_BRANDS.includes(String(row.vendor || '').toLowerCase());
    const gtin = isValidGtin(row.barcode) ? String(row.barcode).trim() : null;

    const built = buildListing(row, {
      marketplaceId: config.amazon.marketplaceId,
      exemption: own || !gtin,
    });
    if (built.ok && gtin && !own) {
      built.body.attributes.externally_assigned_product_identifier = [{
        marketplace_id: config.amazon.marketplaceId,
        type: gtin.length === 12 ? 'upc' : 'ean',
        value: gtin,
      }];
    }
    let state;
    let reason = null;
    let issues = null;

    if (!built.ok) {
      state = 'not_ready';
      reason = built.missing.join('; ');
      for (const w of built.missing) {
        const key = w.replace(/"[^"]*"/g, 'that');
        gaps[key] = (gaps[key] || 0) + 1;
      }
    } else {
      const path = '/listings/2021-08-01/items/' +
        encodeURIComponent(config.amazon.sellerId) + '/' + encodeURIComponent(row.sku);
      const query = { marketplaceIds: config.amazon.marketplaceId, issueLocale: 'en_AU' };
      // Only a deliberate --submit turns a preview into a real creation.
      if (!SUBMIT) query.mode = 'VALIDATION_PREVIEW';

      let res;
      try {
        res = await request(path, { method: 'PUT', query, body: built.body, allowWrite: true });
      } catch (err) {
        await record(row, built, 'blocked', String(err.message).slice(0, 300), null);
        bump('blocked');
        continue;
      }

      const errs = (res.issues || []).filter((i) => i.severity === 'ERROR');
      issues = errs.map((i) => ({ code: i.code, message: i.message }));
      const text = errs.map((i) => i.message).join(' ');

      if (!errs.length) {
        state = SUBMIT ? 'listed' : 'ready';
      } else if (/different from what's already in the Amazon catalogue|already exists in the Amazon catalog|doesn't match the ASIN's product type|does not match the ASIN/i.test(text)) {
        // Amazon already carries this barcode. That makes it a Stage 1 offer, not a
        // page for us to author — and it means our own barcode lookup missed it, which
        // is worth knowing on its own.
        state = 'stage1';
        reason = 'Amazon already carries this barcode — our catalogue match missed it, so it belongs in Stage 1';
      } else {
        state = 'blocked';
        reason = text.slice(0, 400);
      }
    }

    if (built.assumed && built.assumed.length) {
      row.assumed = built.assumed;
      assumedTally[built.assumed.length] = (assumedTally[built.assumed.length] || 0) + 1;
      for (const a of built.assumed) assumedFields[a] = (assumedFields[a] || 0) + 1;
    }
    await record(row, built, state, reason, issues);
    bump(state);

    if (++done % 50 === 0) console.log('  ' + done + '/' + rows.length + ' checked');
  }

  console.log('\nwhere each piece ended up:');
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(11) + ' ' + n);
  }
  if (Object.keys(assumedFields).length) {
    console.log('\nattributes we had to assume rather than read:');
    for (const [f, n] of Object.entries(assumedFields).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + String(n).padStart(5) + '  ' + f);
    }
    console.log('  (these are guesses that are usually right — worth correcting in time,');
    console.log('   and none of them changes which product the customer receives)');
  }
  if (Object.keys(gaps).length) {
    console.log('\nwhat our own data is missing:');
    for (const [why, n] of Object.entries(gaps).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + String(n).padStart(4) + '  ' + why);
    }
  }

  await db.query(
    'update amazon_runs set finished_at = now(), ok = $2, failed = $3, note = $4 where id = $1',
    [runId, (counts.ready || 0) + (counts.listed || 0), counts.blocked || 0, JSON.stringify(counts)]
  );
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
