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
