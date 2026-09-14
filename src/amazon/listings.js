'use strict';
const config = require('../config');
const { request } = require('./client');

/**
 * Creating an offer against a listing Amazon already has.
 *
 * This is the "send an offer" route: we supply a price, a quantity and the ASIN, and
 * nothing else. `LISTING_OFFER_ONLY` tells Amazon we are not authoring catalogue
 * content — which is why this works without brand approval, and why it can never
 * alter someone else's product page.
 */
async function putOffer({ sku, asin, price, quantity }) {
  if (!asin) throw new Error(`${sku}: refusing to send an offer with no ASIN`);
  if (!(price > 0)) throw new Error(`${sku}: refusing to send an offer with no price`);

  const body = {
    productType: 'PRODUCT',
    requirements: 'LISTING_OFFER_ONLY',
    attributes: {
      condition_type: [{ value: 'new_new', marketplace_id: config.amazon.marketplaceId }],
      merchant_suggested_asin: [{ value: asin, marketplace_id: config.amazon.marketplaceId }],
      purchasable_offer: [{
        currency: 'AUD',
        marketplace_id: config.amazon.marketplaceId,
        our_price: [{ schedule: [{ value_with_tax: Number(price.toFixed(2)) }] }],
      }],
      fulfillment_availability: [{
        fulfillment_channel_code: 'DEFAULT',
        quantity: Math.max(0, Math.floor(quantity)),
      }],
    },
  };

  const path = `/listings/2021-08-01/items/${encodeURIComponent(config.amazon.sellerId)}/${encodeURIComponent(sku)}`;
  return request(path, {
    method: 'PUT',
    query: { marketplaceIds: config.amazon.marketplaceId, issueLocale: 'en_AU' },
    body,
    allowWrite: true,
  });
}

/** Take an offer down without destroying the SKU's history. */
async function setQuantity({ sku, quantity }) {
  const path = `/listings/2021-08-01/items/${encodeURIComponent(config.amazon.sellerId)}/${encodeURIComponent(sku)}`;
  return request(path, {
    method: 'PATCH',
    query: { marketplaceIds: config.amazon.marketplaceId, issueLocale: 'en_AU' },
    body: {
      productType: 'PRODUCT',
      patches: [{
        op: 'replace',
        path: '/attributes/fulfillment_availability',
        value: [{ fulfillment_channel_code: 'DEFAULT', quantity: Math.max(0, Math.floor(quantity)) }],
      }],
    },
    allowWrite: true,
  });
}

/**
 * Amazon's rejections, in words someone can act on. Anything unrecognised keeps
 * Amazon's own message rather than being flattened into "unknown error".
 */
const TRANSLATIONS = [
  [/not (?:authorized|approved).*brand|brand.*not.*approved/i,
   'Not approved to sell this brand on Amazon',
   'Apply for brand authorisation in Seller Central, then release these for retry.'],
  [/gtin|ean|upc.*(?:invalid|not found|does not match)/i,
   'Amazon does not accept this barcode for this product',
   'The barcode may be wrong in Retail Edge, or Amazon has it against a different item. Check the barcode on the tag.'],
  [/asin.*(?:not found|does not exist|invalid)/i,
   'The Amazon listing we matched to no longer exists',
   'It was withdrawn since we matched it. Re-run the catalogue match to find a current one.'],
  [/price.*(?:high|low|policy|fair)/i,
   'Amazon rejected the price as outside their fair-pricing policy',
   'Check the retail price is right. A data error is far more likely than a genuine policy problem.'],
  [/duplicate|already exists/i,
   'This product is already listed under a different SKU',
   'Find the existing listing in Seller Central and remove one of the two.'],
  [/restricted|gated|approval required/i,
   'This product or category needs approval before you can sell it',
   'Apply in Seller Central, or accept that this product cannot be sold on Amazon.'],
  [/missing|required attribute/i,
   'Amazon wants a detail we did not send',
   'Usually one field for a whole category — tell me the message and I will add it, then retry the group.'],
];

function explain(code, message) {
  for (const [re, plain, fix] of TRANSLATIONS) {
    if (re.test(message || '') || re.test(code || '')) return { plain, fix };
  }
  return { plain: message || 'Amazon rejected this listing', fix: 'Send me the message and I will work out what it needs.' };
}

/** Amazon reports failure inside a 200 response, so success has to be read, not assumed. */
function readResult(response) {
  const issues = (response && response.issues) || [];
  const errors = issues.filter((i) => i.severity === 'ERROR');
  if (errors.length) {
    return { ok: false, errors: errors.map((e) => ({ code: e.code, message: e.message, ...explain(e.code, e.message) })) };
  }
  return { ok: true, warnings: issues.filter((i) => i.severity === 'WARNING').map((i) => i.message) };
}

module.exports = { putOffer, setQuantity, readResult, explain };
