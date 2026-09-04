# Price Compare API

MVP: recebe o link de um produto, extrai nome + preço da página, busca a mesma
oferta em outras lojas via 9router/SearXNG, e avalia a confiabilidade de cada
loja usando busca na web + resumo por LLM.

## Como funciona

1. `POST /api/compare` com `{ "url": "https://loja.com/produto" }`.
2. A API baixa o HTML da página e extrai nome/preço (JSON-LD → meta tags → regex).
3. Busca `"<nome do produto> preço comprar"` via `/v1/search` do 9router (provider `searxng`).
4. Tenta extrair preço das primeiras 5 páginas concorrentes encontradas.
5. Para cada loja envolvida, busca `"<loja> reclame aqui avaliação"` e pede pro
   LLM (via `/v1/chat/completions` do 9router) resumir um nível de confiança
   (`alta`/`media`/`baixa`/`desconhecida`).
6. Retorna tudo ordenado por preço, destacando o mais barato e o mais barato
   com confiabilidade alta.

## Setup

```bash
npm install
cp .env.example .env
# edite o .env com sua NINEROUTER_URL, NINEROUTER_KEY e NINEROUTER_MODEL
npm start
```

## Testar

```bash
curl -X POST http://localhost:3000/api/compare \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.exemplo-loja.com.br/produto-x"}'
```

## Deploy no Easypanel

1. Suba esse projeto (com o `Dockerfile` incluído) num repositório Git — o
   Easypanel builda a partir de um repo (GitHub/GitLab) ou de upload direto.
2. No Easypanel, crie um novo serviço do tipo **App**, aponte pro repositório
   (ele detecta o `Dockerfile` automaticamente).
3. Em **Environment**, adicione as variáveis do `.env.example`:
   - `NINEROUTER_URL`
   - `NINEROUTER_KEY`
   - `NINEROUTER_MODEL`
   - `PORT=3000`
4. Em **Domains/Proxy**, aponte a porta do container para `3000` (a mesma do
   `EXPOSE` do Dockerfile) e configure o domínio/subdomínio desejado.
5. Deploy. O Easypanel usa o `HEALTHCHECK` do Dockerfile (`/health`) pra saber
   se o container subiu certo.

> Importante: se o 9router estiver rodando fora do Easypanel (ex: direto na
> VPS via PM2/tray, como o seu), `NINEROUTER_URL` precisa ser um endereço
> alcançável a partir do container — não `localhost` (que dentro do container
> aponta pra ele mesmo). Use o IP da VPS ou o hostname interno da rede Docker
> do Easypanel, conforme onde o 9router estiver escutando.

## Limitações conhecidas (é um MVP)

- A extração de nome/preço funciona bem em sites com dados estruturados
  (JSON-LD `Product`/`Offer` ou meta tags Open Graph) — é o padrão da maioria
  dos e-commerces. Sites que montam o preço só via JavaScript (SPA pura)
  não são cobertos; precisaria de um navegador headless (Playwright) pra isso.
- A busca de concorrentes depende da qualidade dos resultados do SearXNG —
  às vezes vai trazer páginas de categoria/blog em vez de produto direto.
- A "confiabilidade" é uma opinião do LLM baseada nos snippets de busca, não
  uma nota oficial — trate como um indicador, não uma verdade absoluta.
- Rodar esse tipo de scraping contra sites de terceiros pode esbarrar em
  termos de uso deles — para volume alto/uso comercial, vale revisar os
  ToS das lojas-alvo ou usar uma API oficial de comparação quando existir.

## Próximos passos sugeridos

- Adicionar cache (Redis) pra não rebuscar o mesmo produto repetidamente.
- Rate limiting na API pra não sobrecarregar o SearXNG/LLM.
- Trocar o extrator por Playwright quando o método `regex-fallback`/`meta`
  falhar, pra cobrir sites SPA.
- Persistir histórico de preços por produto (útil pra "menor preço dos
  últimos 90 dias", como muitos comparadores fazem).
