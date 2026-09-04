import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPriceCandidates, pickBestCandidate, isOutlier } from './priceSanity.js';

test('extractPriceCandidates finds a single plain price', () => {
  const text = 'Frete grátis. Por R$ 2.499,90 à vista no PIX.';
  assert.deepEqual(extractPriceCandidates(text), ['R$ 2.499,90']);
});

test('extractPriceCandidates ignores installment prices near "x"', () => {
  const text = 'Em até 12x de R$ 208,32 sem juros ou R$ 2.499,90 à vista.';
  assert.deepEqual(extractPriceCandidates(text), ['R$ 2.499,90']);
});

test('extractPriceCandidates ignores monthly-fee prices', () => {
  const text = 'Assinatura por R$ 39,90/mês ou compre por R$ 2.499,90.';
  assert.deepEqual(extractPriceCandidates(text), ['R$ 2.499,90']);
});

test('extractPriceCandidates returns empty array when nothing matches', () => {
  assert.deepEqual(extractPriceCandidates('sem preço nessa página'), []);
});

test('pickBestCandidate returns suspicious when there are no candidates', () => {
  assert.deepEqual(pickBestCandidate([]), { raw: null, suspicious: true });
});

test('pickBestCandidate returns suspicious when there is more than one candidate', () => {
  const result = pickBestCandidate(['R$ 2.499,90', 'R$ 189,00']);
  assert.deepEqual(result, { raw: 'R$ 2.499,90', suspicious: true });
});

test('pickBestCandidate returns not suspicious for exactly one candidate', () => {
  const result = pickBestCandidate(['R$ 2.499,90']);
  assert.deepEqual(result, { raw: 'R$ 2.499,90', suspicious: false });
});

test('isOutlier flags a price far below the reference', () => {
  assert.equal(isOutlier(100, 2000), true); // 5% do original
});

test('isOutlier flags a price far above the reference', () => {
  assert.equal(isOutlier(9000, 2000), true); // 450% do original
});

test('isOutlier accepts a price in a reasonable range', () => {
  assert.equal(isOutlier(1900, 2000), false);
  assert.equal(isOutlier(2600, 2000), false);
});

test('isOutlier returns false when price or reference is missing', () => {
  assert.equal(isOutlier(null, 2000), false);
  assert.equal(isOutlier(1900, null), false);
  assert.equal(isOutlier(1900, 0), false);
});
