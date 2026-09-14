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

    if (state) { params.push(state); where.push(`state = $${params.length}`); }
    if (vendor) { params.push(vendor); where.push(`vendor = $${params.length}`); }
    if (source) { params.push(source); where.push(`source = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(sku ilike $${params.length} or barcode ilike $${params.length} or our_title ilike $${params.length})`);
    }

    params.push(Math.min(Number(limit) || 100, 500));
    params.push(Number(offset) || 0);

    const { rows } = await db.query(
      `select barcode, sku, vendor, our_title, our_price, qty, source,
              asin, amazon_title, state, state_reason, confidence, match_note, last_pushed_at
       from amazon_listings
       ${where.length ? 'where ' + where.join(' and ') : ''}
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
    const { rows } = await db.query(
      `select barcode, sku, our_title, our_vendor, our_price,
              asin, amazon_title, amazon_brand, amazon_image, reason,
              first_seen_at, last_seen_at
       from amazon_conflicts order by last_seen_at desc limit 500`
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

/** Everything Amazon refused, grouped by cause — six problems, not three hundred rows. */
router.get('/errors', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `select code, min(plain) as plain, min(fix) as fix, count(*)::int as affected,
              max(created_at) as last_seen
       from amazon_errors where resolved_at is null
       group by code order by count(*) desc`
    );
    res.json({ groups: rows });
  } catch (err) { next(err); }
});

module.exports = router;
