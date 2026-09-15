'use strict';
/**
 * What has sold on Amazon lately.
 *
 * Needed for one narrow but expensive question: when Amazon holds less stock than we
 * do, is that because the item sold, or because Amazon has done something of its own?
 * The two look identical from the quantity alone and want opposite handling — a sale
 * must not be overwritten, and anything else should be corrected.
 *
 * Only order identifiers, SKUs and quantities are read. No buyer details: the
 * application has no access to shipping addresses, and none are wanted here.
 */
const config = require('../config');
const { request } = require('./client');

/**
 * Units sold per SKU since a given time.
 * @returns {Promise<Map<string, {units: number, latest: string, orders: string[]}>>}
 */
async function soldSince(since) {
  const sold = new Map();
  let nextToken = null;

  for (let page = 0; page < 50; page++) {
    const query = nextToken
      ? { NextToken: nextToken, MarketplaceIds: config.amazon.marketplaceId }
      : { MarketplaceIds: config.amazon.marketplaceId, CreatedAfter: since.toISOString() };

    const res = await request('/orders/v0/orders', { query });
    const payload = res.payload || res;
    const orders = payload.Orders || [];

    for (const order of orders) {
      // A cancelled order did not consume stock, so it must not hold a quantity back.
      if (order.OrderStatus === 'Canceled') continue;

      const items = await request(`/orders/v0/orders/${encodeURIComponent(order.AmazonOrderId)}/orderItems`);
      for (const item of ((items.payload || items).OrderItems || [])) {
        const sku = String(item.SellerSKU || '').trim();
        if (!sku) continue;
        const units = Number(item.QuantityOrdered) || 0;
        if (!units) continue;

        const entry = sold.get(sku) || { units: 0, latest: order.PurchaseDate, orders: [] };
        entry.units += units;
        if (order.PurchaseDate > entry.latest) entry.latest = order.PurchaseDate;
        entry.orders.push(order.AmazonOrderId);
        sold.set(sku, entry);
      }
    }

    nextToken = payload.NextToken || null;
    if (!nextToken) break;
  }
  return sold;
}

module.exports = { soldSince };
