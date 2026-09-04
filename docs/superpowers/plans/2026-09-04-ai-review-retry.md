# Revisão e Retry de Busca via IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI actively participate in the price-compare pipeline: it builds the search query, acts as a fallback extractor when mechanical parsing fails/looks suspicious, and reviews each batch of offers in one call — discarding wrong matches, flagging doubtful ones, and (up to one retry) rewriting the query when the round wasn't good enough.

**Architecture:** A new pure-logic layer (`src/jsonResponse.js`, `src/priceSanity.js`, `src/offerRounds.js`) handles everything that doesn't need the network and is unit-tested with `node --test`. A new `src/aiAnalyst.js` wraps all LLM calls (query building, extraction fallback, batch review) behind dependency-injected `chatComplete`, so it's testable with a stub — no real network calls in tests. `server.js` becomes the orchestrator: it calls the pure layer and `aiAnalyst.js` to run up to 2 search rounds. `extractProduct.js` stays mechanical/pure but gains a `suspicious` flag and an `extractVisibleText` helper. `reliability.js` is untouched except reusing the shared JSON parser.

**Tech Stack:** Node.js (ESM), Express, axios, cheerio, `node --test` (built-in test runner, no new dependency).

## Global Constraints

- Every LLM call (`buildSearchQuery`, `extractWithAI`, `reviewRound`) must be wrapped so a failure (network error, malformed JSON) falls back to the pre-AI mechanical behavior — never throws, never breaks the comparison.
- Max 2 search rounds total (initial + at most 1 retry), per the approved design.
- `reviewRound` is called once per round, in batch (all offers of that round in one prompt) — never one LLM call per offer.
- Offers with verdict `errada` are dropped from the response. Offers with verdict `duvidosa` stay, carry a `verdictReason`, and are never eligible for `cheapest`/`cheapestReliable`.
- All new pure-logic modules (`jsonResponse.js`, `priceSanity.js`, `offerRounds.js`) must have zero network/LLM dependency and 100% of their behavior covered by `node --test`.
- Reuse the JSON-parsing-from-LLM-text pattern (currently duplicated inline in `reliability.js:46-47`) via a single shared `parseJsonResponse` helper.

---

### Task 1: Shared JSON response parser

**Files:**
- Create: `src/jsonResponse.js`
- Test: `src/jsonResponse.test.js`
- Modify: `src/reliability.js:44-51`

**Interfaces:**
- Produces: `parseJsonResponse(raw: string, fallback: object) => object` — extracts the first `{...}` block from `raw` and `JSON.parse`s it; returns `fallback` if `raw` isn't a string, no `{...}` is found, or parsing fails. Used by Task 5 (`aiAnalyst.js`) and this task's `reliability.js` refactor.

- [ ] **Step 1: Write the failing test**

Create `src/jsonResponse.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/jsonResponse.test.js`
Expected: FAIL — `Cannot find module './jsonResponse.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/jsonResponse.js`:

```js
/**
 * Extrai e faz parse do primeiro bloco {...} encontrado numa resposta de LLM.
 * LLMs às vezes cercam o JSON pedido com texto extra ("Aqui está: {...}") ou
 * respondem algo fora do formato — nesses casos, devolve `fallback`.
 */
export function parseJsonResponse(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/jsonResponse.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Refactor reliability.js to use the shared helper**

In `src/reliability.js`, replace the import and the inline parsing block:

```js
import { webSearch, chatComplete } from './nineRouter.js';
import { parseJsonResponse } from './jsonResponse.js';
```

Replace lines 44-51 (`let level = ...` through the closing `}` of the try/catch):

```js
  let level = 'desconhecida';
  let summary = 'Não foi possível avaliar.';
  try {
    const raw = await chatComplete(messages);
    const parsed = parseJsonResponse(raw, {});
    level = parsed.level || level;
    summary = parsed.summary || summary;
  } catch {
    // mantém os valores padrão se o LLM falhar ou responder fora do formato
  }
```

- [ ] **Step 6: Commit**

```bash
git add src/jsonResponse.js src/jsonResponse.test.js src/reliability.js
git commit -m "feat: add shared LLM JSON response parser, reuse in reliability.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Price sanity module

**Files:**
- Create: `src/priceSanity.js`
- Test: `src/priceSanity.test.js`

