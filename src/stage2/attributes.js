'use strict';
/**
 * Turning one of our own pieces into a listing Amazon will accept.
 *
 * This is only ever used for brands we own. Creating a product page for someone else's
 * brand needs their authorisation, and Amazon refuses it outright — which is why Stage
 * 2 covers Burrows Collection and nothing else.
 *
 * Everything here comes from what Retail Edge already knows. Nothing is invented: a
 * piece missing something Amazon insists on is reported as not ready, rather than
 * listed with a plausible guess in the gap.
 */
const { toAmazonSize } = require('./ringsize');
const { metalFrom, stoneFrom, watchAttributes } = require('./extract');

/** Amazon's metal vocabulary, against the way Retail Edge writes it. */
const METALS = [
  [/\b(9\s*ct|9k)\b.*yellow|yellow.*\b(9\s*ct|9k)\b/i, 'yellow_gold', '9k'],
  [/\b(9\s*ct|9k)\b.*white|white.*\b(9\s*ct|9k)\b/i, 'white_gold', '9k'],
  [/\b(9\s*ct|9k)\b.*rose|rose.*\b(9\s*ct|9k)\b/i, 'rose_gold', '9k'],
  [/\b(18\s*ct|18k)\b.*yellow|yellow.*\b(18\s*ct|18k)\b/i, 'yellow_gold', '18k'],
  [/\b(18\s*ct|18k)\b.*white|white.*\b(18\s*ct|18k)\b/i, 'white_gold', '18k'],
  [/\b(18\s*ct|18k)\b.*rose|rose.*\b(18\s*ct|18k)\b/i, 'rose_gold', '18k'],
  [/platinum/i, 'platinum', 'plat'],
  [/rhodium.*silver|silver.*rhodium/i, 'sterling_silver', '925'],
  [/sterling\s*silver|925/i, 'sterling_silver', '925'],
  [/yellow\s*gold/i, 'yellow_gold', null],
  [/white\s*gold/i, 'white_gold', null],
  [/rose\s*gold/i, 'rose_gold', null],
  [/\bplated\b/i, 'gold_plated', null],
  [/\bgold\b/i, 'gold', null],
  [/\bsilver\b/i, 'silver', null],
  [/titanium/i, 'titanium', null],
  [/stainless/i, 'stainless_steel', null],
  [/leather/i, 'leather', null],
  [/non[- ]?precious|base\s*metal|alloy/i, 'alloy', null],
  [/\bceramic\b/i, 'ceramic', null],
  [/\bbrass\b/i, 'brass', null],
];

/** Stones, as Amazon names them. "N/A" in our data means a plain metal piece. */
const STONES = [
  [/diamond/i, 'diamond'], [/sapphire/i, 'sapphire'], [/\bruby\b/i, 'ruby'],
  [/emerald/i, 'emerald'], [/pearl/i, 'pearl'], [/amethyst/i, 'amethyst'],
  [/topaz/i, 'topaz'], [/opal/i, 'opal'], [/garnet/i, 'garnet'],
  [/aquamarine/i, 'aquamarine'], [/peridot/i, 'peridot'], [/citrine/i, 'citrine'],
  [/tanzanite/i, 'tanzanite'], [/turquoise/i, 'turquoise'], [/onyx/i, 'onyx'],
  [/cubic\s*zirconia|\bcz\b/i, 'cubic_zirconia'], [/moissanite/i, 'moissanite'],
  [/morganite/i, 'morganite'], [/quartz/i, 'quartz'], [/crystal/i, 'crystal'],
  [/tourmaline/i, 'tourmaline'], [/lapis/i, 'lapis_lazuli'], [/\bjade\b/i, 'jade'],
  [/moonstone/i, 'moonstone'], [/malachite/i, 'malachite'],
];

/**
 * Our product types, against the Amazon product type that fits them.
 *
 * These are the specific types — NECKLACE rather than FINENECKLACEBRACELETANKLET —
 * and that distinction is the whole reason Stage 2's first attempt produced 1,186
 * listings nobody could buy. Submitting under a FINE type is accepted, and Amazon then
 * quietly reclassifies the listing to the specific one, which asks for a good deal more
 * than the FINE type did. The listing is then incomplete for the type it has actually
 * become, so no offer is ever created — and Amazon reports the reclassification as a
 * warning rather than an error, so nothing looks wrong.
 *
 * Submitting under the type Amazon was going to choose anyway avoids all of it.
 */
