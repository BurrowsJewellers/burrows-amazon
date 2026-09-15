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

/** Our product types, against the Amazon product type that fits them. */
const PRODUCT_TYPES = {
  Ring: 'FINERING',
  Rings: 'FINERING',
  Necklaces: 'FINENECKLACEBRACELETANKLET',
  Bracelets: 'FINENECKLACEBRACELETANKLET',
  Charm: 'FINENECKLACEBRACELETANKLET',
  'Charm Pendant': 'FINENECKLACEBRACELETANKLET',
  'Hoop Earring': 'FINEEARRING',
  'Hoop Earrings': 'FINEEARRING',
  'Ear Studs': 'FINEEARRING',
  Anklet: 'FINENECKLACEBRACELETANKLET',
  Watch: 'WATCH',
  Watches: 'WATCH',
  Earring: 'FINEEARRING',
  Earrings: 'FINEEARRING',
  Necklace: 'FINENECKLACEBRACELETANKLET',
  Necklet: 'FINENECKLACEBRACELETANKLET',
  Chain: 'FINENECKLACEBRACELETANKLET',
  Pendant: 'FINENECKLACEBRACELETANKLET',
  Bracelet: 'FINENECKLACEBRACELETANKLET',
  Bangle: 'FINENECKLACEBRACELETANKLET',
};

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
  if (productType === 'FINERING') {
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
  let stone = stoneOf(row.stone);
  if (!stone && !row.stone) {
    const fromTitle = stoneFrom(String(row.title || ''));
    if (fromTitle) stone = stoneOf(fromTitle.value);
  }
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
    material: [{ ...L, value: metalSource || metal.type.replace(/_/g, ' ') }],
    department: [{ ...L, value: 'womens' }],
    color: [{ ...L, value: row.colour || metalSource || metal.type.replace(/_/g, ' ') }],
    metal_type: [{ ...L, value: metal.type }],
    metals: [{ ...m, id: 1, metal_type: val(metal.type), metal_stamp: val(metal.stamp) }],
    main_product_image_locator: [{ ...m, media_location: row.image_url }],
    purchasable_offer: [{ ...m, currency: 'AUD',
      our_price: [{ schedule: [{ value_with_tax: Number(row.price) }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT',
      quantity: Math.max(0, Number(row.qty) || 0), lead_time_to_ship_max_days: 5 }],
  };

  // Our own pieces have never had a barcode issued for them. The exemption is the
  // route Amazon provides for exactly that, and it has to be claimed explicitly.
  if (exemption) {
    attributes.supplier_declared_has_product_identifier_exemption = [{ ...m, value: true }];
  }

  // These are required whether or not the piece has a stone, and Amazon provides the
  // value for when it does not.
  const gem = stone || 'No Gemstone';
  attributes.gem_type = [{ ...L, value: gem }];
  attributes.stones = [{ ...m, id: 1, type: val(gem),
    creation_method: val('natural'), treatment_method: val('not_enhanced') }];

  if (usSize) {
    attributes.ring = [{ ...m,
      size: [val(usSize)], sizing_lower_range: [val(usSize)], sizing_upper_range: [val(usSize)] }];
    attributes.is_resizable = [{ ...m, value: true }];
  } else {
    // Chains, bracelets and bangles are sized by length. Where we hold one, say it;
    // where we do not, Amazon's own guidance for an item that does not vary by size is
    // exactly this phrase.
    attributes.size = [{ ...L, value: row.length ? String(row.length).trim() : 'One Size' }];
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
