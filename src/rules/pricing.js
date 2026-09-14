'use strict';
/**
 * What Amazon is charged.
 *
 * Rule from the owner, 14 September 2026: Amazon always gets the full retail price.
 * Shop discounts and sale prices are ours to give in our own stores and on our own
 * site; they are not passed to a marketplace that takes a referral fee off the top.
 *
 * "Retail price" is whichever of these is the real ticket price, in order:
 *   1. the compare-at price, when the item is on sale (that IS the retail price)
 *   2. Retail Edge's ticket price
 *   3. the current selling price, when the item is not discounted at all
 *
 * Taking the highest of the three would be simpler but wrong: a stale ticket price
 * left high in Retail Edge would quietly overcharge. Order of preference keeps the
 * most trustworthy source first.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * @returns {{price: number, basis: string}} the price to send and where it came from,
 *          so the screen can explain any figure a person questions.
 */
function amazonPrice({ sellingPrice, compareAtPrice, retailTicketPrice }) {
  const selling = num(sellingPrice);
  const compare = num(compareAtPrice);
  const ticket = num(retailTicketPrice);

  if (compare > selling) {
    return { price: compare, basis: `retail price — the item is discounted to $${selling} in store` };
  }
  if (ticket > selling) {
    return { price: ticket, basis: `Retail Edge ticket price — selling at $${selling} in store` };
  }
  return { price: selling, basis: 'retail price, not discounted' };
}

/** Margin after Amazon's cut, for the screen. Null when we do not know the cost. */
function marginAfterFees({ price, cost, referralPct = 20 }) {
  const p = num(price);
  const c = num(cost);
  if (!p || !c) return null;
  const net = p * (1 - referralPct / 100);
  return { net: Math.round(net * 100) / 100, profit: Math.round((net - c) * 100) / 100,
           pct: Math.round(((net - c) / p) * 1000) / 10 };
}

module.exports = { amazonPrice, marginAfterFees };
