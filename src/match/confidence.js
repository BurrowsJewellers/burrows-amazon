'use strict';
/**
 * Deciding whether a barcode match is really the same product.
 *
 * An exact GTIN match is not proof. Amazon's catalogue is seller-entered and never
 * verified against GS1, so a barcode can be attached to something else entirely.
 * Cases found in the live catalogue on 14 Sep 2026, all exact barcode matches:
 *
 *   Citizen Gents Stainless Steel Watch  ->  Maui Jim Snapback sunglasses
 *   PdPaola Mini Letter W Necklace       ->  Mini Letter N Necklace
 *   Ania Haie Silver Pearl Link Bracelet ->  Stack Ring Co Infinity bracelet
 *
 * The middle one is why brand agreement alone is not enough: right brand, right
 * product line, wrong letter. Shipping it means a refund.
 */

// Brands that are genuinely the same thing under a different name. The watch entries
// are distributor-vs-maker: Hirsch straps reach us through Duraflex.
const ALIASES = new Map([
  ['gshock', 'casio'],
  ['duraflexwatchbands', 'hirsch'],
  ['duraflex', 'hirsch'],
]);

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const words = (s) =>
  new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );

/** Longest-common-subsequence ratio, enough to catch spelling variants. */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (2 * prev[n]) / (m + n);
}

function brandAgrees(ourVendor, amazonBrand, amazonTitle) {
  let a = squash(ourVendor);
  let b = squash(amazonBrand);
  a = ALIASES.get(a) || a;
  b = ALIASES.get(b) || b;

  if (!a) return { ok: false, why: 'we have no brand for this product' };
  if (!b) {
    // Amazon sometimes leaves the brand field empty but names it in the title.
    if (squash(amazonTitle).includes(a)) {
      return { ok: true, why: 'Amazon lists no brand, but their title names it' };
    }
    return { ok: false, why: 'Amazon lists no brand for this listing' };
  }
  if (a.includes(b) || b.includes(a)) return { ok: true, why: 'brand matches' };
  if (similarity(a, b) >= 0.85) {
    return { ok: true, why: `brand matches (spelt differently: ${ourVendor} / ${amazonBrand})` };
  }
  if (squash(amazonTitle).includes(a)) {
    return { ok: true, why: `their brand field says ${amazonBrand}, but their title names ${ourVendor}` };
  }
  return { ok: false, why: `different brand: ours is ${ourVendor}, Amazon says ${amazonBrand}` };
}

/**
 * Numbers and single letters inside a title are the difference between the right
 * ring size and the wrong one, or Letter W and Letter N. If both titles carry such
 * a token and they disagree, that is a conflict no matter how similar the rest is.
 */
function distinguishersDisagree(ourTitle, amazonTitle) {
  const grab = (s) => {
    const out = new Set();
    const t = String(s || '').toLowerCase();
    for (const m of t.matchAll(/\bletter\s+([a-z])\b/g)) out.add('letter:' + m[1]);
    for (const m of t.matchAll(/\bsize\s+([a-z0-9]{1,3})\b/g)) out.add('size:' + m[1]);
    return out;
  };
  const ours = grab(ourTitle);
  const theirs = grab(amazonTitle);
  if (!ours.size || !theirs.size) return null;

  for (const kind of ['letter', 'size']) {
    const a = [...ours].filter((x) => x.startsWith(kind + ':'));
    const b = [...theirs].filter((x) => x.startsWith(kind + ':'));
    if (a.length && b.length && !a.some((x) => b.includes(x))) {
      return `${kind} differs: ours says ${a.join(', ').split(':')[1]}, Amazon says ${b.join(', ').split(':')[1]}`;
    }
  }
  return null;
}

/**
 * @returns {{confidence: 'high'|'review'|'conflict', note: string}}
 *   high     - list it
 *   review   - a person compares them side by side before anything is listed
 *   conflict - a different product. Permanently blocked, never listable.
 */
function scoreMatch({ ourVendor, ourTitle, ourPrice, amazonBrand, amazonTitle, amazonPrice }) {
  const disagreement = distinguishersDisagree(ourTitle, amazonTitle);
  if (disagreement) {
    return { confidence: 'conflict', note: `Same barcode, different item — ${disagreement}` };
  }

  const brand = brandAgrees(ourVendor, amazonBrand, amazonTitle);

  const ours = words(ourTitle);
  const theirs = words(amazonTitle);
  let overlap = 0;
  for (const w of ours) if (theirs.has(w)) overlap++;
  const titleScore = overlap / Math.max(1, Math.min(ours.size, theirs.size));

  // A wild price gap means a different object even when the words look alike.
  let priceNote = '';
  if (ourPrice > 0 && amazonPrice > 0) {
    const ratio = Math.max(ourPrice, amazonPrice) / Math.min(ourPrice, amazonPrice);
    if (ratio >= 5) {
      return {
        confidence: 'conflict',
        note: `Same barcode, but prices are wildly apart — ours $${ourPrice}, Amazon $${amazonPrice}`,
      };
    }
    if (ratio >= 2.5) priceNote = `; prices differ a lot (ours $${ourPrice}, Amazon $${amazonPrice})`;
  }

  if (!brand.ok) {
    // Brand disagrees and the words do not rescue it: treat as a different product.
    if (titleScore < 0.5) {
      return { confidence: 'conflict', note: `${brand.why}; titles agree only ${Math.round(titleScore * 100)}%` };
    }
    return {
      confidence: 'review',
      note: `${brand.why} — but titles agree ${Math.round(titleScore * 100)}%, so it may be the same item listed badly${priceNote}`,
    };
  }

  if (titleScore >= 0.34 && !priceNote) {
    return { confidence: 'high', note: `${brand.why}; titles agree ${Math.round(titleScore * 100)}%` };
  }

  return {
    confidence: 'review',
    note: `${brand.why}; titles agree ${Math.round(titleScore * 100)}%${priceNote}`,
  };
}

module.exports = { scoreMatch, brandAgrees, distinguishersDisagree, similarity };
