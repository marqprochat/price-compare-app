import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonResponse } from './jsonResponse.js';

test('parses a raw JSON object', () => {
  const result = parseJsonResponse('{"level":"alta","summary":"ok"}', {});
  assert.deepEqual(result, { level: 'alta', summary: 'ok' });
});

test('parses JSON surrounded by extra text', () => {
  const raw = 'Aqui está:\n{"query":"iphone 13 128gb"}\nEspero que ajude.';
  const result = parseJsonResponse(raw, {});
  assert.deepEqual(result, { query: 'iphone 13 128gb' });
});

test('returns fallback when there is no JSON object', () => {
  const result = parseJsonResponse('desculpe, não consegui', { level: 'desconhecida' });
  assert.deepEqual(result, { level: 'desconhecida' });
});

test('returns fallback when the JSON is malformed', () => {
  const result = parseJsonResponse('{"level": "alta",}', { level: 'desconhecida' });
  assert.deepEqual(result, { level: 'desconhecida' });
});

test('returns fallback when raw is not a string', () => {
  assert.deepEqual(parseJsonResponse(undefined, { ok: true }), { ok: true });
  assert.deepEqual(parseJsonResponse(null, { ok: true }), { ok: true });
});
