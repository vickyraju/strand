FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Node 24 runs TypeScript directly (type stripping), so there is no build step
COPY src ./src
USER node
EXPOSE 3001
CMD ["node", "src/index.ts"]
