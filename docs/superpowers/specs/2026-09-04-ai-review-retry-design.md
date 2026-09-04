# Revisão e retry de busca via IA — Design

Data: 2026-09-04

## Problema

Hoje o app extrai nome/preço mecanicamente (JSON-LD → meta tags → regex) e busca
concorrentes via SearXNG, mas nada valida se as ofertas encontradas são
realmente o mesmo produto, nem se o preço extraído é o preço real (e não uma
parcela ou o frete). A query de busca também usa o título bruto da página
("Notebook X | Loja Y | Frete Grátis"), que traz resultados ruins. O usuário
sente que "a IA não está fazendo muito" — hoje ela só resume reputação de loja.

## Objetivo

Fazer a IA participar ativamente do pipeline: montar uma query de busca limpa,
servir de rede de segurança quando a extração mecânica falha, revisar o lote
de ofertas encontradas (mesmo produto? preço plausível?) e, se o resultado da
rodada for ruim, reescrever a query e tentar de novo — até 2 rodadas no total.

## Arquitetura

Novo módulo `src/aiAnalyst.js` concentra os três papéis de LLM:

- `buildSearchQuery(product)` — 1 chamada por comparação. Transforma o nome
  bruto extraído em termos de busca limpos (marca/modelo/specs), sem lixo de
  marketing.
- `extractWithAI(pageText, url)` — só chamada quando `extractProduct`
  mecânico falha ou marca o resultado como suspeito (ver seção Sanity Check).
- `reviewRound(original, offers)` — 1 chamada por rodada, em lote (não uma
  chamada por oferta). Recebe o produto original e todas as ofertas da
  rodada; devolve veredito por oferta, se a rodada foi "boa o bastante", e
  (se não foi) uma query melhorada pra próxima rodada.

`extractProduct.js` continua puro/mecânico, sem rede nem LLM.
`reliability.js` fica como está.
`server.js` orquestra as rodadas.

## Fluxo

1. Baixa a página original → `extractProduct` mecânico.
   - Bloqueio anti-bot detectado → 422 (comportamento já existente).
   - Falhou ou ficou suspeito → `extractWithAI` como fallback.
   - Ainda sem nome → 422.
2. `buildSearchQuery(original)` gera o termo de busca.
3. **Rodada** (máx. 2):
   a. `webSearch(query)`, filtra domínio original, pega as 5 primeiras.
   b. Baixa cada uma, `extractProduct` mecânico (fallback `extractWithAI`
      se suspeito/falhou).
   c. Sanity check determinístico de preço (seção abaixo) marca
      `suspicious: true` quando aplicável.
   d. `reviewRound(original, offers)` → veredito por oferta
      (`ok` | `duvidosa` | `errada`), `enough: boolean`,
      `betterQuery?: string`.
   e. Se `enough === false`, veio `betterQuery`, e ainda não rodou 2 vezes:
      nova rodada com a query nova. Resultados das rodadas são unidos e
      deduplicados por URL (a rodada mais recente vence em caso de conflito).
4. Ofertas com veredito `errada` são descartadas da lista final. `ok` e
   `duvidosa` ficam; `duvidosa` carrega o motivo (ex: "preço pode ser
   parcela") pra exibição, e nunca é elegível para "melhor preço"/"melhor
   opção confiável".
5. Reputação (`assessReliability`) roda só para as lojas que sobraram.
6. Resposta final: mesma forma de hoje (`original`, `offers`, `cheapest`,
   `cheapestReliable`) + campo novo `original.name` já normalizado e
   `searchQuery` (a query final usada) pra exibição no frontend.

## Sanity check determinístico (sem LLM)

Antes de qualquer chamada de IA, um passo barato resolve os casos óbvios:

- Ao extrair preço via fallback regex, coletar **todos** os candidatos
  `R$ ...` da página (não só o primeiro), descartando os que têm
  `\d+x`, `sem juros`, `/mês`, `por mês` na vizinhança (~40 caracteres).
- Se restar mais de um candidato plausível, ou nenhum, marcar
  `suspicious: true` no resultado da extração mecânica.
- Comparar o preço restante contra o preço do produto original: se estiver
  abaixo de 15% ou acima de 400% dele, marcar `suspicious: true` também.

`suspicious: true` é o gatilho pra chamar `extractWithAI` como segunda
opinião (mecânico + suspeito → tenta IA; se IA concordar ou não conseguir
extrair melhor, mantém o valor mecânico com a flag pro `reviewRound` avaliar).

## Contrato dos prompts (JSON)

Todas as chamadas usam `chatComplete` do `nineRouter.js` pedindo JSON puro,
com um parser tolerante compartilhado (extrai o primeiro `{...}` da resposta
e faz `JSON.parse`, como já existe em `reliability.js` hoje — vira helper
`parseJsonResponse(raw, fallback)` reaproveitado nos três papéis + no
`reliability.js` existente).

- `buildSearchQuery` → `{"query": "..."}`
- `extractWithAI` → `{"name": "...", "price": 123.45, "currency": "BRL"}` ou
  `{"name": null, "price": null}` se não conseguir.
- `reviewRound` → `{"enough": bool, "betterQuery": "..."|null,
  "offers": [{"url": "...", "verdict": "ok"|"duvidosa"|"errada",
  "reason": "..."|null}]}`

## Tratamento de falhas

Toda chamada ao LLM (`buildSearchQuery`, `extractWithAI`, `reviewRound`) é
embrulhada em try/catch com fallback explícito:

- `buildSearchQuery` falha → usa o nome extraído mecanicamente como query
  (comportamento atual).
- `extractWithAI` falha → mantém o resultado mecânico (mesmo que
  incompleto/suspeito).
- `reviewRound` falha → todas as ofertas com preço são tratadas como `ok`
  (comportamento atual), sem retry.

Nunca deixa a falha de IA quebrar a comparação — no pior caso, o app volta a
se comportar exatamente como hoje.

## Interface (frontend)

- Cabeçalho mostra a query de busca usada (`data.searchQuery`), dando
  visibilidade do que a IA fez.
- Card de oferta com `verdict === 'duvidosa'` ganha uma linha de aviso com
  o `reason` (ex: "pode ser outro modelo", "preço pode ser parcela").
- Ofertas `errada` simplesmente não aparecem (já descartadas no backend).

## Testes

Sem test runner hoje; adiciono `node --test` (nativo, zero dependência),
cobrindo lógica pura com o LLM stubado (sem rede):

- Parsing de preço e detecção de parcela/frete no sanity check.
- Regra de outlier (15%/400%).
- `parseJsonResponse` (JSON válido, JSON com texto ao redor, JSON inválido →
  fallback).
- Merge/dedupe de ofertas entre rodadas (por URL, rodada mais recente vence).
- Filtro de veredito (`errada` descartada, `duvidosa` mantida e não elegível
  a "melhor preço").

## Fora de escopo

- Cache de buscas (Redis) — mencionado no README como próximo passo, não faz
  parte deste trabalho.
- Rate limiting.
- Terceira rodada de busca (mantém o teto de 2 decidido no brainstorming).
- Tool-calling / LLM conduzindo o loop sozinho — descartado no brainstorming
  por imprevisibilidade de custo/latência.
