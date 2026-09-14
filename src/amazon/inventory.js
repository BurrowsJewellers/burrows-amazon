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

/** One window's worth of listings, following its pages to the end. */
async function pageThrough(query) {
  const out = [];
  let token = null;
  for (let page = 0; page < 60; page++) {
    const res = await request(
      `/listings/2021-08-01/items/${encodeURIComponent(config.amazon.sellerId)}`,
      { query: token ? { ...query, pageToken: token } : query }
    );
    out.push(...(res.items || []));
    token = res.pagination?.nextToken || null;
    if (!token) break;
  }
  return out;
}

/** Amazon stops at this many results per query and says nothing about it. */
const RESULT_CAP = 1000;

/**
 * Every listing on the account, including ones we have no record of.
 *
 * Needed only where the question is "what is on Amazon that should not be" — the brand
 * ban's backstop. Asking by SKU cannot answer that, because the whole point is to find
 * SKUs we do not know about.
 *
 * The search caps at 1,000 results with no indication it has done so, so instead of
 * asking for the account we ask for slices of time and split any slice that comes back
 * at the cap. A window that returns fewer than the cap is complete by definition.
 */
async function enumerateAll(includedData = 'summaries', onProgress) {
  const found = new Map();
  const base = { marketplaceIds: config.amazon.marketplaceId, includedData, pageSize: 20 };
  const truncated = [];

  async function scan(after, before, depth) {
    const query = { ...base, lastUpdatedAfter: after.toISOString() };
    if (before) query.lastUpdatedBefore = before.toISOString();

    const items = await pageThrough(query);

    // Under the cap means we have the whole window. At the cap it is almost certainly
    // cut short, so halve it and ask again.
    if (items.length >= RESULT_CAP && before && depth < 24) {
      const mid = new Date((after.getTime() + before.getTime()) / 2);
      if (mid > after && mid < before) {
        await scan(after, mid, depth + 1);
        await scan(mid, before, depth + 1);
        return;
      }
      // The window is already as narrow as it can get and still full: record that we
      // know this slice is incomplete rather than pretending otherwise.
      truncated.push(`${after.toISOString()}..${before.toISOString()}`);
    }

    for (const item of items) found.set(item.sku, item);
    if (onProgress) onProgress(found.size);
  }

  // The account cannot hold anything older than this, and an open-ended upper bound
  // would leave the newest window unsplittable.
  await scan(new Date('2010-01-01T00:00:00Z'), new Date(Date.now() + 86400000), 0);

  return { listings: found, truncated };
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

module.exports = { fetchBySku, enumerateAll, quantityOf, statusOf };
