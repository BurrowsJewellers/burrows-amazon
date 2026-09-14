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
 * Words that describe almost any piece we sell and so tell us nothing about whether
 * two listings are the same piece. Counting them makes unrelated products look alike:
 * "Thomas Sabo Blackened Silver Fine Venezia Chain" and "Thomas Sabo Ladies Little
 * Secret Tree of Love 925 Sterling Silver Chain" share four words and none of them
 * mean anything — brand twice, metal, and the word chain.
 */
const GENERIC = new Set([
  'silver', 'gold', 'sterling', '925', 'plated', 'rose', 'white', 'yellow', 'black',
  'steel', 'stainless', 'leather', 'titanium', 'platinum', 'bronze',
  'necklace', 'bracelet', 'ring', 'earring', 'earrings', 'pendant', 'charm', 'chain',
  'watch', 'band', 'strap', 'bangle', 'stud', 'studs', 'hoop', 'hoops', 'anklet',
  'ladies', 'lady', 'mens', 'men', 'women', 'womens', 'unisex', 'girls', 'boys',
  'the', 'and', 'with', 'for', 'set', 'new', 'size', 'cttw', 'carat',
]);

/**
 * Does Amazon's title carry our own product code?
 *
 * Manufacturer codes are the strongest evidence there is, stronger than any wording:
 * our SKU TR2470Y58 against Amazon's "Ladies Gold Teardrop Ring - TR2470-413-39-58" is
 * the same ring, however little the prose has in common. Sellers punctuate these codes
 * however they like, so compare them with the punctuation stripped.
 *
 * Only the stem is required. The tail of these codes is colour and size, which the
 * barcode has already pinned down, and demanding the whole thing would reject the very
 * matches this is meant to rescue.
 */
function codeAppears(sku, amazonTitle) {
  const stem = squash(sku);
  const theirs = squash(amazonTitle);
  if (!stem || !theirs) return false;

  const parts = stem.match(/^([a-z]*)(\d+)/);
  if (!parts) return false;
  const [, letters, digits] = parts;

  // Both ends of the code vary between our records and Amazon's: they may drop our
  // leading brand letter (our TX0091S against their X0091-001-12-S) and they almost
  // always carry a different tail, because the tail is colour and size and the barcode
  // has already settled those. So try the stem with leading letters progressively
  // dropped and the digits progressively shortened, longest first.
  for (let keep = 0; keep <= letters.length; keep++) {
    const lead = letters.slice(keep);
    for (let len = digits.length; len >= 3; len--) {
      const candidate = lead + digits.slice(0, len);
      // Short codes match by coincidence, and a bare number more easily than one
      // anchored by letters — so a digits-only candidate has to be longer to count.
      const floor = lead ? 5 : 6;
      if (candidate.length < floor) continue;
      if (theirs.includes(candidate)) return true;
    }
  }
  return false;
}

/**
 * The words that actually identify a piece — its product line, its motif — with the
 * brand and the generic vocabulary stripped out.
 */
function distinctive(title, ourVendor, amazonBrand) {
  const drop = new Set(GENERIC);
  for (const brand of [ourVendor, amazonBrand]) {
    for (const w of words(brand)) drop.add(w);
  }
  const out = new Set();
  for (const w of words(title)) if (!drop.has(w) && !/^\d+$/.test(w)) out.add(w);
  return out;
}

/**
 * @returns {{confidence: 'high'|'review'|'conflict', note: string}}
 *   high     - list it
 *   review   - a person compares them side by side before anything is listed
 *   conflict - a different product. Permanently blocked, never listable.
 */
function scoreMatch({ sku, ourVendor, ourTitle, ourPrice, amazonBrand, amazonTitle, amazonPrice }) {
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

  // Same brand, but nothing identifying in common. This is the shape that produced
  // refunds: right maker, right kind of thing, different piece. The overall word
  // overlap looks reassuring precisely because the words it counts are meaningless.
  const carriesOurCode = codeAppears(sku, amazonTitle);
  if (carriesOurCode && !priceNote) {
    return { confidence: 'high', note: `${brand.why}; Amazon's own title carries our product code` };
  }

  const ourMarks = distinctive(ourTitle, ourVendor, amazonBrand);
  const theirMarks = distinctive(amazonTitle, ourVendor, amazonBrand);
  // Our title says nothing beyond brand and material while Amazon's names a specific
  // motif. There is nothing to check their claim against, and "a plain chain" against
  // "a chain with a heart motif" is a refund waiting to happen.
  if (!ourMarks.size && theirMarks.size) {
    return {
      confidence: 'review',
      note:
        `Our own description is too generic to confirm this. Amazon's listing is for ` +
        `"${[...theirMarks].slice(0, 4).join(' ')}" — check that is what we hold.`,
    };
  }

  if (ourMarks.size && theirMarks.size) {
    let shared = 0;
    for (const w of ourMarks) if (theirMarks.has(w)) shared++;
    if (!shared) {
      return {
        confidence: 'review',
        note:
          `Same barcode and the same brand, but nothing in the names matches: ` +
          `ours is "${[...ourMarks].slice(0, 4).join(' ')}", Amazon's is ` +
          `"${[...theirMarks].slice(0, 4).join(' ')}". Compare them before listing.`,
      };
    }
  }

  if (titleScore >= 0.34 && !priceNote) {
    return { confidence: 'high', note: `${brand.why}; titles agree ${Math.round(titleScore * 100)}%` };
  }

  return {
    confidence: 'review',
    note: `${brand.why}; titles agree ${Math.round(titleScore * 100)}%${priceNote}`,
  };
}

module.exports = { scoreMatch, brandAgrees, distinguishersDisagree, similarity, codeAppears, distinctive };
