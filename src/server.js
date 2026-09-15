'use strict';
const express = require('express');
const config = require('./config');
const db = require('./db');

const app = express();
app.use(express.json());

const { requireAuth } = require('./middleware/auth');

// Health is deliberately open: it proves the service is up without revealing data.
app.get('/api/health', async (req, res) => {
  try {
    await db.query('select 1');
    res.json({
      ok: true,
      service: 'burrows-amazon',
      marketplace: config.amazon.marketplaceId,
      writesEnabled: config.channelEnabled,
      marginFloorPct: config.minMarginPct,
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Everything past this point needs the dashboard's login.
app.use('/api', requireAuth);

/** The counts the overview screen leads with. */
app.get('/api/summary', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `select state, count(*)::int as n from amazon_listings group by state`
    );
    const by = Object.fromEntries(rows.map((r) => [r.state, r.n]));
    // Counted from the products, not from the conflicts table. That table keeps every
    // conflict ever recorded, including ones whose product has since moved on for some
    // other reason, so counting it made this tile disagree with its own tab.
    const { rows: conflicts } = await db.query(
      `select count(*)::int as n from amazon_listings where state = 'conflict'`);
    // Products with a problem, not problem rows. One listing can carry four
    // complaints, and counting those as four makes the screen read as four times
    // worse than it is.
    const { rows: errors } = await db.query(
      'select count(distinct sku)::int as n from amazon_errors where resolved_at is null'
    );
    // Sent and buyable are different things: Amazon accepts an offer immediately and
    // decides whether to show it later. A third group has been sent since the last
    // health pass and has no status yet — counted separately, because leaving it out
    // meant the figures on screen did not add up to the number we had sent.
    // Both routes onto Amazon. Counting only the offers would show a smaller number
    // than we have actually listed, and the pages Stage 2 authored are the ones a
    // person is most likely to be looking for.
    const { rows: live } = await db.query(
      `with live as (
         select buyable, listing_status, status_checked_at
         from amazon_listings where state = 'listed' and last_pushed_at is not null
         union all
         select buyable, listing_status, status_checked_at
         from amazon_own_brand where state = 'listed'
       )
       select count(*) filter (where buyable)::int              as buyable,
              count(*) filter (where listing_status is not null
                                 and not coalesce(buyable,false))::int as visible_only,
              count(*) filter (where listing_status is null)::int      as unchecked,
              count(*)::int                                     as total,
              max(status_checked_at)                            as checked_at
       from live`
    );
    // Stage 2 readiness, so the tab carries a count like the others. The table only
    // exists once that pass has run, so a missing table is not an error here.
    let ownBrandReady = 0;
    try {
      const { rows: ob } = await db.query(
        "select count(*)::int as n from amazon_own_brand where state = 'ready'");
      ownBrandReady = ob[0].n;
    } catch (err) { ownBrandReady = 0; }

    res.json({
      ownBrandReady,
      buyable: live[0].buyable,
      visibleNotBuyable: live[0].visible_only,
      notYetChecked: live[0].unchecked,
      statusCheckedAt: live[0].checked_at,
      listed: live[0].total,
      review: by.review || 0,
      ready: by.ready || 0,
      noMatch: by.no_match || 0,
      blocked: by.blocked || 0,
      held: by.held || 0,
      failed: by.failed || 0,
      conflicts: conflicts[0].n,
      openErrors: errors[0].n,
      writesEnabled: config.channelEnabled,
    });
  } catch (err) {
    next(err);
  }
});

app.use('/api', require('./routes/listings'));

// The page itself. No build step: it is one file, served as-is.
app.use(express.static(require('path').join(__dirname, '..', 'web')));

app.use((err, req, res, _next) => {
  console.error('[api]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(
    `burrows-amazon on 127.0.0.1:${config.port} — writes ${config.channelEnabled ? 'ENABLED' : 'disabled'}`
  );
});
