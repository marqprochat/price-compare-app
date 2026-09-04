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
