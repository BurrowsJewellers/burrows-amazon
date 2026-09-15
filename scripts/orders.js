#!/usr/bin/env node
'use strict';
/**
 * Carrying an Amazon order across to Shopify.
 *
 * Amazon is a sales channel, not a second business. An order placed there should end
 * up in the same places a web order does — stock down, the POS told, one list to work
 * from — and the shop already has machinery that does all of that from a Shopify
 * order. So rather than build a second path into Retail Edge, this puts the order
 * where the existing path will find it.
 *
 * What makes that straightforward is the SKU. The seller SKU we send to Amazon when
 * listing is the Retail Edge SKU, so an Amazon order line names a product we can look
 * up directly. No barcode matching, no title matching, nothing to get wrong.
 *
 * Creating the Shopify order decrements its stock, which is the point: the sync that
 * keeps Amazon in step then takes the item down on its next pass, and a one-of-a-kind
 * piece cannot be sold twice.
 *
 * Reads Amazon and records what it finds. Writing to Shopify needs --submit, and is
 * refused unless the store has actually granted permission to write orders.
 */
const db = require('../src/db');
const config = require('../src/config');
const { request: amazon } = require('../src/amazon/client');
const shopify = require('../src/shopify/client');
const { shopifyOrderFor } = require('../src/shopify/order');

const SUBMIT = process.argv.includes('--submit');
const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || 14);

/**
 * Orders placed before this date were fulfilled by hand: shipped from Seller Central
 * and the stock taken off in Retail Edge by whoever packed them. Carrying one of those
 * across now would take the stock off a second time and count the money twice, which
 * is why the first attempt was refused by Shopify — it could not reserve stock that
 * had already gone.
 *
 * There is deliberately no default. Guessing this wrong quietly corrupts stock and
 * revenue, so it has to be stated.
 */
const FROM = process.env.AMAZON_ORDERS_FROM ? new Date(process.env.AMAZON_ORDERS_FROM) : null;

/** Amazon ships these itself, so they are not ours to pick, pack or decrement. */
const NOT_OURS = new Set(['AFN']);

async function amazonOrders(since) {
  const out = [];
  let nextToken = null;
  for (let page = 0; page < 50; page++) {
    const query = nextToken
      ? { NextToken: nextToken, MarketplaceIds: config.amazon.marketplaceId }
      : { MarketplaceIds: config.amazon.marketplaceId, CreatedAfter: since.toISOString() };
    const res = await amazon('/orders/v0/orders', { query });
    const payload = res.payload || res;
    out.push(...(payload.Orders || []));
    nextToken = payload.NextToken || null;
    if (!nextToken) break;
  }
  return out;
}

async function amazonOrderItems(orderId) {
  const res = await amazon(`/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`);
  return (res.payload || res).OrderItems || [];
}

