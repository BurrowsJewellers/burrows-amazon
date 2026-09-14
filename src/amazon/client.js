'use strict';
const config = require('../config');
const { accessToken } = require('./auth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One way in and out of the SP-API.
 *
 * Handles the two things every call needs: a current access token, and patience.
 * Amazon throttles aggressively and answers 429; retrying immediately makes it worse,
 * so each attempt waits longer than the last.
 *
 * Writes are refused outright unless the channel is switched on, so a mistake in a
 * job cannot reach Amazon while the switch is off.
 */
async function request(path, { method = 'GET', query, body, allowWrite = false } = {}) {
  if (method !== 'GET' && !config.channelEnabled) {
    const err = new Error('AMAZON_CHANNEL_ENABLED is false — refusing to write to Amazon');
    err.code = 'CHANNEL_DISABLED';
    throw err;
  }
  if (method !== 'GET' && !allowWrite) {
    const err = new Error(`Write to ${path} attempted without allowWrite`);
    err.code = 'WRITE_NOT_ALLOWED';
    throw err;
  }

  const url = new URL(config.amazon.endpoint + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        'x-amz-access-token': await accessToken(),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.ok) return res.status === 204 ? null : res.json();

    const text = await res.text();

    // Throttled or Amazon having a moment: back off and try again.
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Amazon returned ${res.status}`);
      await sleep(Math.min(60_000, 2 ** attempt * 2000));
      continue;
    }

    const err = new Error(`Amazon returned ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  throw lastError || new Error('Amazon did not respond after several attempts');
}

/**
 * Look barcodes up in Amazon's catalogue. Up to 20 at a time, which is why a full
 * catalogue pass takes minutes rather than hours.
 *
 * Returns a Map of barcode -> item. A barcode missing from the Map is one Amazon
 * does not recognise. Results are mapped back by the identifiers Amazon echoes, never
 * by position, so a partial response cannot shift products onto the wrong barcode.
 */
async function lookupByBarcode(barcodes) {
  if (!barcodes.length) return new Map();
  if (barcodes.length > 20) throw new Error('Amazon accepts at most 20 identifiers per lookup');

  const data = await request('/catalog/2022-04-01/items', {
    query: {
      identifiers: barcodes.join(','),
      identifiersType: 'EAN',
      marketplaceIds: config.amazon.marketplaceId,
      includedData: 'identifiers,summaries,images',
    },
  });

  const found = new Map();
  const wanted = new Map(barcodes.map((b) => [b.replace(/^0+/, ''), b]));

  for (const item of data.items || []) {
    for (const group of item.identifiers || []) {
      for (const id of group.identifiers || []) {
        if (!['EAN', 'UPC', 'GTIN'].includes(id.identifierType)) continue;
        const original = wanted.get(String(id.identifier || '').replace(/^0+/, ''));
        if (original) found.set(original, item);
      }
    }
  }

  // A single-barcode lookup does not always echo the identifier back.
  if (barcodes.length === 1 && !found.size && (data.items || []).length) {
    found.set(barcodes[0], data.items[0]);
  }
  return found;
}

/** Flatten what we care about out of Amazon's catalogue shape. */
function summarise(item) {
  const s = (item.summaries || [])[0] || {};
  const image = ((item.images || [])[0]?.images || [])[0]?.link || null;
  return {
    asin: item.asin || null,
    title: s.itemName || '',
    brand: s.brand || s.manufacturer || '',
    image,
  };
}

module.exports = { request, lookupByBarcode, summarise };
