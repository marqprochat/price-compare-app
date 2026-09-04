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
