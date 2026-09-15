'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

/** Everything we are trying to list, filterable the way the screen needs. */
router.get('/listings', async (req, res, next) => {
  try {
    const { state, vendor, source, q, limit = 100, offset = 0 } = req.query;
    const where = [];
    const params = [];

    if (state) {
      params.push(state);
      where.push(`a.state = $${params.length}`);
      // A row can say listed without having been sent. The tile counts what is on
      // Amazon, so the tab must too.
      if (state === 'listed') where.push('a.last_pushed_at is not null');
    }
    if (vendor) { params.push(vendor); where.push(`a.vendor = $${params.length}`); }
    if (source) { params.push(source); where.push(`a.source = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(a.sku ilike $${params.length} or a.barcode ilike $${params.length} or a.our_title ilike $${params.length})`);
    }

    params.push(Math.min(Number(limit) || 100, 500));
    params.push(Number(offset) || 0);

    // "Live on Amazon" has to mean everything live, or the tab disagrees with the tile
    // above it. Stage 2 pages live in their own table and are folded in here, shaped to
    // the same columns — they have no barcode or matched ASIN by their nature, which is
    // the whole reason they needed authoring rather than matching.
    const ownBrand = state === 'listed'
      ? `union all
         select null::text as barcode, o.sku, o.vendor, o.title as our_title,
                o.price as our_price, o.qty, 'S2'::char as source,
                null::text as asin, null::text as amazon_title, 'listed' as state,
                'we created this page ourselves' as state_reason,
                null::text as confidence, null::text as match_note,
                o.listed_at as last_pushed_at, o.listing_status, o.buyable,
                o.status_checked_at,
                (select e.plain from amazon_errors e
                  where e.sku = o.sku and e.resolved_at is null
                  order by e.created_at desc limit 1) as problem
         from amazon_own_brand o
         where o.state = 'listed'
           and not exists (select 1 from amazon_listings x
                            where x.sku = o.sku and x.last_pushed_at is not null)`
      : '';

    const { rows } = await db.query(
      `select * from (
       select a.barcode, a.sku, a.vendor, a.our_title, a.our_price, a.qty, a.source,
              a.asin, a.amazon_title, a.state, a.state_reason, a.confidence, a.match_note,
              a.last_pushed_at, a.listing_status, a.buyable, a.status_checked_at,
              -- an open complaint from Amazon, so the screen can say "stuck" rather
              -- than "not buyable yet", which wrongly implies it is still coming
              (select e.plain from amazon_errors e
                where e.sku = a.sku and e.resolved_at is null
                order by e.created_at desc limit 1) as problem
       from amazon_listings a
       ${where.length ? 'where ' + where.join(' and ') : ''}
       ${ownBrand}
       ) rows
       order by vendor, sku
       limit $${params.length - 1} offset $${params.length}`,
      params
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

/**
 * Barcode conflicts: the same barcode pointing at a different product on Amazon.
 * Read-only by design. There is deliberately no endpoint to list one anyway — the
 * only thing that clears a conflict is the barcode changing in Retail Edge.
 */
router.get('/conflicts', async (req, res, next) => {
  try {
    // Only products that are in conflict now. The table keeps the history, but a
    // product that has since been blocked for another reason is not a live conflict
    // and listing it here made this tab disagree with the count above it.
    const { rows } = await db.query(
      `select c.barcode, c.sku, c.our_title, c.our_vendor, c.our_price,
              c.asin, c.amazon_title, c.amazon_brand, c.amazon_image, c.reason,
              c.first_seen_at, c.last_seen_at
       from amazon_conflicts c
       join amazon_listings a on a.sku = c.sku and a.state = 'conflict'
       order by c.last_seen_at desc limit 500`
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

/**
 * Everything Amazon is unhappy about, grouped by cause — six problems, not three
 * hundred rows. Grouped on the plain-English cause rather than Amazon's code, because
 * one cause arrives under several codes and some carry no code at all.
 *
 * Each group names the products it affects, so the fix is a job someone can pick up
 * rather than a number they can only look at.
 */
router.get('/errors', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      select e.plain,
             min(e.fix)                       as fix,
             count(*)::int                    as affected,
             max(e.created_at)                as last_seen,
             json_agg(json_build_object(
               'sku',   e.sku,
               'title', l.our_title,
               'asin',  l.asin
             ) order by e.sku)                as items
      from amazon_errors e
      left join amazon_listings l on l.sku = e.sku
      where e.resolved_at is null
      group by e.plain
      order by count(*) desc`);
    res.json({ groups: rows });
  } catch (err) { next(err); }
});

/**
 * Blocked products grouped by cause. Three hundred rows is unreadable; six causes
 * with a count and a fix is a morning's work someone can actually do.
 */
router.get('/blocked-reasons', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      select
        case
          when state_reason ilike '%only supplies a banned brand%' then 'Banned brand (identified by supplier code)'
          when state_reason ilike '%never listed on Amazon%'       then 'Banned brand'
          when state_reason ilike '%no brand could be determined%' then 'Brand could not be determined'
          when state_reason ilike '%out of stock%'                 then 'Out of stock everywhere'
          when state_reason ilike '%internal code%'                then 'Barcode field holds an internal stock code'
          when state_reason ilike '%wrong length%'                 then 'Barcode is the wrong length'
          when state_reason ilike '%check digit%'                  then 'Barcode fails its check digit'
          when state_reason ilike '%no barcode%'                   then 'No barcode recorded'
          else coalesce(state_reason, 'Unknown')
        end                        as reason,
        count(*)::int              as products,
        min(state_reason)          as sample_reason,
        (array_agg(sku order by sku))[1]       as sample_sku,
        (array_agg(our_title order by sku))[1] as sample_title
      from amazon_listings
      where state = 'blocked'
      group by 1 order by 2 desc`);
    res.json({ groups: rows });
  } catch (err) { next(err); }
});

/**
 * Stage 2: our own pieces, which have to have their product page created rather than
 * matched. Grouped by what is standing in the way, because the answer for most of them
 * is the same one thing and a list of 700 rows would hide that.
 */
router.get('/own-brand', async (req, res, next) => {
  try {
    const { rows: summary } = await db.query(`
      select state, count(*)::int as n, sum(price)::numeric as value
      from amazon_own_brand group by state order by n desc`);

    const { rows: blockers } = await db.query(`
      select case
               when state_reason ilike '%has not been approved%'
                 then 'Amazon has not approved the brand yet'
               when state_reason ilike '%aren''t complete enough%'
                 then 'Amazon wants more detail before it will create a page'
               else coalesce(state_reason, 'Unknown')
             end                                   as reason,
             count(*)::int                         as products,
             sum(price)::numeric                   as value,
             (array_agg(sku order by price desc))[1]   as sample_sku,
             (array_agg(title order by price desc))[1] as sample_title
      from amazon_own_brand
      where state in ('blocked','not_ready')
      group by 1 order by 2 desc limit 25`);

    const { rows: ready } = await db.query(`
      select sku, title, price, qty, product_type, amazon_type, metal, stone,
             ring_size, us_ring_size, image_count
      from amazon_own_brand where state = 'ready'
      order by price desc limit 300`);

    res.json({ summary, blockers, ready });
  } catch (err) { next(err); }
});

module.exports = router;
