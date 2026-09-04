import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQuery, extractWithAI, reviewRound } from './aiAnalyst.js';

test('buildSearchQuery returns the cleaned query from the LLM', async () => {
  const chatComplete = async () => '{"query":"lenovo ideapad 3 i5 8gb 256gb"}';
  const query = await buildSearchQuery({ name: 'Notebook Lenovo | Loja X | Frete Grátis' }, { chatComplete });
  assert.equal(query, 'lenovo ideapad 3 i5 8gb 256gb');
});

test('buildSearchQuery falls back to the raw name when the LLM call throws', async () => {
  const chatComplete = async () => { throw new Error('network down'); };
  const query = await buildSearchQuery({ name: 'Notebook Lenovo' }, { chatComplete });
  assert.equal(query, 'Notebook Lenovo');
});

test('buildSearchQuery falls back to the raw name when the LLM returns unusable JSON', async () => {
  const chatComplete = async () => '{"query": ""}';
  const query = await buildSearchQuery({ name: 'Notebook Lenovo' }, { chatComplete });
  assert.equal(query, 'Notebook Lenovo');
});

test('extractWithAI returns name/price/currency parsed from the LLM', async () => {
  const chatComplete = async () => '{"name":"Notebook Lenovo IdeaPad 3","price":2499.9,"currency":"BRL"}';
  const result = await extractWithAI('texto da página...', 'https://loja.com/p', { chatComplete });
  assert.deepEqual(result, { name: 'Notebook Lenovo IdeaPad 3', price: 2499.9, currency: 'BRL' });
});

test('extractWithAI returns nulls when the LLM says it could not identify the product', async () => {
  const chatComplete = async () => '{"name":null,"price":null,"currency":"BRL"}';
  const result = await extractWithAI('texto sem produto', 'https://loja.com/p', { chatComplete });
  assert.deepEqual(result, { name: null, price: null, currency: 'BRL' });
});

test('extractWithAI returns nulls when the LLM call throws', async () => {
  const chatComplete = async () => { throw new Error('timeout'); };
  const result = await extractWithAI('texto', 'https://loja.com/p', { chatComplete });
  assert.deepEqual(result, { name: null, price: null, currency: 'BRL' });
});

test('reviewRound parses verdicts, enough flag and betterQuery', async () => {
  const chatComplete = async () => JSON.stringify({
    enough: false,
    betterQuery: 'lenovo ideapad 3 i5 8gb 256gb',
    offers: [
      { url: 'https://a.com/p', verdict: 'ok', reason: null },
      { url: 'https://b.com/p', verdict: 'duvidosa', reason: 'preço pode ser parcela' },
      { url: 'https://c.com/p', verdict: 'errada', reason: 'produto diferente' },
    ],
  });
  const result = await reviewRound(
    { name: 'Notebook Lenovo IdeaPad 3', price: 2499.9 },
    [
      { source: 'https://a.com/p', store: 'a.com', name: 'Notebook Lenovo IdeaPad 3', price: 2400, suspicious: false },
      { source: 'https://b.com/p', store: 'b.com', name: 'Notebook Lenovo IdeaPad 3', price: 208.32, suspicious: true },
      { source: 'https://c.com/p', store: 'c.com', name: 'Capa para Notebook', price: 89, suspicious: false },
    ],
    { chatComplete }
  );
  assert.equal(result.enough, false);
  assert.equal(result.betterQuery, 'lenovo ideapad 3 i5 8gb 256gb');
  assert.deepEqual(result.offers, [
    { url: 'https://a.com/p', verdict: 'ok', reason: null },
    { url: 'https://b.com/p', verdict: 'duvidosa', reason: 'preço pode ser parcela' },
    { url: 'https://c.com/p', verdict: 'errada', reason: 'produto diferente' },
  ]);
});

test('reviewRound falls back to treating every offer as ok when the LLM call throws', async () => {
  const chatComplete = async () => { throw new Error('network down'); };
  const offers = [
    { source: 'https://a.com/p', store: 'a.com', name: 'X', price: 100, suspicious: false },
    { source: 'https://b.com/p', store: 'b.com', name: 'Y', price: 200, suspicious: false },
  ];
  const result = await reviewRound({ name: 'X', price: 100 }, offers, { chatComplete });
  assert.equal(result.enough, true);
  assert.equal(result.betterQuery, null);
  assert.deepEqual(result.offers, [
    { url: 'https://a.com/p', verdict: 'ok', reason: null },
    { url: 'https://b.com/p', verdict: 'ok', reason: null },
  ]);
});

test('reviewRound falls back to treating every offer as ok when the LLM returns malformed JSON', async () => {
  const chatComplete = async () => 'desculpe, não consegui responder em JSON';
  const offers = [{ source: 'https://a.com/p', store: 'a.com', name: 'X', price: 100, suspicious: false }];
  const result = await reviewRound({ name: 'X', price: 100 }, offers, { chatComplete });
  assert.deepEqual(result.offers, [{ url: 'https://a.com/p', verdict: 'ok', reason: null }]);
});

test('reviewRound with an empty offer list reports not enough and no offers', async () => {
  const chatComplete = async () => { throw new Error('should not be called'); };
  const result = await reviewRound({ name: 'X', price: 100 }, [], { chatComplete });
  assert.deepEqual(result, { enough: false, betterQuery: null, offers: [] });
});