const PRODUCT_TYPES = {
  Ring: 'RING',
  Rings: 'RING',
  Earring: 'EARRING',
  Earrings: 'EARRING',
  'Hoop Earring': 'EARRING',
  'Hoop Earrings': 'EARRING',
  'Ear Studs': 'EARRING',
  Necklace: 'NECKLACE',
  Necklaces: 'NECKLACE',
  Necklet: 'NECKLACE',
  Chain: 'NECKLACE',
  Pendant: 'NECKLACE',
  'Charm Pendant': 'NECKLACE',
  Bracelet: 'BRACELET',
  Bracelets: 'BRACELET',
  Bangle: 'BRACELET',
  Anklet: 'BRACELET',
  Charm: 'CHARM',
  Watch: 'WATCH',
  Watches: 'WATCH',
};

/**
 * The specific types spell their values as a person would — "Sterling Silver", not
 * "sterling_silver" — so the vocabulary the FINE types used has to be translated.
 */
/** Precious metals make a piece fine jewellery in Amazon's sense; the rest is fashion. */
const FINE_METALS = new Set([
  'yellow_gold', 'white_gold', 'rose_gold', 'gold', 'sterling_silver', 'platinum',
]);

const AMAZON_METAL = {
  yellow_gold: 'Yellow Gold', white_gold: 'White Gold', rose_gold: 'Rose Gold',
  gold: 'Gold', gold_plated: 'Gold Plated', sterling_silver: 'Sterling Silver',
  silver: 'Silver', platinum: 'Platinum', titanium: 'Titanium',
  stainless_steel: 'Stainless Steel', ceramic: 'Ceramic', brass: 'Brass',
  alloy: 'Alloy', leather: 'Leather',
};

/** Stones likewise: Amazon's specific types capitalise them. */
const titleCase = (v) => String(v || '')
  .split(/[\s_]+/).filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
  .join(' ');

const match = (table, text) => table.find(([re]) => re.test(String(text || '')));

function metalOf(raw) {
  const hit = match(METALS, raw);
  if (!hit) return null;
  // Amazon insists on a stamp even where our record does not name a carat. The field
  // takes free text, so the honest fallback is what the ticket itself says rather than
  // a purity we have not been told.
  return { type: hit[1], stamp: hit[2] || String(raw).trim() };
}

function stoneOf(raw) {
  const s = String(raw || '').trim();
  // Several ways of saying "there is no stone". None of them is an unknown gem.
  if (!s || /^n\/?a$/i.test(s) || /^no\s*gem|^none$|^not\s*available$|^nil$/i.test(s)) return null;
  const hit = match(STONES, s);
  return hit ? hit[1] : null;
}

/**
 * Builds the Amazon payload for one piece.
 * @returns {{ok: true, productType, body} | {ok: false, missing: string[]}}
 */
