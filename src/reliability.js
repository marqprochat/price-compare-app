import { webSearch, chatComplete } from './nineRouter.js';

/**
 * Avalia a confiabilidade de uma loja/vendedor:
 * 1. Busca na web por avaliações/reclamações sobre a loja.
 * 2. Passa os trechos encontrados pra um LLM (via 9router) resumir
 *    em um nível de confiança + justificativa curta.
 */
export async function assessReliability(storeName) {
  let results = [];
  try {
    const search = await webSearch(`${storeName} reclame aqui avaliação é confiável`, { maxResults: 5 });
    results = search.results || [];
  } catch {
    return { level: 'desconhecida', summary: 'Não foi possível buscar avaliações no momento.', sources: [] };
  }

  if (results.length === 0) {
    return { level: 'desconhecida', summary: 'Nenhuma informação de reputação encontrada.', sources: [] };
  }

  const context = results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nFonte: ${r.url}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content:
        'Você avalia a confiabilidade de lojas online a partir de trechos de busca na web. ' +
        'Responda SEMPRE em JSON válido, sem texto fora do JSON: ' +
        '{"level":"alta|media|baixa|desconhecida","summary":"resumo em 1-2 frases em português"}. ' +
        'Baseie-se só no conteúdo fornecido, sem inventar dados.',
    },
    {
      role: 'user',
      content: `Loja: ${storeName}\n\nResultados de busca:\n${context}`,
    },
  ];

  let level = 'desconhecida';
  let summary = 'Não foi possível avaliar.';
  try {
    const raw = await chatComplete(messages);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');
    level = parsed.level || level;
    summary = parsed.summary || summary;
  } catch {
    // mantém os valores padrão se o LLM falhar ou responder fora do formato
  }

  return { level, summary, sources: results.slice(0, 5).map((r) => r.url) };
}