async function main() {
  const run = await db.query("insert into amazon_runs (job) values ('orders') returning id");
  const runId = run.rows[0].id;

  let canWrite = false;
  if (SUBMIT) {
    if (!FROM || Number.isNaN(FROM.getTime())) {
      console.log('AMAZON_ORDERS_FROM is not set, so there is no telling which orders were');
      console.log('already fulfilled by hand. Set it to the date this sync takes over, e.g.');
      console.log('  AMAZON_ORDERS_FROM=2026-09-15');
      console.log('Anything placed before then is left alone. Refusing to write without it.\n');
      await db.query('update amazon_runs set finished_at = now() where id = $1', [runId]);
      await db.pool.end();
      return;
    }
    const granted = await shopify.scopes();
    canWrite = granted.includes('write_orders');
    if (!canWrite) {
      console.log('The store has not granted this app permission to write orders.');
      console.log('Add write_orders to the app\'s scopes and approve it, then run again.');
      console.log('Carrying on read-only so the orders are still recorded.\n');
    }
  }

  const since = new Date(Date.now() - DAYS * 86400000);
  const orders = await amazonOrders(since);
  console.log(`${orders.length} Amazon orders in the last ${DAYS} days` +
    (SUBMIT && canWrite ? '' : '  (nothing will be written to Shopify)') + '\n');

  const counts = {};
  const bump = (k) => (counts[k] = (counts[k] || 0) + 1);

  for (const order of orders) {
    const id = order.AmazonOrderId;

    // Already carried across. The primary key is what makes this safe to run often.
    const seen = await db.query(
      'select state, shopify_order_id from amazon_orders where amazon_order_id = $1', [id]);
    if (seen.rows.length && seen.rows[0].shopify_order_id) { bump('already in Shopify'); continue; }

    const address = order.ShippingAddress || {};
    let state = 'seen';
    let reason = null;

    if (order.OrderStatus === 'Canceled') { state = 'ignored'; reason = 'cancelled on Amazon'; }
    else if (NOT_OURS.has(order.FulfillmentChannel)) { state = 'ignored'; reason = 'Amazon fulfils this one'; }
    else if (FROM && new Date(order.PurchaseDate) < FROM) {
      state = 'ignored';
      reason = 'placed before this sync took over — it was fulfilled by hand, and importing '
        + 'it now would take the stock off twice and count the money twice';
    }

    const items = state === 'ignored' ? [] : await amazonOrderItems(id);
    const lines = [];

    for (const item of items) {
      const sku = String(item.SellerSKU || '').trim();
      // The seller SKU is the Retail Edge SKU, so this is a lookup rather than a match.
      const v = await db.query(
        'select variant_id from shopify_product_variants where sku = $1 and variant_id is not null limit 1',
        [sku]);
      lines.push({
        order_item_id: item.OrderItemId,
        sku,
        asin: item.ASIN || null,
        title: item.Title || null,
        quantity: Number(item.QuantityOrdered) || 0,
        unit_price: Number(item.ItemPrice?.Amount || 0) / Math.max(1, Number(item.QuantityOrdered) || 1),
        item_price: Number(item.ItemPrice?.Amount || 0),
        shopify_variant_id: v.rows[0]?.variant_id || null,
      });
    }

    const unmapped = lines.filter((l) => !l.shopify_variant_id);
    if (state !== 'ignored') {
      if (!lines.length) { state = 'held'; reason = 'Amazon returned no lines for this order'; }
      else if (unmapped.length) {
        state = 'held';
        reason = `no product on the store for ${unmapped.map((l) => l.sku).join(', ')} — `
          + 'the whole order is held rather than sent through with a line missing';
      } else {
        state = 'ready';
      }
    }

    await db.query(`
      insert into amazon_orders (amazon_order_id, purchase_date, order_status, fulfilment,
        order_total, currency, ship_city, ship_state, ship_postcode, ship_country,
        has_full_address, state, state_reason)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      on conflict (amazon_order_id) do update set
        order_status = excluded.order_status, state = excluded.state,
        state_reason = excluded.state_reason, updated_at = now()`,
      [id, order.PurchaseDate, order.OrderStatus, order.FulfillmentChannel,
       Number(order.OrderTotal?.Amount || 0), order.OrderTotal?.CurrencyCode || 'AUD',
       address.City || null, address.StateOrRegion || null, address.PostalCode || null,
       address.CountryCode || null, Boolean(address.AddressLine1), state, reason]);

    for (const l of lines) {
      await db.query(`
        insert into amazon_order_items (amazon_order_id, order_item_id, sku, asin, title,
          quantity, item_price, shopify_variant_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (amazon_order_id, order_item_id) do update set
          shopify_variant_id = excluded.shopify_variant_id`,
        [id, l.order_item_id, l.sku, l.asin, l.title, l.quantity, l.item_price, l.shopify_variant_id]);
    }

    if (state !== 'ready') { bump(state === 'ignored' ? 'not ours to push' : state); continue; }

    if (!(SUBMIT && canWrite)) {
      const payload = shopifyOrderFor(order, lines);
      console.log(`${id}  would create a Shopify order: ` +
        payload.order.line_items.map((li, i) => `${lines[i].sku} x${li.quantity} @ $${li.price}`).join(', ') +
        (order.ShippingAddress?.AddressLine1 ? '' : '   [no street address from Amazon]'));
      bump('ready to carry across');
      continue;
    }

    try {
      const created = await shopify.request('/orders.json',
        { method: 'POST', body: shopifyOrderFor(order, lines) });
      await db.query(`update amazon_orders set shopify_order_id = $2, shopify_order_name = $3,
        state = 'created', state_reason = null, updated_at = now() where amazon_order_id = $1`,
        [id, created.order.id, created.order.name]);
      console.log(`${id}  -> Shopify ${created.order.name}`);
      bump('carried across');
    } catch (err) {
      // Shopify refusing to reserve stock means our own figure says there is none. For a
      // live order that should not happen — the piece was in stock when it sold — so it
      // points at the stock having already been taken off somewhere else.
      const noStock = /Unable to reserve inventory/i.test(String(err.message));
      const why = noStock
        ? 'Shopify has no stock left to reserve — the sale looks to have been taken off '
          + 'in Retail Edge already, so this order may have been handled by hand'
        : String(err.message).slice(0, 300);
      await db.query(`update amazon_orders set state = 'held', state_reason = $2, updated_at = now()
        where amazon_order_id = $1`, [id, why]);
      console.log(`${id}  held: ${why.slice(0, 150)}`);
      bump(noStock ? 'no stock to reserve' : 'failed');
    }
  }

  console.log('');
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }

  const noAddress = await db.query(
    "select count(*)::int n from amazon_orders where state in ('ready','created') and not has_full_address");
  if (noAddress.rows[0].n) {
    console.log(`\n${noAddress.rows[0].n} of these have no street address from Amazon.`);
    console.log('They can be recorded and their stock moved, but not shipped without');
    console.log('opening Seller Central — that needs the restricted shipping-address role.');
  }

  await db.query('update amazon_runs set finished_at = now(), ok = $2, note = $3 where id = $1',
    [runId, counts['carried across'] || 0, JSON.stringify(counts)]);
  await db.pool.end();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
