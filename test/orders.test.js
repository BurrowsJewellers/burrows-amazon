'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shopifyOrderFor } = require('../src/shopify/order');

const amazonOrder = (over = {}) => ({
  AmazonOrderId: '250-5968746-8234241',
  OrderTotal: { CurrencyCode: 'AUD', Amount: '40.00' },
  ShippingAddress: { City: 'CENTENNIAL PARK', StateOrRegion: 'NSW', PostalCode: '2021', CountryCode: 'AU' },
  ...over,
});
const line = { shopify_variant_id: 51536682221873, quantity: 1, unit_price: 35, sku: '024-05144' };

test('the order carries the Amazon number where a person will find it', () => {
  const { order } = shopifyOrderFor(amazonOrder(), [line]);
  assert.match(order.tags, /Amazon/);
  assert.match(order.tags, /250-5968746-8234241/);
  assert.match(order.note, /250-5968746-8234241/);
  assert.equal(order.source_name, 'amazon');
});

test('stock comes down, which is the point of creating it', () => {
  const { order } = shopifyOrderFor(amazonOrder(), [line]);
  assert.equal(order.inventory_behaviour, 'decrement_obeying_policy');
  assert.equal(order.line_items[0].variant_id, 51536682221873);
  assert.equal(order.line_items[0].quantity, 1);
});

test('Amazon has taken the money, so the order is not asking for it again', () => {
  const { order } = shopifyOrderFor(amazonOrder(), [line]);
  assert.equal(order.financial_status, 'paid');
  assert.equal(order.send_receipt, false);          // Amazon already emailed the buyer
  assert.equal(order.send_fulfillment_receipt, false);
});

test('a missing street address is said plainly, not invented', () => {
  const { order } = shopifyOrderFor(amazonOrder(), [line]);
  assert.equal(order.shipping_address.address1, '');
  assert.equal(order.shipping_address.city, 'CENTENNIAL PARK');
  assert.equal(order.shipping_address.zip, '2021');
  assert.match(order.note, /Seller Central/);
  // Nothing plausible-looking in the blank.
  assert.ok(!/unknown|n\/a|tbc|placeholder/i.test(JSON.stringify(order.shipping_address)));
});

test('a full address is used as given, with no note about Seller Central', () => {
  const { order } = shopifyOrderFor(
    amazonOrder({ ShippingAddress: { AddressLine1: '12 Oxford St', Name: 'A Buyer',
      City: 'PADDINGTON', StateOrRegion: 'NSW', PostalCode: '2021', CountryCode: 'AU' } }),
    [line]);
  assert.equal(order.shipping_address.address1, '12 Oxford St');
  assert.equal(order.shipping_address.name, 'A Buyer');
  assert.doesNotMatch(order.note, /Seller Central/);
});

test('several lines all reach the order', () => {
  const { order } = shopifyOrderFor(amazonOrder(), [
    line, { shopify_variant_id: 999, quantity: 2, unit_price: 10, sku: 'X' }]);
  assert.equal(order.line_items.length, 2);
  assert.equal(order.line_items[1].quantity, 2);
});
