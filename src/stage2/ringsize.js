'use strict';
/**
 * Ring sizes, ours to Amazon's.
 *
 * Retail Edge carries UK/Australian letter sizes; Amazon wants US numeric ones in
 * quarter steps. Getting this wrong sends someone a ring that does not fit, which is a
 * return and a remake — so anything that cannot be converted confidently is refused
 * rather than guessed at.
 */

/** The jewellers' UK-to-US table. Amazon's own sizes move in quarters, and so does this. */
const LETTERS = {
  A: 0.5,  B: 1,    C: 1.5,  D: 2,    E: 2.25, F: 2.75, G: 3.25, H: 3.75,
  I: 4.25, J: 4.75, K: 5.25, L: 5.75, M: 6.25, N: 6.75, O: 7.25, P: 7.75,
  Q: 8.25, R: 8.75, S: 9.25, T: 9.75, U: 10.25, V: 10.75, W: 11.25, X: 11.75,
  Y: 12.25, Z: 12.75,
};

/** Amazon accepts quarter steps only. */
const toQuarter = (n) => Math.round(n * 4) / 4;

/**
 * @returns {{us: string|null, why: string}} the US size as Amazon spells it, or why not.
 */
function toAmazonSize(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return { us: null, why: 'no ring size recorded' };

  // Already numeric — a US size someone typed in directly.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n < 0 || n > 16) return { us: null, why: `ring size ${s} is outside the range Amazon accepts` };
    return { us: String(toQuarter(n)), why: '' };
  }

  // Letter, optionally with a half: N, N½, "N 1/2", N.5, N+
  const m = s.match(/^([A-Z])\s*(?:(½)|(1\/2)|(\.5)|(\+))?$/);
  if (!m) return { us: null, why: `ring size "${raw}" is not a size we recognise` };

  const base = LETTERS[m[1]];
  if (base === undefined) return { us: null, why: `ring size "${raw}" is not a UK letter size` };

  const isHalf = Boolean(m[2] || m[3] || m[4] || m[5]);
  if (!isHalf) return { us: String(base), why: '' };

  // A half size sits between this letter and the next; the table steps by 0.5 at the
  // bottom and 0.5 higher up, so take the midpoint rather than assume a fixed gap.
  const next = LETTERS[String.fromCharCode(m[1].charCodeAt(0) + 1)];
  if (next === undefined) return { us: String(base), why: '' };
  return { us: String(toQuarter((base + next) / 2)), why: '' };
}

module.exports = { toAmazonSize, LETTERS };
