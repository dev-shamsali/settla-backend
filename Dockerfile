FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
USER app
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "src/server.js"]
