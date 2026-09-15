'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

/**
 * The decision the stock sync makes when Amazon holds less than we do. Extracted here
 * exactly as the job applies it, because the cost of getting it wrong is selling a
 * one-of-a-kind piece twice.
 */
function wouldRaise({ amazonQty, liveQty, sentQty, sold }) {
  const want = Math.max(0, liveQty);
  if (amazonQty === want) return { act: 'nothing' };
  if (want > amazonQty) {
    if (!sold) return { act: 'hold', why: 'recent orders unavailable' };
    const sale = sold.get('SKU');
    if (sale && sale.units >= want - amazonQty && Number(liveQty) === Number(sentQty)) {
      return { act: 'hold', why: 'sold on Amazon, shop has not recorded it' };
    }
  }
  return { act: 'write', qty: want };
}

const aSale = (units) => new Map([['SKU', { units, orders: ['250-1'], latest: '2026-09-15' }]]);

test('a sold single piece is not put back on sale', () => {
  // Amazon took it to 0 on the sale; Retail Edge has not caught up, so we still say 1.
  const r = wouldRaise({ amazonQty: 0, liveQty: 1, sentQty: 1, sold: aSale(1) });
  assert.equal(r.act, 'hold');
});

test('once the shop records the sale, the zero is confirmed', () => {
  const r = wouldRaise({ amazonQty: 0, liveQty: 0, sentQty: 1, sold: aSale(1) });
  assert.equal(r.act, 'nothing');
});

test('a genuine restock after a sale still goes up', () => {
  // Our figure has moved — 3 is not the 1 we last sent — so this is new stock.
  const r = wouldRaise({ amazonQty: 0, liveQty: 3, sentQty: 1, sold: aSale(1) });
  assert.deepEqual(r, { act: 'write', qty: 3 });
});

test('a listing Amazon zeroed by itself is still reopened', () => {
  // No sale explains the drop, so this is Amazon being odd — exactly the thirteen
  // closed listings found on 14 Sep, which were right to reopen.
  const r = wouldRaise({ amazonQty: 0, liveQty: 8, sentQty: 8, sold: new Map() });
  assert.deepEqual(r, { act: 'write', qty: 8 });
});

test('a sale too small to explain the gap does not hold the rest back', () => {
  // Amazon is at 1, we hold 5, one sold. The sale accounts for one unit, not four.
  const r = wouldRaise({ amazonQty: 1, liveQty: 5, sentQty: 5, sold: aSale(1) });
  assert.equal(r.act, 'write');
});

test('lowering is never held back', () => {
  const r = wouldRaise({ amazonQty: 4, liveQty: 0, sentQty: 4, sold: aSale(1) });
  assert.deepEqual(r, { act: 'write', qty: 0 });
});

test('if orders cannot be read, nothing is raised', () => {
  const r = wouldRaise({ amazonQty: 0, liveQty: 1, sentQty: 1, sold: null });
  assert.equal(r.act, 'hold');
});
