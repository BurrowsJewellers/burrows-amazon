'use strict';
/**
 * The brand ban. Confirmed by the owner on 14 September 2026: absolute, no exceptions.
 *
 * Von Treskow, Pandora and Kirstin Ash are never listed on Amazon. Not as an offer
 * against an existing listing, not as a new listing, not by any route.
 *
 * Note that Seller Central holds live Amazon approvals for Von Treskow (Catalogue
 * Authorisation) and Kirstin Ash (GTIN Exemption), both dated 7 March 2025. Those are
 * irrelevant here and must never be read as permission — the ban is a commercial
 * decision, not an Amazon limitation. This module does not consult them.
 */

const BANNED_BRANDS = ['von treskow', 'pandora', 'kirstin ash'];

/**
 * Suppliers whose goods are a banned brand regardless of what the brand field says.
 * Pandora items arrive from Retail Edge with the brand blank — only the supplier code
 * identifies them. Checking the brand field alone would let ~1,900 items through.
 */
const BANNED_SUPPLIERS = ['pando'];

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * @returns {{allowed: boolean, reason: string}}
 *
 * Refuses on three grounds, in order of severity:
 *   - the brand is banned
 *   - the supplier only ever supplies a banned brand
 *   - the brand cannot be determined at all (unknown is treated as unsafe)
 */
function checkBrand({ vendor, supplierId }) {
  const v = norm(vendor);
  const s = norm(supplierId);

  if (s && BANNED_SUPPLIERS.includes(s)) {
    return { allowed: false, reason: `supplier ${supplierId} only supplies a banned brand` };
  }
  if (v && BANNED_BRANDS.includes(v)) {
    return { allowed: false, reason: `${vendor} is never listed on Amazon` };
  }
  if (!v) {
    return { allowed: false, reason: 'no brand could be determined — held rather than guessed at' };
  }
  return { allowed: true, reason: '' };
}

/**
 * The same check, phrased as a hard stop. Call this immediately before any write to
 * Amazon, not only when the candidate list is built: a product can change vendor
 * between being selected and being sent.
 */
function assertListable(product) {
  const { allowed, reason } = checkBrand(product);
  if (!allowed) {
    const err = new Error(`Refusing to list ${product.sku || product.barcode}: ${reason}`);
    err.code = 'BRAND_BANNED';
    throw err;
  }
}

/** SQL fragment for excluding banned brands at selection time. */
const SQL_BRAND_EXCLUSION = `
  lower(coalesce(p.vendor, '')) <> all (array['von treskow','pandora','kirstin ash'])
  and coalesce(p.vendor, '') <> ''
`;

module.exports = { checkBrand, assertListable, BANNED_BRANDS, BANNED_SUPPLIERS, SQL_BRAND_EXCLUSION };
