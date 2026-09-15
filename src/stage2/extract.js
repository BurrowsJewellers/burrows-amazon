'use strict';
/**
 * Reading product attributes out of the text we already hold.
 *
 * **Titles and tags only. Never the description.** The descriptions on dropship stock
 * are brand boilerplate — every Thomas Sabo product carries the same paragraph about
 * the house being "a global trendsetter in jewellery and watches". Mined for
 * attributes it yields "unisex" and "oval" for a woman's ring, confidently and at
 * scale. Measured on a sample of 40: the description matched a gender on 22 and a
 * shape on 7, and almost none of it was about the product.
 *
 * Everything here reports where it got its answer. A value read out of the title is a
 * fact about the product; a value we had to assume is a guess that happens to be right
 * most of the time, and the two must not be allowed to look alike — so they are
 * recorded separately and the assumptions are counted where someone can see them.
 */

/** Ordered: the first match wins, so the more specific phrasings come first. */
const METAL_WORDS = [
  [/stainless\s*steel/i, 'Stainless Steel'],
  [/sterling\s*silver/i, 'Sterling Silver'],
  [/rose\s*gold/i, 'Rose Gold'],
  [/yellow\s*gold/i, 'Yellow Gold'],
  [/white\s*gold/i, 'White Gold'],
  [/gold[-\s]*plated|gold[-\s]*tone/i, 'Gold Plated'],
  [/rose[-\s]*tone/i, 'Rose Gold'],
  [/\btitanium\b/i, 'Titanium'],
  [/\bceramic\b/i, 'Ceramic'],
  [/\bleather\b/i, 'Leather'],
  [/\bsilicone\b|\brubber\b/i, 'Silicone'],
  [/\bmesh\b/i, 'Stainless Steel'],
  [/\bgold\b/i, 'Gold'],
  [/\bsilver\b/i, 'Silver'],
  [/\bsteel\b/i, 'Stainless Steel'],
];

const COLOUR_WORDS = [
  /\bblack\b/i, /\bwhite\b/i, /\bnavy\b/i, /\bblue\b/i, /\bgreen\b/i, /\bbrown\b/i,
  /\bpink\b/i, /\bred\b/i, /\bgrey\b/i, /\bgray\b/i, /\bcream\b/i, /\bchampagne\b/i,
  /\btan\b/i, /\bturquoise\b/i, /\bpurple\b/i, /\bgold\b/i, /\bsilver\b/i, /\brose\b/i,
];

/** Amazon's shapes, against the ways a title writes them. */
const SHAPE_WORDS = [
  [/\brectangular\b|\brectangle\b/i, 'Rectangular'],
  [/\bsquare\b/i, 'Square'],
  [/\boval\b/i, 'Oval'],
  [/\btonneau\b|\bbarrel\b/i, 'Tonneau'],
  [/\boctagonal\b|\boctagon\b/i, 'Octagonal'],
  [/\bhexagonal\b|\bhexagon\b/i, 'Hexagonal'],
  [/\bheart\b/i, 'Heart'],
  [/\boblong\b/i, 'Oblong'],
  [/\bround\b|\bcircular\b/i, 'Round'],
];

/**
 * Amazon's calendar types. A title that names a complication tells us it is there; a
 * title that names none is very rarely hiding one, and "No Calendar" is a real value
 * rather than a placeholder — so this is the one assumption that is usually a fact.
 */
const CALENDAR_WORDS = [
  [/\bday[-\s]*date\b/i, 'Day-Date'],
  [/\bmoon\s*phase\b/i, 'Date-Moon Phase'],
  [/\bperpetual\b/i, 'Day-Date-Month-Year'],
  [/\bchronograph\b|\bdate\b/i, 'Date'],
];

const found = (value, source) => ({ value, source });

function metalFrom(title) {
  for (const [re, value] of METAL_WORDS) if (re.test(title)) return found(value, 'title');
  return null;
}

function colourFrom(title) {
  for (const re of COLOUR_WORDS) {
    const m = title.match(re);
    if (m) return found(m[0][0].toUpperCase() + m[0].slice(1).toLowerCase(), 'title');
  }
  return null;
}

function shapeFrom(title) {
  for (const [re, value] of SHAPE_WORDS) if (re.test(title)) return found(value, 'title');
  // No neutral value exists — Amazon's thirteen shapes are all specific. Round is the
  // overwhelming majority of what we stock, so it is the least wrong default, but it
  // is a guess and is marked as one.
  return found('Round', 'assumed');
}

function calendarFrom(title) {
  for (const [re, value] of CALENDAR_WORDS) if (re.test(title)) return found(value, 'title');
  return found('No Calendar', 'assumed');
}

/** Gender, from the shop's own tag where there is one — it is structured and reliable. */
function genderFrom(title, tags) {
  const tag = String(tags || '').match(/target-group-([A-Za-z]+)/i);
  if (tag) {
    const t = tag[1].toLowerCase();
    if (/ladies|female|women/.test(t)) return found('female', 'tag');
    if (/gents|male|men/.test(t)) return found('male', 'tag');
    if (/unisex/.test(t)) return found('unisex', 'tag');
  }
  if (/\bladies\b|\bwomen'?s?\b|\bfemale\b/i.test(title)) return found('female', 'title');
  if (/\bgents?\b|\bmen'?s?\b|\bmale\b/i.test(title)) return found('male', 'title');
  if (/\bunisex\b/i.test(title)) return found('unisex', 'title');
  return found('unisex', 'assumed');
}

const DEPARTMENT = { female: "Women's", male: "Men's", unisex: 'Unisex' };

/**
 * Everything we can say about a watch from its title and tags.
 * @returns {{attributes: object, assumed: string[]}}
 */
function watchAttributes({ title, tags }) {
  const t = String(title || '');
  const gender = genderFrom(t, tags);
  const picks = {
    target_gender: gender,
    department: found(DEPARTMENT[gender.value], gender.source),
    item_shape: shapeFrom(t),
    calendar_type: calendarFrom(t),
    color: colourFrom(t) || found(metalFrom(t)?.value || 'Silver', metalFrom(t) ? 'title' : 'assumed'),
    // A manufacturer's warranty is a limited one. That is a fact about warranties, not
    // a guess about this watch.
    warranty_type: found('Limited', 'known'),
  };
  const assumed = Object.entries(picks).filter(([, v]) => v.source === 'assumed').map(([k]) => k);
  return { picks, assumed };
}

/** Stones named in a title. Same rule as everything else here: title only. */
const STONE_WORDS = [
  /\bdiamond\b/i, /\bsapphire\b/i, /\bruby\b/i, /\bemerald\b/i, /\bpearl\b/i,
  /\bamethyst\b/i, /\btopaz\b/i, /\bopal\b/i, /\bgarnet\b/i, /\baquamarine\b/i,
  /\bperidot\b/i, /\bcitrine\b/i, /\btanzanite\b/i, /\bturquoise\b/i, /\bonyx\b/i,
  /cubic\s*zirconia/i, /\bzirconia\b/i, /\bmoissanite\b/i, /\bmorganite\b/i,
  /\bquartz\b/i, /\bcrystal\b/i, /\bmoonstone\b/i, /\bmalachite\b/i, /\blapis\b/i,
];

function stoneFrom(title) {
  for (const re of STONE_WORDS) {
    const m = String(title || '').match(re);
    if (m) return found(m[0], 'title');
  }
  return null;
}

module.exports = { metalFrom, colourFrom, shapeFrom, calendarFrom, genderFrom, stoneFrom, watchAttributes };
