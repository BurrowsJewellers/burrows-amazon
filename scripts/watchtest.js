#!/usr/bin/env node
'use strict';
/**
 * Read-only / validation only. Can we author pages for the watches?
 *
 * They are the largest single group Amazon has no listing for, they carry real
 * barcodes, and they have none of the jewellery attributes our mapping depends on —
 * which is why they fell out of the earlier test before Amazon ever got a say.
 */
const db = require('../src/db');
const config = require('../src/config');
const { request } = require('../src/amazon/client');

const MP = config.amazon.marketplaceId;
const SELLER = config.amazon.sellerId;
const m = { marketplace_id: MP };
const L = { marketplace_id: MP, language_tag: 'en_AU' };

async function photosFor(handle) {
  try {
    const res = await fetch('https://burrows-jewellers.myshopify.com/products/' + handle + '.js');
    if (!res.ok) return { images: [], description: '' };
    const j = await res.json();
    return {
      images: (j.images || []).map((u) => (u.startsWith('//') ? 'https:' + u : u)),
      description: String(j.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    };
  } catch (err) { return { images: [], description: '' }; }
}

async function main() {
  const def = await request('/definitions/2020-09-01/productTypes/WATCH', {
    query: { marketplaceIds: MP, requirementsEnforced: 'ENFORCED', locale: 'en_AU' } });
  const schema = await (await fetch(def.schema.link.resource)).json();
  console.log('WATCH requires at top level:', (schema.required || []).join(', '), '\n');

  const { rows } = await db.query(`
    select distinct on (a.vendor)
           a.vendor, a.sku, a.barcode, a.our_title as title, a.our_price as price, a.qty,
           p.handle,
           (select count(*)::int from amazon_listings x
             join shopify_product_variants xv on xv.sku = x.sku
             join shopify_products xp on xp.product_id = xv.product_id
            where x.vendor = a.vendor and x.state = 'no_match' and x.qty > 0
              and xp.product_type ilike 'watch%') as brand_watches
    from amazon_listings a
    join shopify_product_variants v on v.sku = a.sku
    join shopify_products p on p.product_id = v.product_id
    where a.state = 'no_match' and a.qty > 0 and p.media_count > 0
      and p.product_type ilike 'watch%'
    order by a.vendor, a.our_price desc`);

  console.log(`${rows.length} brands with watches Amazon has no listing for\n`);

  for (const row of rows) {
    const photos = await photosFor(row.handle);
    if (!photos.images.length) { console.log(`${row.vendor}: no photograph`); continue; }

    const body = {
      productType: 'WATCH',
      requirements: 'LISTING',
      attributes: {
        brand: [{ ...L, value: row.vendor }],
        item_name: [{ ...L, value: row.title.slice(0, 190) }],
        product_description: [{ ...L, value: (photos.description || row.title).slice(0, 1900) }],
        bullet_point: [{ ...L, value: row.title.slice(0, 190) }],
        country_of_origin: [{ ...m, value: 'CN' }],
        supplier_declared_dg_hz_regulation: [{ ...m, value: 'not_applicable' }],
        condition_type: [{ ...m, value: 'new_new' }],
        part_number: [{ ...m, value: row.sku }],
        externally_assigned_product_identifier: [{ ...m,
          type: String(row.barcode).trim().length === 12 ? 'upc' : 'ean',
          value: String(row.barcode).trim() }],
        main_product_image_locator: [{ ...m, media_location: photos.images[0] }],
        purchasable_offer: [{ ...m, currency: 'AUD',
          our_price: [{ schedule: [{ value_with_tax: Number(row.price) }] }] }],
        fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT',
          quantity: Number(row.qty) || 0, lead_time_to_ship_max_days: 5 }],
      },
    };

    try {
      const res = await request(
        '/listings/2021-08-01/items/' + encodeURIComponent(SELLER) + '/' +
        encodeURIComponent('WATCHTEST-' + row.sku),
        { method: 'PUT',
          query: { marketplaceIds: MP, mode: 'VALIDATION_PREVIEW', issueLocale: 'en_AU' },
          body, allowWrite: true });
      const errs = (res.issues || []).filter((i) => i.severity === 'ERROR');
      const brandRefusal = errs.some((e) =>
        /may not create new ASINs|connect your brand|not been approved|Request Approval/i.test(e.message));
      console.log(`${String(row.vendor).slice(0, 18).padEnd(20)} ${String(row.brand_watches).padStart(4)} watches   ` +
        (errs.length === 0 ? 'WOULD ACCEPT' : brandRefusal ? 'BRAND REFUSED' : `${errs.length} data issue(s)`));
      for (const e of errs.slice(0, 3)) console.log(`      ${String(e.message).slice(0, 140)}`);
    } catch (err) {
      console.log(`${String(row.vendor).padEnd(20)} request failed: ${String(err.message).slice(0, 110)}`);
    }
  }
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
