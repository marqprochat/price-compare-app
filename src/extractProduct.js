import * as cheerio from 'cheerio';

/**
 * Converte uma string de preço (em qualquer formato comum, BR ou US) em número.
 * Ex: "R$ 1.234,56" -> 1234.56 | "$1,234.56" -> 1234.56
 */
function parsePriceString(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma > -1 && lastDot > -1) {
    // O separador decimal é o que aparece por último
    normalized = lastComma > lastDot
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (lastComma > -1) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  }

  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Extrai nome + preço de uma página de produto, tentando (em ordem):
 * 1. JSON-LD schema.org/Product
 * 2. Meta tags Open Graph / product:price
 * 3. Fallback: regex procurando "R$ ..." no texto da página
 *
 * Cobre a maioria dos e-commerces com HTML renderizado no servidor.
 * Sites que montam o preço via JavaScript (SPA pura) não são cobertos aqui
 * — precisariam de um navegador headless (Playwright/Puppeteer).
 */
export function extractProduct(html, pageUrl) {
  const $ = cheerio.load(html);
  const result = { name: null, price: null, currency: 'BRL', source: pageUrl, method: null };

  $('script[type="application/ld+json"]').each((_, el) => {
    if (result.name && result.price) return;
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const items = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
    for (const item of items) {
      if (!item) continue;
      const type = item['@type'];
      const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      if (!isProduct) continue;

      result.name = result.name || item.name || null;
      const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
      if (offers) {
        const price = offers.price ?? offers.lowPrice;
        result.price = result.price ?? parsePriceString(price);
        result.currency = offers.priceCurrency || result.currency;
      }
      result.method = 'json-ld';
    }
  });

  if (!result.name) {
    result.name = $('meta[property="og:title"]').attr('content')
      || $('title').first().text().trim()
      || null;
    if (result.name && !result.method) result.method = 'meta';
  }

  if (!result.price) {
    const metaPrice = $('meta[property="product:price:amount"]').attr('content')
      || $('meta[property="og:price:amount"]').attr('content')
      || $('meta[itemprop="price"]').attr('content');
    if (metaPrice) {
      result.price = parsePriceString(metaPrice);
      result.method = result.method || 'meta';
    }
  }

  if (!result.price) {
    const bodyText = $('body').text();
    const match = bodyText.match(/R\$\s?[\d.,]+/);
    if (match) {
      result.price = parsePriceString(match[0]);
      result.method = result.method || 'regex-fallback';
    }
  }

  return result;
}
