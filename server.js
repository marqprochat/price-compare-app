import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { extractProduct } from './src/extractProduct.js';
import { webSearch } from './src/nineRouter.js';
import { assessReliability } from './src/reliability.js';

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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/compare', async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Envie { "url": "https://..." } no corpo da requisição.' });
  }

  try {
    // 1. Extrai nome + preço do produto original
    const originalHtml = await fetchHtml(url);
    const original = extractProduct(originalHtml, url);
    if (original.blocked) {
      return res.status(422).json({
        error: 'Esse site bloqueou o acesso automatizado (página de verificação anti-bot) e não deixou ver o produto. Tente colar o link de outra loja.',
      });
    }
    if (!original.name) {
      return res.status(422).json({ error: 'Não consegui identificar o produto nessa página.' });
    }

    // 2. Busca o produto na web pra achar concorrentes
    const search = await webSearch(`${original.name} preço comprar`, { maxResults: 8 });
    const candidateUrls = (search.results || [])
      .map((r) => r.url)
      .filter((candidateUrl) => domainOf(candidateUrl) !== domainOf(url))
      .slice(0, 5);

    // 3. Extrai preço de cada concorrente (em paralelo, tolerando falhas individuais)
    const alternatives = await Promise.all(
      candidateUrls.map(async (candidateUrl) => {
        try {
          const html = await fetchHtml(candidateUrl);
          const extracted = extractProduct(html, candidateUrl);
          return { ...extracted, store: domainOf(candidateUrl) };
        } catch {
          return null;
        }
      })
    );
    const validAlternatives = alternatives.filter((a) => a && a.price);

    // 4. Avalia a confiabilidade de cada loja envolvida (original + alternativas com preço encontrado)
    const storeNames = [domainOf(url), ...validAlternatives.map((a) => a.store)];
    const uniqueStoreNames = [...new Set(storeNames)];
    const reliabilityByStore = {};
    await Promise.all(
      uniqueStoreNames.map(async (name) => {
        reliabilityByStore[name] = await assessReliability(name);
      })
    );

    // 5. Monta a lista final, ordenada por preço
    const allOffers = [
      { ...original, store: domainOf(url), reliability: reliabilityByStore[domainOf(url)] },
      ...validAlternatives.map((a) => ({ ...a, reliability: reliabilityByStore[a.store] })),
    ].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

    const cheapest = allOffers[0];
    const cheapestReliable = allOffers.find((o) => o.reliability?.level === 'alta') || cheapest;

    res.json({ original, offers: allOffers, cheapest, cheapestReliable });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar a comparação.', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Price Compare API rodando em http://localhost:${PORT}`));
