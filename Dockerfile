FROM node:22-bookworm-slim AS build

WORKDIR /app

ARG VITE_SIGNAL_API_URL=http://127.0.0.1:8787
ENV VITE_SIGNAL_API_URL=$VITE_SIGNAL_API_URL

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    SIGNAL_API_HOST=0.0.0.0 \
    SIGNAL_API_PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/data ./data

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["node", "scripts/signal-api.mjs"]