**Interfaces:**
- Produces:
  - `extractPriceCandidates(text: string) => string[]` — all `R$ ...` matches in `text`, excluding ones with an installment/monthly-fee marker within ~40 chars.
  - `pickBestCandidate(candidates: string[]) => { raw: string|null, suspicious: boolean }` — `raw: null, suspicious: true` if empty; `suspicious: true` if more than one candidate (ambiguous); otherwise the single candidate with `suspicious: false`.
  - `isOutlier(price: number|null, referencePrice: number|null) => boolean` — `true` if `price` is below 15% or above 400% of `referencePrice`; `false` if either is null/0.
- Consumes: nothing (pure text/number logic, no imports needed beyond none).

- [ ] **Step 1: Write the failing test**

Create `src/priceSanity.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/priceSanity.test.js`
Expected: FAIL — `Cannot find module './priceSanity.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/priceSanity.js`:

```js
const INSTALLMENT_MARKERS = /(\d+\s*x\b|sem juros|\/\s*m[eê]s|por\s+m[eê]s)/i;
const PRICE_RE = /R\$\s?[\d.,]+/g;
const CONTEXT_RADIUS = 40;

/**
 * Encontra todos os preços "R$ ..." no texto, descartando os que parecem
 * parcela ou mensalidade (têm um marcador de parcelamento perto).
 */
export function extractPriceCandidates(text) {
  const candidates = [];
  const re = new RegExp(PRICE_RE);
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = Math.max(0, match.index - CONTEXT_RADIUS);
    const end = Math.min(text.length, match.index + match[0].length + CONTEXT_RADIUS);
    const context = text.slice(start, end);
    if (INSTALLMENT_MARKERS.test(context)) continue;
    candidates.push(match[0]);
  }
  return candidates;
}

/**
 * Escolhe o melhor candidato de preço. Zero ou mais de um candidato é
 * ambíguo — marca `suspicious: true` pra pedir uma segunda opinião.
 */
export function pickBestCandidate(candidates) {
  if (candidates.length === 0) return { raw: null, suspicious: true };
  if (candidates.length > 1) return { raw: candidates[0], suspicious: true };
  return { raw: candidates[0], suspicious: false };
}

/**
 * Um preço muito abaixo (<15%) ou muito acima (>400%) do preço de
 * referência provavelmente é erro de extração (frete, acessório, etc).
 */
export function isOutlier(price, referencePrice) {
  if (price == null || referencePrice == null || referencePrice === 0) return false;
  const ratio = price / referencePrice;
  return ratio < 0.15 || ratio > 4;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/priceSanity.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/priceSanity.js src/priceSanity.test.js
git commit -m "feat: add deterministic price sanity checks (installments, outliers)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire price sanity into extractProduct.js + add extractVisibleText

**Files:**
- Modify: `src/extractProduct.js:1,109-129`
- Test: `src/extractProduct.test.js` (new)

**Interfaces:**
- Consumes: `extractPriceCandidates`, `pickBestCandidate` from `src/priceSanity.js` (Task 2).
- Produces:
  - `extractProduct(html, pageUrl)` result now always includes `suspicious: boolean` (in addition to existing `name`, `price`, `currency`, `source`, `method`, `blocked`). `suspicious` is `true` when the regex-fallback price had zero or multiple candidates; `false` otherwise (including when JSON-LD/meta found the price directly).
  - `extractVisibleText(html: string) => string` — new export: strips `<script>`/`<style>`/`<noscript>`, returns the page's visible text collapsed to single spaces, trimmed. Used by Task 6 (`server.js`) to feed `extractWithAI`.

- [ ] **Step 1: Write the failing test**

Create `src/extractProduct.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct, extractVisibleText } from './extractProduct.js';

test('extracts name and price from JSON-LD without marking suspicious', () => {
  const html = `<html><head>
    <script type="application/ld+json">
      {"@type":"Product","name":"Notebook XYZ","offers":{"@type":"Offer","price":"2499.90","priceCurrency":"BRL"}}
    </script>
  </head><body>Em até 12x de R$ 208,32 sem juros</body></html>`;
  const result = extractProduct(html, 'https://loja.com/p');
  assert.equal(result.name, 'Notebook XYZ');
  assert.equal(result.price, 2499.9);
  assert.equal(result.suspicious, false);
});

test('regex fallback with a single unambiguous price is not suspicious', () => {
  const html = '<html><head><title>Notebook XYZ</title></head><body>Por R$ 2.499,90 à vista</body></html>';
  const result = extractProduct(html, 'https://loja.com/p');
  assert.equal(result.price, 2499.9);
  assert.equal(result.method, 'regex-fallback');
  assert.equal(result.suspicious, false);
});

