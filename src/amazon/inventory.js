'use strict';
const config = require('../config');
const { request } = require('./client');

/**
 * Amazon's listings search stops at 1,000 results and then simply stops offering a
 * next page — no error, no marker, nothing to distinguish "that is all of them" from
 * "that is all you may have". Enumerating the account therefore cannot be trusted to
 * be complete, and a job built on it goes quietly blind past the thousandth listing.
 *
 * So instead of asking Amazon what it has, we ask about the SKUs we know we sent.
 * Twenty at a time, which is the most the search accepts, and the answer is exact
 * however many listings the account grows to.
 *
 * Returns a Map of SKU -> the listing Amazon holds. A SKU missing from the Map is one
 * Amazon does not have.
 */
async function fetchBySku(skus, includedData = 'summaries,offers,fulfillmentAvailability') {
  const found = new Map();
  const batches = [];
  for (let i = 0; i < skus.length; i += 20) batches.push(skus.slice(i, i + 20));

  for (const batch of batches) {
    const res = await request(
      `/listings/2021-08-01/items/${encodeURIComponent(config.amazon.sellerId)}`,
      {
        query: {
          marketplaceIds: config.amazon.marketplaceId,
          identifiers: batch.join(','),
          identifiersType: 'SKU',
          includedData,
          pageSize: 20,
          issueLocale: 'en_AU',
        },
      }
    );
    for (const item of res.items || []) found.set(item.sku, item);
  }
  return found;
}

/**
 * The quantity Amazon actually holds, by SKU.
 *
 * null means Amazon has the listing but has not set a quantity on it yet — which is
 * emphatically not zero, and correcting it as though it were would read as sold out.
 * A SKU absent from the Map is one Amazon does not have at all.
 */
function quantityOf(item) {
  const fa = item.fulfillmentAvailability || [];
  if (!fa.length) return null;
  const qty = Number(fa[0].quantity);
  return Number.isFinite(qty) ? qty : null;
}

/** Amazon's own status words for a listing, as a plain array. */
function statusOf(item) {
  const s = (item.summaries || [])[0] || {};
  return Array.isArray(s.status) ? s.status : [s.status].filter(Boolean);
}

module.exports = { fetchBySku, quantityOf, statusOf };