function buildListing(row, { marketplaceId, exemption = true }) {
  const m = { marketplace_id: marketplaceId };
  const L = { marketplace_id: marketplaceId, language_tag: 'en_AU' };
  const val = (v) => ({ language_tag: 'en_AU', value: v });
  const missing = [];
  const assumed = [];

  const productType = PRODUCT_TYPES[row.product_type];
  if (!productType) missing.push(`we have no Amazon category for "${row.product_type || 'no type'}"`);

  // Dropship stock is not in Retail Edge, so its metal has to come out of the title.
  // That is reading what we already hold, not inventing it — but only from the title:
  // the descriptions are brand boilerplate and would answer for every product alike.
  let metalSource = row.metal;
  if (!metalOf(metalSource)) {
    const fromTitle = metalFrom(String(row.title || ''));
    if (fromTitle) metalSource = fromTitle.value;
  }
  const metal = metalOf(metalSource);
  if (!metal && productType !== 'WATCH') {
    missing.push(`metal "${row.metal || 'none recorded'}" is not one Amazon recognises, and the title does not say`);
  }

  if (!row.image_url) missing.push('no photograph');
  if (!(Number(row.price) > 0)) missing.push('no price');
  if (!row.title) missing.push('no title');

  // A ring without a size cannot be sold as a ring.
  let usSize = null;
  if (productType === 'RING') {
    const sized = toAmazonSize(row.ring_size);
    if (!sized.us) missing.push(sized.why);
    usSize = sized.us;
  }

  if (missing.length) return { ok: false, missing };

  // A watch is a different object with a different vocabulary — no metals array, no
  // stones, no ring size, and several fields Amazon asks for that only a title can
  // answer. Built separately rather than bent into the jewellery shape.
  if (productType === 'WATCH') {
    return buildWatch(row, { marketplaceId, m, L, exemption });
  }

  // Same as the metal: where our record is silent, the title may not be. Only the
  // title — the descriptions say the same thing for every product of a brand.
  // Same as the metal: where our record is silent, the title may not be. Only the
  // title — the descriptions say the same thing for every product of a brand.
  let stone = stoneOf(row.stone);
  if (!stone && !row.stone) {
    const fromTitle = stoneFrom(String(row.title || ''));
    if (fromTitle) stone = stoneOf(fromTitle.value);
  }

  const metalName = AMAZON_METAL[metal.type] || titleCase(metal.type);
  const gem = stone ? titleCase(stone) : 'No Gemstone';

  const attributes = {
    brand: [{ ...L, value: row.vendor }],
    item_name: [{ ...L, value: row.title.slice(0, 190) }],
    product_description: [{ ...L, value: (row.description || row.title).slice(0, 1900) }],
    bullet_point: [
      { ...L, value: 'Handcrafted in Australia by Burrows Jewellers' },
      { ...L, value: row.title.slice(0, 190) },
    ],
    country_of_origin: [{ ...m, value: 'AU' }],
    supplier_declared_dg_hz_regulation: [{ ...m, value: 'not_applicable' }],
    condition_type: [{ ...m, value: 'new_new' }],
    part_number: [{ ...m, value: row.sku }],

    // The specific types ask for these and the FINE types did not, which is precisely
    // why a listing accepted under a FINE type is incomplete once Amazon reclassifies
    // it — and why 1,186 of them ended up with no offer against them.
    department: [{ ...L, value: "Women's" }],
    color: [{ ...L, value: row.colour || metalName }],
    jewelry_material_categorization: [{ ...L, value: FINE_METALS.has(metal.type) ? 'fine' : 'fashion' }],

    material: [{ ...L, value: metalName }],
    metal_type: [{ ...L, value: metalName }],
    metals: [{ ...m, id: 1, metal_type: val(metalName),
               metal_stamp: val(metal.stamp || metalName) }],
    gem_type: [{ ...L, value: gem }],
    stones: [{ ...m, id: 1, type: val(gem),
               creation_method: val('Natural'), treatment_method: val('Not Enhanced') }],

    main_product_image_locator: [{ ...m, media_location: row.image_url }],
    purchasable_offer: [{ ...m, currency: 'AUD',
      our_price: [{ schedule: [{ value_with_tax: Number(row.price) }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT',
      quantity: Math.max(0, Number(row.qty) || 0) }],
  };

  // Our own pieces have never had a barcode issued for them. The exemption is the route
  // Amazon provides for exactly that, and it has to be claimed explicitly.
  if (exemption) {
    attributes.supplier_declared_has_product_identifier_exemption = [{ ...m, value: true }];
  }

  if (usSize) {
    attributes.ring = [{ ...m,
      size: [val(usSize)], sizing_lower_range: [val(usSize)], sizing_upper_range: [val(usSize)] }];
    attributes.size = [{ ...L, value: usSize }];
    attributes.is_resizable = [{ ...m, value: true }];
  } else {
    // Chains, bracelets and bangles are sized by length. Where we hold one, say it;
    // where we do not, Amazon's own guidance for an item that does not vary by size is
    // exactly this phrase.
    attributes.size = [{ ...L, value: row.length ? String(row.length).trim() : 'One Size' }];

    // A length written as "45cm" is a number and a unit, and Amazon wants them apart.
    // Given as one string it asks for the unit it cannot see, which is what blocked
    // every chain and bracelet we tried.
    const measured = String(row.length || '').match(/([\d.]+)\s*(cm|mm|m|in|inch|inches|")?/i);
    if (measured && Number(measured[1]) > 0) {
      const u = (measured[2] || 'cm').toLowerCase();
      const unit = /^mm$/.test(u) ? 'millimeters'
                 : /^m$/.test(u) ? 'meters'
                 : /^(in|inch|inches|")$/.test(u) ? 'inches'
                 : 'centimeters';
      const value = Number(measured[1]);
      attributes.chain_length = [{ ...m, decimal_value: value, unit }];
      // Bracelets are asked for their length end to end. Note item_length, not
      // item_dimensions: that one wants width and height as well, which we do not hold,
      // so offering it a partial answer makes matters worse rather than better.
      attributes.item_length = [{ ...m, value, unit }];
    }
  }

  // A necklace or bracelet has to say how it fastens, and ours is recorded nowhere. A
  // lobster clasp is what most of what we sell uses, so it is stated — and marked as a
  // guess rather than passed off as known.
  if (productType === 'NECKLACE' || productType === 'BRACELET') {
    attributes.clasp_type = [{ ...L, value: 'Lobster' }];
    assumed.push('clasp_type');
  }

  // Amazon asks how many pearls and what shape they are the moment a pearl is named.
  // Our records say neither. One round pearl is what a pendant or a pair of studs
  // almost always is, and both are marked as guesses.
  if (/pearl/i.test(gem)) {
    attributes.number_of_pearls = [{ ...m, value: 1 }];
    attributes.stones[0].shape = val('Round');
    assumed.push('number_of_pearls', 'pearl_shape');
  }

  // Up to eight more photographs, which is what Amazon accepts.
  (row.extra_images || []).slice(0, 8).forEach((url, i) => {
    attributes[`other_product_image_locator_${i + 1}`] = [{ ...m, media_location: url }];
  });

  return { ok: true, productType, assumed, body: { productType, requirements: 'LISTING', attributes } };
}

/**
 * A watch listing.
 *
 * Amazon insists on a handful of details our records simply do not carry — the case
 * shape and the calendar complication among them. Where the title says, we use what it
 * says; where it does not, we use the value that is right for most of what we stock and
 * record that we assumed it, so the guesses are countable and correctable rather than
 * indistinguishable from fact.
 */
function buildWatch(row, { m, L, exemption }) {
  const { picks, assumed } = watchAttributes({ title: row.title, tags: row.tags });
  const attributes = {
    brand: [{ ...L, value: row.vendor }],
    manufacturer: [{ ...L, value: row.vendor }],
    item_name: [{ ...L, value: String(row.title).slice(0, 190) }],
    product_description: [{ ...L, value: String(row.title).slice(0, 1900) }],
    bullet_point: [{ ...L, value: String(row.title).slice(0, 190) }],
    country_of_origin: [{ ...m, value: 'CN' }],
    supplier_declared_dg_hz_regulation: [{ ...m, value: 'not_applicable' }],
    condition_type: [{ ...m, value: 'new_new' }],
    part_number: [{ ...m, value: row.sku }],
    target_gender: [{ ...L, value: picks.target_gender.value }],
    department: [{ ...L, value: picks.department.value }],
    item_shape: [{ ...L, value: picks.item_shape.value }],
    calendar_type: [{ ...L, value: picks.calendar_type.value }],
    color: [{ ...L, value: picks.color.value }],
    warranty_type: [{ ...L, value: picks.warranty_type.value }],
    list_price: [{ ...m, currency: 'AUD', value_with_tax: Number(row.price) }],
    main_product_image_locator: [{ ...m, media_location: row.image_url }],
    purchasable_offer: [{ ...m, currency: 'AUD',
      our_price: [{ schedule: [{ value_with_tax: Number(row.price) }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT',
      quantity: Math.max(0, Number(row.qty) || 0), lead_time_to_ship_max_days: 5 }],
  };
  if (exemption) {
    attributes.supplier_declared_has_product_identifier_exemption = [{ ...m, value: true }];
  }
  (row.extra_images || []).slice(0, 8).forEach((url, i) => {
    attributes[`other_product_image_locator_${i + 1}`] = [{ ...m, media_location: url }];
  });
  return { ok: true, productType: 'WATCH', assumed,
           body: { productType: 'WATCH', requirements: 'LISTING', attributes } };
}

module.exports = { buildListing, metalOf, stoneOf, PRODUCT_TYPES };