test('regex fallback ignores installment price and stays unambiguous', () => {
  const html = '<html><head><title>Notebook XYZ</title></head><body>12x de R$ 208,32 sem juros. Por R$ 2.499,90 à vista.</body></html>';
  const result = extractProduct(html, 'https://loja.com/p');
  assert.equal(result.price, 2499.9);
  assert.equal(result.suspicious, false);
});

test('regex fallback with multiple prices is marked suspicious', () => {
  const html = '<html><head><title>Notebook XYZ</title></head><body>R$ 2.499,90 no produto principal. Acessório R$ 89,90.</body></html>';
  const result = extractProduct(html, 'https://loja.com/p');
  assert.equal(result.suspicious, true);
});

test('regex fallback with no price at all is marked suspicious with null price', () => {
  const html = '<html><head><title>Notebook XYZ</title></head><body>sem preço aqui</body></html>';
  const result = extractProduct(html, 'https://loja.com/p');
  assert.equal(result.price, null);
  assert.equal(result.suspicious, true);
});

test('blocked pages are not marked suspicious (blocked already signals the problem)', () => {
  const html = '<html><head><title>Mercado Livre</title></head><body>suspicious_traffic account-verification</body></html>';
  const result = extractProduct(html, 'https://mercadolivre.com.br/p');
  assert.equal(result.blocked, true);
  assert.equal(result.suspicious, false);
});

