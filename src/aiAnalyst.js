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
