'use strict';
/**
 * Shaping an Amazon order into the Shopify order that stands for it.
 *
 * Kept apart from the job that fetches and writes, so it can be read and tested
 * without a database or a network between you and it.
 */

/**
 * The Shopify order we would create.
 *
 * Kept as a plain function so it can be read, and tested, without anything being sent.
 *
 * The address is whatever Amazon gives us. Today that is a suburb and a postcode —
 * Amazon withholds the name and street from this application — which is enough for the
 * order to exist and the stock to move, but not enough to put on a parcel. Rather than
 * invent the missing lines, the order says plainly where the real address lives.
 */
function shopifyOrderFor(order, lines) {
  const address = order.ShippingAddress || {};
  const full = Boolean(address.AddressLine1);

  return {
    order: {
      line_items: lines.map((l) => ({
        variant_id: l.shopify_variant_id,
        quantity: l.quantity,
        price: l.unit_price,
      })),
      financial_status: 'paid',           // Amazon has already taken the money
      currency: order.OrderTotal?.CurrencyCode || 'AUD',
      // Stock must come down, which is the whole reason this order exists here.
      inventory_behaviour: 'decrement_obeying_policy',
      send_receipt: false,                // Amazon has already emailed the buyer
      send_fulfillment_receipt: false,
      tags: ['Amazon', order.AmazonOrderId].join(', '),
      source_name: 'amazon',
      note: full
        ? `Amazon order ${order.AmazonOrderId}`
        : `Amazon order ${order.AmazonOrderId}. Amazon does not release the buyer's name `
          + 'and street address to this application — take them from Seller Central to ship.',
      shipping_address: {
        address1: address.AddressLine1 || '',
        city: address.City || '',
        province_code: address.StateOrRegion || '',
        zip: address.PostalCode || '',
        country_code: address.CountryCode || 'AU',
        ...(address.Name ? { name: address.Name } : {}),
      },
    },
  };
}

module.exports = { shopifyOrderFor };