test('extractVisibleText strips scripts/styles and collapses whitespace', () => {
  const html = `<html><head><style>.a{color:red}</style></head>
    <body>
      <script>window.x = 1;</script>
      <h1>Notebook   XYZ</h1>
      <p>Preço:   R$ 2.499,90</p>
    </body></html>`;
  const text = extractVisibleText(html);
  assert.ok(!text.includes('window.x'));
  assert.ok(!text.includes('color:red'));
  assert.equal(text, 'Notebook XYZ Preço: R$ 2.499,90');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/extractProduct.test.js`
Expected: FAIL — `suspicious` is `undefined` in several tests, and `extractVisibleText` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/extractProduct.js`, add the import at the top (line 1 becomes two lines):

```js
import * as cheerio from 'cheerio';
import { extractPriceCandidates, pickBestCandidate } from './priceSanity.js';
```

Add `suspicious: false` to the initial `result` object (the line that currently reads `const result = { name: null, price: null, currency: 'BRL', source: pageUrl, method: null, blocked: false };`):

```js
  const result = { name: null, price: null, currency: 'BRL', source: pageUrl, method: null, blocked: false, suspicious: false };
```

Replace the final regex-fallback block (current lines 119-126):

```js
  if (!result.price) {
    const bodyText = $('body').text();
    const match = bodyText.match(/R\$\s?[\d.,]+/);
    if (match) {
      result.price = parsePriceString(match[0]);
      result.method = result.method || 'regex-fallback';
    }
  }
```

with:

```js
  if (!result.price) {
    const bodyText = $('body').text();
    const candidates = extractPriceCandidates(bodyText);
    const { raw, suspicious } = pickBestCandidate(candidates);
    if (raw) {
      result.price = parsePriceString(raw);
      result.method = result.method || 'regex-fallback';
    }
    if (suspicious) result.suspicious = true;
  }
```

Add the new export at the end of the file (after the closing `}` of `extractProduct`):

```js

/**
 * Texto visível de uma página (sem scripts/estilos), pra alimentar um LLM
 * como segunda opinião de extração sem gastar tokens com HTML/JS irrelevante.
 */
export function extractVisibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/extractProduct.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full test suite so far**

Run: `node --test src/`
Expected: PASS (all tests from Tasks 1-3)

- [ ] **Step 6: Commit**

```bash
git add src/extractProduct.js src/extractProduct.test.js
git commit -m "feat: mark ambiguous/missing regex-fallback prices as suspicious, add extractVisibleText

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Offer rounds module (merge, verdict filtering, retry decision)

**Files:**
- Create: `src/offerRounds.js`
- Test: `src/offerRounds.test.js`

**Interfaces:**
- Produces:
  - `mergeOffers(existingOffers: Offer[], newOffers: Offer[]) => Offer[]` — dedupes by `.source` URL; when both lists have the same URL, the entry from `newOffers` wins. `Offer` here is any object with a `.source` string field (matches what `extractProduct`/`extractWithAI` produce).
  - `applyVerdicts(offers: Offer[], verdicts: {url: string, verdict: 'ok'|'duvidosa'|'errada', reason: string|null}[]) => Offer[]` — attaches `verdict` and `verdictReason` to each offer (matched by `offer.source === verdict.url`); offers with no matching verdict default to `verdict: 'ok', verdictReason: null`; offers whose verdict is `'errada'` are removed from the returned array.
  - `shouldRetry(reviewResult: {enough: boolean, betterQuery: string|null}, roundsCompleted: number, maxRounds?: number) => boolean` — `true` only if `roundsCompleted < maxRounds` (default `2`), `reviewResult.enough === false`, and `reviewResult.betterQuery` is a non-empty string.
- Consumes: nothing (pure, no imports).

- [ ] **Step 1: Write the failing test**

Create `src/offerRounds.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/offerRounds.test.js`
Expected: FAIL — `Cannot find module './offerRounds.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/offerRounds.js`:

```js
/**
 * Junta ofertas de rodadas diferentes, deduplicando por URL. Em caso de
 * conflito, a oferta mais recente (newOffers) vence.
 */
export function mergeOffers(existingOffers, newOffers) {
  const map = new Map();
  for (const offer of existingOffers) map.set(offer.source, offer);
  for (const offer of newOffers) map.set(offer.source, offer);
  return [...map.values()];
}

/**
 * Aplica o veredito da IA a cada oferta (por URL) e descarta as marcadas
 * como "errada". Ofertas sem veredito correspondente (ex: reviewRound
 * falhou e caiu no fallback) são tratadas como "ok".
 */
export function applyVerdicts(offers, verdicts) {
  const verdictByUrl = new Map((verdicts || []).map((v) => [v.url, v]));
  return offers
    .map((offer) => {
      const v = verdictByUrl.get(offer.source);
      return {
        ...offer,
        verdict: v?.verdict || 'ok',
        verdictReason: v?.reason ?? null,
      };
    })
    .filter((offer) => offer.verdict !== 'errada');
}

/**
 * Decide se vale a pena rodar mais uma busca: só se ainda houver
 * orçamento de rodadas, a IA disse que não foi bom o bastante, e sugeriu
 * uma query melhor pra tentar.
 */
export function shouldRetry(reviewResult, roundsCompleted, maxRounds = 2) {
  if (!reviewResult) return false;
  if (roundsCompleted >= maxRounds) return false;
  if (reviewResult.enough) return false;
  if (!reviewResult.betterQuery) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/offerRounds.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/offerRounds.js src/offerRounds.test.js
git commit -m "feat: add offer merge/verdict-filter/retry-decision logic for search rounds

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: aiAnalyst.js — buildSearchQuery, extractWithAI, reviewRound

**Files:**
- Create: `src/aiAnalyst.js`
- Test: `src/aiAnalyst.test.js`

**Interfaces:**
- Consumes: `chatComplete` from `src/nineRouter.js` (default; injectable for tests), `parseJsonResponse` from `src/jsonResponse.js` (Task 1).
- Produces:
  - `buildSearchQuery(product: {name: string}, deps?: {chatComplete?: Function}) => Promise<string>` — cleaned search query, or `product.name` if the LLM call fails/returns nothing usable.
  - `extractWithAI(pageText: string, url: string, deps?: {chatComplete?: Function}) => Promise<{name: string|null, price: number|null, currency: string}>` — `{name: null, price: null, currency: 'BRL'}` on any failure.
  - `reviewRound(original: {name: string, price: number|null}, offers: {source: string, store: string, name: string|null, price: number|null, suspicious: boolean}[], deps?: {chatComplete?: Function}) => Promise<{enough: boolean, betterQuery: string|null, offers: {url: string, verdict: 'ok'|'duvidosa'|'errada', reason: string|null}[]}>` — on failure, or when `offers` is non-empty, falls back to `{enough: true, betterQuery: null, offers: [{url, verdict: 'ok', reason: null}, ...]}` (one entry per input offer); when `offers` is empty, returns `{enough: false, betterQuery: null, offers: []}` (nothing to review, but also nothing worth keeping without a retry decision from the caller).

- [ ] **Step 1: Write the failing test**

Create `src/aiAnalyst.test.js`. It stubs `chatComplete` — no real network call:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/aiAnalyst.test.js`
Expected: FAIL — `Cannot find module './aiAnalyst.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/aiAnalyst.js`:

```js
import { chatComplete as defaultChatComplete } from './nineRouter.js';
import { parseJsonResponse } from './jsonResponse.js';

/**
 * Gera uma query de busca limpa (marca/modelo/specs) a partir do nome bruto
 * extraído da página, removendo lixo de marketing (nome da loja, frete
 * grátis, emojis, etc). Cai no nome bruto se a IA falhar ou não ajudar.
 */
export async function buildSearchQuery(product, { chatComplete = defaultChatComplete } = {}) {
  try {
    const messages = [
      {
        role: 'system',
        content:
          'Você gera termos de busca curtos e limpos (marca, modelo, especificações) a partir do ' +
          'nome de um produto de e-commerce, removendo lixo de marketing (frete grátis, nome da loja, ' +
          'emojis, condições de pagamento, etc). Responda SEMPRE em JSON válido, sem texto fora do JSON: ' +
          '{"query":"..."}.',
      },
      { role: 'user', content: `Nome do produto: ${product.name}` },
    ];
    const raw = await chatComplete(messages);
    const parsed = parseJsonResponse(raw, {});
    if (typeof parsed.query === 'string' && parsed.query.trim()) {
      return parsed.query.trim();
    }
  } catch {
    // cai no fallback abaixo
  }
  return product.name;
}

/**
 * Segunda opinião de extração de nome/preço, usada quando a extração
 * mecânica (extractProduct) falha ou fica suspeita. Recebe o texto visível
 * da página (sem HTML/scripts) pra economizar tokens.
 */
export async function extractWithAI(pageText, url, { chatComplete = defaultChatComplete } = {}) {
  try {
    const messages = [
      {
        role: 'system',
        content:
          'Você extrai o nome e o preço à vista (em reais) de um produto a partir do texto de uma ' +
          'página de e-commerce. Responda SEMPRE em JSON válido, sem texto fora do JSON: ' +
          '{"name":"..."|null,"price":123.45|null,"currency":"BRL"}. ' +
          'Se não conseguir identificar com confiança, responda {"name":null,"price":null,"currency":"BRL"}.',
      },
      { role: 'user', content: `URL: ${url}\n\nTexto da página (pode estar truncado):\n${pageText.slice(0, 6000)}` },
    ];
    const raw = await chatComplete(messages);
    const parsed = parseJsonResponse(raw, { name: null, price: null, currency: 'BRL' });
    return {
      name: typeof parsed.name === 'string' ? parsed.name : null,
      price: typeof parsed.price === 'number' ? parsed.price : null,
      currency: typeof parsed.currency === 'string' ? parsed.currency : 'BRL',
    };
  } catch {
    return { name: null, price: null, currency: 'BRL' };
  }
}

function fallbackReview(offers) {
  return {
    enough: true,
    betterQuery: null,
    offers: offers.map((o) => ({ url: o.source, verdict: 'ok', reason: null })),
  };
}

/**
 * Revisa em lote todas as ofertas de uma rodada de busca, comparando cada
 * uma ao produto original: mesmo produto? preço plausível? Decide também
 * se a rodada foi "boa o bastante" e, se não, sugere uma query melhor.
 */
export async function reviewRound(original, offers, { chatComplete = defaultChatComplete } = {}) {
  if (offers.length === 0) {
    return { enough: false, betterQuery: null, offers: [] };
  }
  try {
    const offersDescription = offers
      .map(
        (o, i) =>
          `[${i + 1}] url: ${o.source}\nloja: ${o.store}\nnome: ${o.name}\npreço: ${o.price}\nsuspeito: ${o.suspicious ? 'sim' : 'não'}`
      )
      .join('\n\n');
    const messages = [
      {
        role: 'system',
        content:
          'Você revisa uma lista de ofertas encontradas numa busca por um produto, comparando cada uma ' +
          'ao produto original. Para cada oferta, decida um veredito: "ok" (mesmo produto, preço ' +
          'plausível), "duvidosa" (pode ser o produto certo mas há algo estranho, ex: preço parece ' +
          'parcela ou muito diferente das outras) ou "errada" (produto claramente diferente, página de ' +
          'categoria/busca, ou preço claramente errado). Decida também se a lista como um todo está ' +
          '"boa o bastante" (enough) — pelo menos uma oferta ok e nenhum sinal de que a busca trouxe ' +
          'produto errado em massa. Se não estiver boa o bastante, sugira uma query de busca melhor ' +
          '(betterQuery). Responda SEMPRE em JSON válido, sem texto fora do JSON: ' +
          '{"enough":true|false,"betterQuery":"..."|null,"offers":[{"url":"...","verdict":"ok"|"duvidosa"|"errada","reason":"..."|null}]}',
      },
      {
        role: 'user',
        content: `Produto original: ${original.name} (preço: ${original.price ?? 'desconhecido'})\n\nOfertas encontradas:\n${offersDescription}`,
      },
    ];
    const raw = await chatComplete(messages);
    const fallback = fallbackReview(offers);
    const parsed = parseJsonResponse(raw, fallback);
    if (!Array.isArray(parsed.offers)) return fallback;
    return {
      enough: typeof parsed.enough === 'boolean' ? parsed.enough : true,
      betterQuery: typeof parsed.betterQuery === 'string' && parsed.betterQuery.trim() ? parsed.betterQuery.trim() : null,
      offers: parsed.offers
        .filter((o) => o && typeof o.url === 'string')
        .map((o) => ({
          url: o.url,
          verdict: ['ok', 'duvidosa', 'errada'].includes(o.verdict) ? o.verdict : 'ok',
          reason: typeof o.reason === 'string' ? o.reason : null,
        })),
    };
  } catch {
    return fallbackReview(offers);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/aiAnalyst.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Run the full test suite so far**

Run: `node --test src/`
Expected: PASS (all tests from Tasks 1-5)

- [ ] **Step 6: Commit**

```bash
git add src/aiAnalyst.js src/aiAnalyst.test.js
git commit -m "feat: add aiAnalyst with query building, extraction fallback, batch review

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the round loop into server.js

**Files:**
- Modify: `server.js` (whole `/api/compare` handler, currently lines 33-97, plus the import block lines 1-6)

**Interfaces:**
- Consumes: `extractProduct`, `extractVisibleText` from `src/extractProduct.js` (Task 3); `buildSearchQuery`, `extractWithAI`, `reviewRound` from `src/aiAnalyst.js` (Task 5); `isOutlier` from `src/priceSanity.js` (Task 2); `mergeOffers`, `applyVerdicts`, `shouldRetry` from `src/offerRounds.js` (Task 4); `assessReliability` from `src/reliability.js` (unchanged); `webSearch` from `src/nineRouter.js` (unchanged).
- Produces: `POST /api/compare` response shape gains `searchQuery: string` (the final query used) at the top level; each offer in `offers` (and the original-as-offer) gains `verdict: 'ok'|'duvidosa'` and `verdictReason: string|null`.

No automated test for this task: it's thin orchestration over already-tested pure logic and the LLM/network calls (`fetchHtml`, `webSearch`, `assessReliability`) that the existing codebase has never mocked or tested. Verify manually with the dev server (Step 5 below), the same way `server.js` has always been validated in this project.

- [ ] **Step 1: Replace the imports**

In `server.js`, replace lines 1-6:

```js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { extractProduct } from './src/extractProduct.js';
import { webSearch } from './src/nineRouter.js';
import { assessReliability } from './src/reliability.js';
```

with:

```js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { extractProduct, extractVisibleText } from './src/extractProduct.js';
import { webSearch } from './src/nineRouter.js';
import { assessReliability } from './src/reliability.js';
import { buildSearchQuery, extractWithAI, reviewRound } from './src/aiAnalyst.js';
import { isOutlier } from './src/priceSanity.js';
import { mergeOffers, applyVerdicts, shouldRetry } from './src/offerRounds.js';

const MAX_SEARCH_ROUNDS = 2;
```

- [ ] **Step 2: Add the extractProductWithFallback helper**

After the existing `domainOf` function (after line 29, before `app.get('/health', ...)`), add:

```js
/**
 * Extrai nome/preço mecanicamente; se falhar ou ficar suspeito (preço
 * ambíguo ou ausente), pede uma segunda opinião pra IA. Usa o resultado da
 * IA só quando ela conseguir nome + preço; senão mantém o mecânico.
 */
async function extractProductWithFallback(html, pageUrl) {
  const mechanical = extractProduct(html, pageUrl);
  if (mechanical.blocked || (mechanical.name && !mechanical.suspicious)) {
    return mechanical;
  }
  const text = extractVisibleText(html);
  const ai = await extractWithAI(text, pageUrl);
  if (ai.name && ai.price != null) {
    return {
      name: ai.name,
      price: ai.price,
      currency: ai.currency,
      source: pageUrl,
      method: 'ai',
      blocked: false,
      suspicious: false,
    };
  }
  return mechanical;
}
```

- [ ] **Step 3: Replace the /api/compare handler body**

Replace lines 39-96 (the whole `try { ... } catch (err) { ... }` block inside the route handler) with:

```js
  try {
    // 1. Extrai nome + preço do produto original (mecânico, com segunda opinião da IA se suspeito)
    const originalHtml = await fetchHtml(url);
    const original = await extractProductWithFallback(originalHtml, url);
    if (original.blocked) {
      return res.status(422).json({
        error: 'Esse site bloqueou o acesso automatizado (página de verificação anti-bot) e não deixou ver o produto. Tente colar o link de outra loja.',
      });
    }
    if (!original.name) {
      return res.status(422).json({ error: 'Não consegui identificar o produto nessa página.' });
    }

    // 2. Monta a query de busca (a IA limpa o nome bruto; cai no nome bruto se falhar)
    let query = await buildSearchQuery(original);
    const originalDomain = domainOf(url);

    // 3. Roda até MAX_SEARCH_ROUNDS buscas, revisando em lote e refinando a query se preciso
    let offers = [];
    let roundsCompleted = 0;
    let review = null;

    while (roundsCompleted < MAX_SEARCH_ROUNDS) {
      const search = await webSearch(`${query} preço comprar`, { maxResults: 8 });
      const candidateUrls = (search.results || [])
        .map((r) => r.url)
        .filter((candidateUrl) => domainOf(candidateUrl) !== originalDomain)
        .slice(0, 5);

      const roundOffers = (
        await Promise.all(
          candidateUrls.map(async (candidateUrl) => {
            try {
              const html = await fetchHtml(candidateUrl);
              const extracted = await extractProductWithFallback(html, candidateUrl);
              if (extracted.blocked || !extracted.price) return null;
              const suspicious = extracted.suspicious || isOutlier(extracted.price, original.price);
              return { ...extracted, suspicious, store: domainOf(candidateUrl) };
            } catch {
              return null;
            }
          })
        )
      ).filter(Boolean);

      offers = mergeOffers(offers, roundOffers);
      roundsCompleted += 1;

      review = await reviewRound(original, offers);
      offers = applyVerdicts(offers, review.offers);

      if (!shouldRetry(review, roundsCompleted, MAX_SEARCH_ROUNDS)) break;
      query = review.betterQuery;
    }

    // 4. Avalia a confiabilidade de cada loja envolvida (original + ofertas que sobraram)
    const storeNames = [originalDomain, ...offers.map((o) => o.store)];
    const uniqueStoreNames = [...new Set(storeNames)];
    const reliabilityByStore = {};
    await Promise.all(
      uniqueStoreNames.map(async (name) => {
        reliabilityByStore[name] = await assessReliability(name);
      })
    );

    // 5. Monta a lista final, ordenada por preço
    const originalOffer = {
      ...original,
      store: originalDomain,
      verdict: 'ok',
      verdictReason: null,
      reliability: reliabilityByStore[originalDomain],
    };
    const allOffers = [
      originalOffer,
      ...offers.map((o) => ({ ...o, reliability: reliabilityByStore[o.store] })),
    ].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

    const eligibleForBest = allOffers.filter((o) => o.verdict === 'ok');
    const cheapest = eligibleForBest[0];
    const cheapestReliable = eligibleForBest.find((o) => o.reliability?.level === 'alta') || cheapest;

    res.json({ original, offers: allOffers, cheapest, cheapestReliable, searchQuery: query });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar a comparação.', details: err.message });
  }
```

- [ ] **Step 4: Run the full unit test suite (must still pass — this task adds no unit tests of its own)**

Run: `node --test src/`
Expected: PASS (all tests from Tasks 1-5, unaffected by this task)

- [ ] **Step 5: Manual verification with the dev server**

```bash
npm start
```

In another terminal:

```bash
curl -s -X POST http://localhost:3000/api/compare \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.exemplo-loja.com.br/produto-x"}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```

Expected: valid JSON response with `searchQuery`, and every entry in `offers` (including the first, which is the original) carrying `verdict` and `verdictReason`. Confirm no unhandled exception in the server logs. Stop the dev server (Ctrl+C) once confirmed.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: orchestrate AI-driven query building, extraction fallback, and batch review with retry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — show the search query and doubtful-offer warnings

**Files:**
- Modify: `public/index.html:44-49`
- Modify: `public/app.js:13-33`
- Modify: `public/styles.css` (append new rules)

**Interfaces:**
- Consumes: `data.searchQuery` and each offer's `verdict`/`verdictReason` from the `/api/compare` response (Task 6).

- [ ] **Step 1: Add a search-query placeholder to the results heading**

In `public/index.html`, replace lines 44-49:

```html
        <div id="result-content" hidden>
          <div class="results-heading">
            <div><p class="eyebrow">RESULTADOS ENCONTRADOS</p><h2 id="product-name">Ofertas para o produto</h2></div>
            <span id="offer-count" class="offer-count"></span>
          </div>
          <div id="highlights" class="highlights"></div>
```

with:

```html
        <div id="result-content" hidden>
          <div class="results-heading">
            <div><p class="eyebrow">RESULTADOS ENCONTRADOS</p><h2 id="product-name">Ofertas para o produto</h2><p id="search-query" class="search-query" hidden></p></div>
            <span id="offer-count" class="offer-count"></span>
          </div>
          <div id="highlights" class="highlights"></div>
```

- [ ] **Step 2: Render the search query and per-offer warnings in app.js**

In `public/app.js`, replace the `offerCard` function (lines 13-22):

```js
function offerCard(offer) {
  const level = offer.reliability?.level || 'desconhecida';
  const store = domain(offer.store || new URL(offer.source).hostname);
  const initials = store.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
  return `<article class="offer">
    <div class="offer-name"><span class="store-avatar">${initials}</span><div><div class="store-name">${store}</div><div class="reliability ${level}"><i></i>${reliabilityLabel[level] || reliabilityLabel.desconhecida}</div></div></div>
    <div class="offer-price"><strong>${offer.price != null ? money(offer.price, offer.currency) : 'Consulte'}</strong><span>Preço encontrado</span></div>
    <a class="offer-link" href="${offer.source}" target="_blank" rel="noopener noreferrer">Ver oferta ↗</a>
  </article>`;
}
```

with:

```js
function offerCard(offer) {
  const level = offer.reliability?.level || 'desconhecida';
  const store = domain(offer.store || new URL(offer.source).hostname);
  const initials = store.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
  const warning = offer.verdict === 'duvidosa'
    ? `<div class="offer-warning">⚠ ${offer.verdictReason || 'Verifique se é o mesmo produto antes de comprar.'}</div>`
    : '';
  return `<article class="offer">
    <div class="offer-name"><span class="store-avatar">${initials}</span><div><div class="store-name">${store}</div><div class="reliability ${level}"><i></i>${reliabilityLabel[level] || reliabilityLabel.desconhecida}</div>${warning}</div></div>
    <div class="offer-price"><strong>${offer.price != null ? money(offer.price, offer.currency) : 'Consulte'}</strong><span>Preço encontrado</span></div>
    <a class="offer-link" href="${offer.source}" target="_blank" rel="noopener noreferrer">Ver oferta ↗</a>
  </article>`;
}
```

Then, in `showResults`, replace the first line of the function body (currently line 26, `document.querySelector('#product-name').textContent = ...`) — keep it, but add a new line right after it:

```js
function showResults(data) {
  const offers = data.offers || [];
  document.querySelector('#product-name').textContent = data.original?.name || 'Ofertas para o produto';
  const searchQueryEl = document.querySelector('#search-query');
  if (data.searchQuery) {
    searchQueryEl.textContent = `Buscamos por: "${data.searchQuery}"`;
    searchQueryEl.hidden = false;
  } else {
    searchQueryEl.hidden = true;
  }
  document.querySelector('#offer-count').textContent = `${offers.length} ${offers.length === 1 ? 'oferta' : 'ofertas'}`;
```

(the rest of `showResults` — `cheapest`, `reliable`, `#highlights`, `#offers-list` — stays exactly as-is).

- [ ] **Step 3: Add the CSS for the search-query line and offer warning**

Append to `public/styles.css` (new lines at the end of the file):

```css
.search-query { margin:4px 0 0; color:var(--muted); font-size:12px; font-style:italic; }
.offer-warning { margin-top:6px; color:var(--amber); font-size:11px; font-weight:600; }
```

- [ ] **Step 4: Manual verification in the browser**

```bash
npm start
```

Open `http://localhost:3000`, submit a product URL, and confirm:
- The "Buscamos por: ..." line appears under the product name once results load.
- If any offer comes back with `verdict: 'duvidosa'` (can be forced temporarily by editing a test response in devtools, or observed naturally), its card shows the amber warning line and it never appears as the "MELHOR PREÇO"/"MELHOR OPÇÃO CONFIÁVEL" highlight.

Stop the dev server (Ctrl+C) once confirmed.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat: show search query used and doubtful-offer warnings in the UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Test script and final full-suite check

**Files:**
- Modify: `package.json:7-9`

**Interfaces:**
- Produces: `npm test` runs the full `node --test` suite across `src/`.

- [ ] **Step 1: Add the test script**

In `package.json`, replace:

```json
  "scripts": {
    "start": "node server.js"
  },
```

with:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test src/"
  },
```

- [ ] **Step 2: Run the full suite via npm**

Run: `npm test`
Expected: PASS — all tests from Tasks 1, 2, 3, 4, 5 (jsonResponse, priceSanity, extractProduct, offerRounds, aiAnalyst), 0 failures.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add npm test script for the node --test suite

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
