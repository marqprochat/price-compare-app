const INSTALLMENT_MARKERS = /(\d+\s*x\b|sem juros|\/\s*m[eê]s|por\s+m[eê]s)/i;
// Dígitos seguidos de grupos opcionais de separador+dígitos, pra não engolir um
// ponto final de frase (ex: "R$ 2.499,90." não deve virar "R$ 2.499,90.").
const PRICE_RE = /R\$\s?\d+(?:[.,]\d+)*/g;
const CONTEXT_RADIUS = 40;

/**
 * Encontra todos os preços "R$ ..." no texto, descartando os que parecem
 * parcela ou mensalidade (têm um marcador de parcelamento perto).
 */
export function extractPriceCandidates(text) {
  const matches = [...text.matchAll(PRICE_RE)];
  const candidates = [];
  // Texto entre duas ocorrências de preço pertence ao preço anterior (ex: "R$ X sem
  // juros ou R$ Y" — "sem juros" descreve X, não deve "vazar" pro lookbehind de Y).
  let claimedUntil = 0;
  matches.forEach((match, i) => {
    const matchEnd = match.index + match[0].length;
    const backwardContext = text.slice(Math.max(claimedUntil, match.index - CONTEXT_RADIUS), match.index);

    const nextStart = i < matches.length - 1 ? matches[i + 1].index : text.length;
    const forwardEnd = Math.min(nextStart, matchEnd + CONTEXT_RADIUS);
    const forwardContext = text.slice(matchEnd, forwardEnd);
    claimedUntil = forwardEnd;

    if (INSTALLMENT_MARKERS.test(backwardContext) || INSTALLMENT_MARKERS.test(forwardContext)) return;
    candidates.push(match[0]);
  });
  return candidates;
}

/**
 * Escolhe o melhor candidato de preço. Zero ou mais de um candidato é
 * ambíguo — marca `suspicious: true` pra pedir uma segunda opinião.
 */
export function pickBestCandidate(candidates) {
  if (candidates.length === 0) return { raw: null, suspicious: true };
  if (candidates.length > 1) return { raw: candidates[0], suspicious: true };
  return { raw: candidates[0], suspicious: false };
}

/**
 * Um preço muito abaixo (<15%) ou muito acima (>400%) do preço de
 * referência provavelmente é erro de extração (frete, acessório, etc).
 */
export function isOutlier(price, referencePrice) {
  if (price == null || referencePrice == null || referencePrice === 0) return false;
  const ratio = price / referencePrice;
  return ratio < 0.15 || ratio > 4;
}
