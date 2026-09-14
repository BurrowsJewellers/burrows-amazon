'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { scoreMatch } = require('../src/match/confidence');

// Every case below is real: found in Amazon's live catalogue on 14 September 2026,
// each one an exact barcode match that points at the wrong product.

test('the Letter W / Letter N necklace is caught', () => {
  const r = scoreMatch({
    ourVendor: 'PDPaola', ourTitle: 'PdPaola Mini Letter W Necklace', ourPrice: 149,
    amazonBrand: 'P D PAOLA', amazonTitle: 'Mini Letter N Necklace Letter Name Chain', amazonPrice: 149,
  });
  assert.strictEqual(r.confidence, 'conflict', 'right brand, right line, wrong letter must not list');
});

test('a watch barcode pointing at sunglasses is caught', () => {
  const r = scoreMatch({
    ourVendor: 'Citizen', ourTitle: 'Citizen Gents Stainless Steel Work Watch', ourPrice: 399,
    amazonBrand: 'Maui Jim', amazonTitle: 'Maui Jim Maui Snapback 73002M Mens/Womens Sunglasses', amazonPrice: 289,
  });
  assert.strictEqual(r.confidence, 'conflict');
});

test('a recycled barcode on another brand is caught', () => {
  const r = scoreMatch({
    ourVendor: 'Ania Haie', ourTitle: 'Ania Haie Silver Pearl Link Chain Bracelet', ourPrice: 119,
    amazonBrand: 'Stack Ring Co', amazonTitle: 'Stack Ring Co,Infinity,Sterling Silver Link', amazonPrice: 39,
  });
  assert.strictEqual(r.confidence, 'conflict');
});

test('a genuine match still lists', () => {
  const r = scoreMatch({
    ourVendor: 'Thomas Sabo', ourTitle: 'Thomas Sabo Black Onyx Compass Signet Ring', ourPrice: 379,
    amazonBrand: 'Thomas Sabo', amazonTitle: 'Thomas Sabo Unisex Ring compass black 925 Sterling Silver', amazonPrice: 349,
  });
  assert.strictEqual(r.confidence, 'high');
});

test('a brand spelt differently is not treated as a different product', () => {
  const r = scoreMatch({
    ourVendor: 'BronzeAllure', ourTitle: 'Bronzallure Rosary with Natural Stones', ourPrice: 309,
    amazonBrand: 'Bronzallure', amazonTitle: 'Bronzallure Rosary With Natural Stones 45cm', amazonPrice: 299,
  });
  assert.strictEqual(r.confidence, 'high');
});

test('G-Shock filed under Casio is the same product', () => {
  const r = scoreMatch({
    ourVendor: 'G-Shock', ourTitle: 'G-Shock Mudmaster Carbon Core Watch', ourPrice: 599,
    amazonBrand: 'Casio', amazonTitle: 'Casio G-Shock Mudmaster Carbon Core Guard Watch', amazonPrice: 579,
  });
  assert.strictEqual(r.confidence, 'high');
});
