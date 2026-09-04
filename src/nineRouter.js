import axios from 'axios';

const NINEROUTER_URL = process.env.NINEROUTER_URL || 'http://localhost:20128';
const NINEROUTER_KEY = process.env.NINEROUTER_KEY || '';

const client = axios.create({
  baseURL: NINEROUTER_URL,
  timeout: 10000,
  headers: NINEROUTER_KEY ? { Authorization: `Bearer ${NINEROUTER_KEY}` } : {},
});

/**
 * Busca na web usando o provider configurado no 9router (ex: "searxng").
 * Ver: skills/9router-web-search/SKILL.md no repositório do 9router.
 */
export async function webSearch(query, { provider = 'searxng', maxResults = 8, searchType = 'web' } = {}) {
  const { data } = await client.post('/v1/search', {
    model: provider,
    query,
    max_results: maxResults,
    search_type: searchType,
  });
  return data; // { provider, query, results: [...], answer, usage, metrics, errors }
}

/**
 * Chamada de chat/LLM compatível com OpenAI via 9router.
 * O "model" deve ser um provider de chat já configurado no seu dashboard.
 */
export async function chatComplete(messages, { model = process.env.NINEROUTER_MODEL || 'gpt-4o-mini', temperature = 0.2 } = {}) {
  const { data } = await client.post('/v1/chat/completions', {
    model,
    messages,
    temperature,
  });
  return data?.choices?.[0]?.message?.content ?? '';
}
