FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (aproveita cache de camada do Docker)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o restante do código
COPY . .

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
