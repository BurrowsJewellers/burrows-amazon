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
/** What the buyer paid Amazon: Amazon's own order total, or the lines if it gave none. */
function totalOf(order, lines) {
  const t = Number(order.OrderTotal?.Amount || 0);
  return t > 0 ? t : lines.reduce((n, l) => n + Number(l.unit_price) * Number(l.quantity), 0);
}

/** The part of Amazon's total that is not the items. */
function postageOf(order, lines) {
  const items = lines.reduce((n, l) => n + Number(l.unit_price) * Number(l.quantity), 0);
  return Math.max(0, Math.round((totalOf(order, lines) - items) * 100) / 100);
}

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
      // …and the payment itself, recorded against Amazon. Without it Shopify shows the
      // order as paid with $0 received and the whole total outstanding, and offers to
      // invoice the buyer or take a card — charging them a second time. (#2920, 26 Oct)
      transactions: [{ kind: 'sale', status: 'success', amount: totalOf(order, lines).toFixed(2), gateway: 'Amazon' }],
      // Anything Amazon charged beyond the items is postage; carried so the totals match.
      shipping_lines: postageOf(order, lines) > 0.005
        ? [{ title: 'Amazon postage', price: postageOf(order, lines).toFixed(2), code: 'Amazon' }] : [],
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
