FROM node:22.23.4-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.23.4-alpine
RUN addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY --from=deps /app/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/db.js server/index.js server/tgbot.js server/fence.js ./server/
COPY index.html ./index.html
COPY pages ./pages
COPY posts ./posts
COPY scripts ./scripts
COPY styles ./styles
COPY media ./media
COPY archive ./archive
COPY nicks.csv ./nicks.csv

RUN chown -R app:app /app
USER app

WORKDIR /app/server
CMD ["node", "index.js"]
