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

const app = express();
app.use(express.json());
app.use(express.static('public'));

const USER_AGENT = 'Mozilla/5.0 (compatible; PriceCompareBot/1.0; +https://example.com/bot)';

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
    maxRedirects: 5,
  });
  return data;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/compare', async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Envie { "url": "https://..." } no corpo da requisição.' });
  }

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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Price Compare API rodando em http://localhost:${PORT}`));
