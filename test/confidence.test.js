'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { scoreMatch, codeAppears } = require('../src/match/confidence');

const score = (sku, ourTitle, amazonTitle, vendor = 'Thomas Sabo') =>
  scoreMatch({
    sku, ourVendor: vendor, ourTitle, ourPrice: 100,
    amazonBrand: vendor, amazonTitle, amazonPrice: 0,
  }).confidence;

/**
 * Amazon writes its own titles and writes them badly, so wording alone cannot decide
 * whether two listings are the same piece. These are all real pairs from the live
 * catalogue on 14 Sep 2026.
 */
test('a manufacturer code in Amazon’s title settles it, however different the prose', () => {
  assert.equal(score('TR2473-56', 'THOMAS SABO Ring with curved shape silver',
    'Thomas Sabo 2 Ring 925 Sterling Silver TR2473-001-21'), 'high');
  // They drop our leading brand letter.
  assert.equal(score('TX0091S', 'THOMAS SABO Wide Anchor Chain',
    'Thomas Sabo X0091-001-12-S Women’s Necklace without Pendant'), 'high');
  // Their tail is colour and size, which the barcode already settled.
  assert.equal(score('TR2470Y58', 'THOMAS SABO Ring in organic drop-shape gold',
    'Thomas Sabo Ladies Gold Teardrop Ring - TR2470-413-39-58'), 'high');
});

test('same brand and nothing identifying in common is not a match', () => {
  // These shipped as matches under the old scoring. A rabbit is not an angel wing.
  assert.notEqual(score('CC819', 'THOMAS SABO Charm Pendant "Rabbit"',
    'Thomas Sabo Women Charm Pendant Angel Wing'), 'high');
  assert.notEqual(score('026-01241', 'Thomas Sabo Passport Charm',
    'Thomas Sabo Women Charm Pendant Bow Black'), 'high');
  assert.notEqual(score('025-00620', 'Thomas Sabo Blackened Silver Fine Venezia Chain',
    'Thomas Sabo Ladies Little Secret Tree of Love 925 Sterling Silver Chain'), 'high');
});

test('the letter necklaces that caused refunds stay blocked', () => {
  assert.notEqual(score('022-04779', 'PDPAOLA Letters 2021 T Necklace',
    'PdPaola 32017010 Women’s Necklace 925 Silver Tigers Eye', 'PDPAOLA'), 'high');
  assert.equal(score('X', 'PdPaola Mini Letter W Necklace',
    'PdPaola Mini Letter N Necklace', 'PdPaola'), 'conflict');
});

test('generic words alone never carry a match', () => {
  // Brand twice, a metal and a form: four shared words that mean nothing.
  assert.notEqual(score('999-99999', 'Thomas Sabo Silver Chain Necklace',
    'Thomas Sabo Sterling Silver Chain Necklace Heart Motif'), 'high');
});

test('codeAppears does not fire on coincidental short numbers', () => {
  assert.equal(codeAppears('AB12', 'Something 12 something'), false);
  assert.equal(codeAppears('123', 'Ring 123 Silver'), false);
});

const { toAmazonSize } = require('../src/stage2/ringsize');

test('European ring sizes convert; US ones are left alone', () => {
  // Circumference in millimetres — a range US sizes never occupy.
  assert.equal(toAmazonSize('54').us, '6.75');
  assert.equal(toAmazonSize('62').us, '10');
  // Still a US size, not a circumference.
  assert.equal(toAmazonSize('7.5').us, '7.5');
  assert.equal(toAmazonSize('N').us, '6.75');
  // Ambiguous or not a size at all: refused rather than guessed.
  assert.equal(toAmazonSize('N½, O').us, null);
  assert.equal(toAmazonSize('Large').us, null);
  assert.equal(toAmazonSize('').us, null);
});
