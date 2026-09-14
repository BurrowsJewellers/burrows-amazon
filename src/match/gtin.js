'use strict';
/**
 * GTIN validation. A populated barcode field is not a barcode: of 13,548 variants on
 * the store, 12,425 had something in the field but only 9,428 were real GTINs. The
 * rest were internal stock codes like IE-EJ4-9MM, values too short to be a GTIN, or
 * 30 that were the right shape but failed their check digit.
 */

/** EAN-8, UPC-A, EAN-13 and GTIN-14, verified by the GS1 check digit. */
function isValidGtin(value) {
  const bc = String(value || '').trim();
  if (!/^\d+$/.test(bc)) return false;
  if (![8, 12, 13, 14].includes(bc.length)) return false;

  const digits = [...bc].map(Number);
  const check = digits.pop();
  let total = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    total += digits[i] * weight;
  }
  return (10 - (total % 10)) % 10 === check;
}

/** Why a barcode was rejected, in words a person can act on. */
function explainGtin(value) {
  const bc = String(value || '').trim();
  if (!bc) return 'no barcode recorded';
  if (!/^\d+$/.test(bc)) return `not a barcode — "${bc}" contains letters or symbols, so it is an internal code`;
  if (![8, 12, 13, 14].includes(bc.length)) return `wrong length — ${bc.length} digits, a barcode has 8, 12, 13 or 14`;
  if (!isValidGtin(bc)) return 'fails its check digit — likely mistyped, worth re-keying from the tag';
  return '';
}

module.exports = { isValidGtin, explainGtin };
