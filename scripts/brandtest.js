#!/usr/bin/env node
'use strict';
/**
 * Which brands will Amazon let us create product pages for?
 *
 * Stage 2 is limited to brands we own, on the assumption that Amazon refuses the rest.
 * That assumption came from watching it refuse Thomas Sabo — worth testing properly
 * across the brands that actually matter, rather than generalising from one.
 *
 * Validation only (mode=VALIDATION_PREVIEW). Creates nothing, changes nothing.
 *
 * One important difference from our own pieces: these products carry real barcodes, so
 * there is no exemption to claim. The only question is whether we may author the page.
 */
const db = require('../src/db');
const config = require('../src/config');
const { request } = require('../src/amazon/client');
const { buildListing } = require('../src/stage2/attributes');
const { toAmazonSize } = require('../src/stage2/ringsize');

const PER_BRAND = Number(process.argv.find((a) => a.startsWith('--per-brand='))?.split('=')[1] || 1);

async function photosFor(handle) {
  try {
    const res = await fetch('https://burrows-jewellers.myshopify.com/products/' + handle + '.js');
    if (!res.ok) return { images: [], description: '' };
    const j = await res.json();
    return {
      images: (j.images || []).map((u) => (u.startsWith('//') ? 'https:' + u : u)),
      description: String(j.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    };
  } catch (err) {
    return { images: [], description: '' };
  }
}

/** Amazon's refusals, boiled down to the question we are actually asking. */
function verdictOf(errors) {
  const text = errors.map((e) => e.message).join(' ');
  if (/may not create new ASINs|connect your brand|not been approved by Amazon|Request Approval/i.test(text)) {
    return { verdict: 'BRAND REFUSED', detail: 'Amazon will not let us author a page for this brand' };
  }
  if (!errors.length) return { verdict: 'WOULD ACCEPT', detail: 'Amazon raised nothing' };
  return { verdict: 'data gaps only', detail: errors.map((e) => e.message).join(' | ').slice(0, 150) };
}

async function main() {
  const { rows } = await db.query(`
    select distinct on (a.vendor)
           a.vendor, a.sku, a.barcode, a.our_title as title, a.our_price as price, a.qty,
           p.product_type, p.handle,
           r.s_metal_type as metal, r.s_stone_type as stone, r.metal_colour as colour,
           r.ring_size, r.bracelet_length as length, r.marketing_description as description,
           (select count(*)::int from amazon_listings x
             where x.vendor = a.vendor and x.state = 'no_match' and x.qty > 0) as brand_total
    from amazon_listings a
    join shopify_product_variants v on v.sku = a.sku
    join shopify_products p on p.product_id = v.product_id
    left join retail_edge_products r on r.sku = a.sku
    where a.state = 'no_match' and a.qty > 0
      and lower(a.vendor) not in ('burrows collection','burrows jewellers')
      and p.media_count > 0
      and p.product_type in ('Ring','Earring','Necklace','Bracelet','Pendant','Chain','Bangle')
    order by a.vendor, a.our_price desc`);

  console.log(`testing ${rows.length} brands, one piece each — validation only, nothing is created\n`);

  const results = [];
  for (const row of rows) {
    const photos = await photosFor(row.handle);
    row.image_url = photos.images[0] || null;
    row.extra_images = photos.images.slice(1);
    row.description = row.description || photos.description;
    if (row.ring_size) row.us_ring_size = toAmazonSize(row.ring_size).us;

    // These have real barcodes, so no exemption is claimed — the identifier is supplied.
    const built = buildListing(row, { marketplaceId: config.amazon.marketplaceId, exemption: false });
    if (!built.ok) {
      results.push({ vendor: row.vendor, total: row.brand_total, verdict: 'our data',
                     detail: built.missing.join('; ').slice(0, 100) });
      continue;
    }
    built.body.attributes.externally_assigned_product_identifier = [{
      marketplace_id: config.amazon.marketplaceId,
      type: String(row.barcode).length === 12 ? 'upc' : 'ean',
      value: String(row.barcode).trim(),
    }];

    try {
      const res = await request(
        '/listings/2021-08-01/items/' + encodeURIComponent(config.amazon.sellerId) +
        '/' + encodeURIComponent('BRANDTEST-' + row.sku),
        { method: 'PUT',
          query: { marketplaceIds: config.amazon.marketplaceId, mode: 'VALIDATION_PREVIEW', issueLocale: 'en_AU' },
          body: built.body, allowWrite: true });
      const errs = (res.issues || []).filter((i) => i.severity === 'ERROR');
      const v = verdictOf(errs);
      results.push({ vendor: row.vendor, total: row.brand_total, ...v });
    } catch (err) {
      results.push({ vendor: row.vendor, total: row.brand_total, verdict: 'request failed',
                     detail: String(err.message).slice(0, 110) });
    }
  }

  results.sort((a, b) => b.total - a.total);
  console.log('brand                    products   verdict');
  for (const r of results) {
    console.log(`${String(r.vendor).slice(0, 22).padEnd(24)} ${String(r.total).padStart(5)}      ${r.verdict}`);
    if (r.verdict !== 'BRAND REFUSED') console.log(`${' '.repeat(30)} ${r.detail}`);
  }

  const refused = results.filter((r) => r.verdict === 'BRAND REFUSED');
  const open = results.filter((r) => r.verdict === 'WOULD ACCEPT');
  console.log(`\n${refused.length} brands refused outright, covering ${refused.reduce((t, r) => t + r.total, 0)} products`);
  console.log(`${open.length} brands Amazon raised no objection to, covering ${open.reduce((t, r) => t + r.total, 0)} products`);
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
