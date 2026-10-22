# syntax=docker/dockerfile:1
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o ${NODE_EXTRA_CA_CERTS} https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Node 24 runs TypeScript directly (type stripping), so there is no build step
COPY src ./src
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY migrations ./migrations
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/index.ts"]
