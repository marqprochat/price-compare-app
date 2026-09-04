import * as cheerio from 'cheerio';
import { extractPriceCandidates, pickBestCandidate } from './priceSanity.js';

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

// Trechos típicos de páginas de verificação anti-bot (captcha, "acesse sua conta", etc.)
// que alguns sites (ex: Mercado Livre) servem no lugar da página real quando detectam
// tráfego automatizado. Quando isso acontece não há produto pra extrair — só a página de bloqueio.
const BOT_BLOCK_MARKERS = [
  /suspicious[_-]?traffic/i,
  /account-verification/i,
  /captcha/i,
  /are you a human/i,
  /verifique que você é humano/i,
  /unusual traffic/i,
  /robot check/i,
  /attention required/i,
  /just a moment/i,
];

function looksLikeBotBlock(html, title) {
  if (BOT_BLOCK_MARKERS.some((re) => re.test(html))) return true;
  // Título genérico do site (sem nome de produto nenhum) é outro sinal forte de bloqueio.
  if (title && /^mercado li(v|b)re$/i.test(title.trim())) return true;
  return false;
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
 *
 * Alguns sites (ex: Mercado Livre) servem uma página de verificação anti-bot
 * no lugar do produto quando detectam a requisição como automatizada; nesse caso
 * o resultado vem com `blocked: true` em vez de nome/preço inventados a partir do bloqueio.
 */
export function extractProduct(html, pageUrl) {
  const $ = cheerio.load(html);
  const result = { name: null, price: null, currency: 'BRL', source: pageUrl, method: null, blocked: false, suspicious: false };

  const rawTitle = $('title').first().text().trim();
  if (looksLikeBotBlock(html, rawTitle)) {
    result.blocked = true;
    result.method = 'blocked';
    return result;
  }

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
    const candidates = extractPriceCandidates(bodyText);
    const { raw, suspicious } = pickBestCandidate(candidates);
    if (raw) {
      result.price = parsePriceString(raw);
      result.method = result.method || 'regex-fallback';
    }
    if (suspicious) result.suspicious = true;
  }

  return result;
}

/**
 * Texto visível de uma página (sem scripts/estilos), pra alimentar um LLM
 * como segunda opinião de extração sem gastar tokens com HTML/JS irrelevante.
 */
export function extractVisibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}
