FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
RUN apk add --no-cache libstdc++ \
    && addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/data.sqlite

WORKDIR /app
COPY --from=deps /app/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/db.js server/index.js server/tgbot.js ./server/
COPY index.html ./index.html
COPY pages ./pages
COPY posts ./posts
COPY scripts ./scripts
COPY styles ./styles
COPY media ./media

RUN mkdir -p /data && chown -R app:app /app /data
USER app

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- --spider "http://127.0.0.1:${PORT}/" || exit 1

WORKDIR /app/server
CMD ["node", "index.js"]
