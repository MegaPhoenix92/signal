# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
ARG VITE_SIGNAL_API_URL=http://localhost:8787
ENV VITE_SIGNAL_API_URL=${VITE_SIGNAL_API_URL}
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY scripts ./scripts
COPY data/sample-seed.json ./data/sample-seed.json
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787 8791
CMD ["node", "scripts/signal-api.mjs"]

FROM runtime AS api
CMD ["node", "scripts/signal-api.mjs"]

FROM runtime AS state-service
CMD ["node", "scripts/signal-state-service.mjs"]

FROM runtime AS scheduler
CMD ["node", "scripts/signal-scheduler.mjs"]

FROM node:22-alpine AS frontend
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY scripts/signal-frontend-server.mjs ./scripts/signal-frontend-server.mjs
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "scripts/signal-frontend-server.mjs"]
