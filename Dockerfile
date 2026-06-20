FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --create-home --home-dir /home/app app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/docs/operations.md ./docs/operations.md
COPY --from=build /app/.env.example ./.env.example

ENV NODE_ENV=production
ENV TZ=Europe/Berlin
ENV BSAG_MCP_DATA_DIR=/data

VOLUME ["/data"]

USER app

CMD ["node", "dist/transports/stdio.js"]
