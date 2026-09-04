import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOffers, applyVerdicts, shouldRetry } from './offerRounds.js';

test('mergeOffers concatenates offers with distinct urls', () => {
  const a = [{ source: 'https://a.com/p', price: 100 }];
  const b = [{ source: 'https://b.com/p', price: 200 }];
  const result = mergeOffers(a, b);
  assert.deepEqual(result.map((o) => o.source), ['https://a.com/p', 'https://b.com/p']);
});

test('mergeOffers lets the newer offer win on a duplicate url', () => {
  const a = [{ source: 'https://a.com/p', price: 100 }];
  const b = [{ source: 'https://a.com/p', price: 90 }];
  const result = mergeOffers(a, b);
  assert.deepEqual(result, [{ source: 'https://a.com/p', price: 90 }]);
});

test('applyVerdicts attaches verdict and reason by matching url', () => {
  const offers = [
    { source: 'https://a.com/p', price: 100 },
    { source: 'https://b.com/p', price: 200 },
  ];
  const verdicts = [
    { url: 'https://a.com/p', verdict: 'ok', reason: null },
    { url: 'https://b.com/p', verdict: 'duvidosa', reason: 'preço pode ser parcela' },
  ];
  const result = applyVerdicts(offers, verdicts);
  assert.deepEqual(result, [
    { source: 'https://a.com/p', price: 100, verdict: 'ok', verdictReason: null },
    { source: 'https://b.com/p', price: 200, verdict: 'duvidosa', verdictReason: 'preço pode ser parcela' },
  ]);
});

test('applyVerdicts drops offers verdicted as errada', () => {
  const offers = [
    { source: 'https://a.com/p', price: 100 },
    { source: 'https://b.com/p', price: 5 },
  ];
  const verdicts = [
    { url: 'https://a.com/p', verdict: 'ok', reason: null },
    { url: 'https://b.com/p', verdict: 'errada', reason: 'produto diferente' },
  ];
  const result = applyVerdicts(offers, verdicts);
  assert.deepEqual(result.map((o) => o.source), ['https://a.com/p']);
});

test('applyVerdicts defaults unmatched offers to ok', () => {
  const offers = [{ source: 'https://a.com/p', price: 100 }];
  const result = applyVerdicts(offers, []);
  assert.deepEqual(result, [{ source: 'https://a.com/p', price: 100, verdict: 'ok', verdictReason: null }]);
});

test('shouldRetry is true when not enough and a better query exists within the round budget', () => {
  const review = { enough: false, betterQuery: 'iphone 13 128gb' };
  assert.equal(shouldRetry(review, 1, 2), true);
});

test('shouldRetry is false once the round budget is exhausted', () => {
  const review = { enough: false, betterQuery: 'iphone 13 128gb' };
  assert.equal(shouldRetry(review, 2, 2), false);
});

test('shouldRetry is false when the round was enough', () => {
  const review = { enough: true, betterQuery: 'iphone 13 128gb' };
  assert.equal(shouldRetry(review, 1, 2), false);
});

test('shouldRetry is false when there is no better query to try', () => {
  const review = { enough: false, betterQuery: null };
  assert.equal(shouldRetry(review, 1, 2), false);
});
