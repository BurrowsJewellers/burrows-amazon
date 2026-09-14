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

    if (state) { params.push(state); where.push(`a.state = $${params.length}`); }
    if (vendor) { params.push(vendor); where.push(`a.vendor = $${params.length}`); }
    if (source) { params.push(source); where.push(`a.source = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(a.sku ilike $${params.length} or a.barcode ilike $${params.length} or a.our_title ilike $${params.length})`);
    }

    params.push(Math.min(Number(limit) || 100, 500));
    params.push(Number(offset) || 0);

    const { rows } = await db.query(
      `select a.barcode, a.sku, a.vendor, a.our_title, a.our_price, a.qty, a.source,
              a.asin, a.amazon_title, a.state, a.state_reason, a.confidence, a.match_note,
              a.last_pushed_at, a.listing_status, a.buyable, a.status_checked_at,
              -- an open complaint from Amazon, so the screen can say "stuck" rather
              -- than "not buyable yet", which wrongly implies it is still coming
              (select e.plain from amazon_errors e
                where e.sku = a.sku and e.resolved_at is null
                order by e.created_at desc limit 1) as problem
       from amazon_listings a
       ${where.length ? 'where ' + where.join(' and ') : ''}
       order by a.vendor, a.sku
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
    const { rows } = await db.query(
      `select barcode, sku, our_title, our_vendor, our_price,
              asin, amazon_title, amazon_brand, amazon_image, reason,
              first_seen_at, last_seen_at
       from amazon_conflicts order by last_seen_at desc limit 500`
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

module.exports = router;
