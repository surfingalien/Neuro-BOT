FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* && npm i -g bun
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=file:/tmp/build.db
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 PORT=3000 \
    DATABASE_URL=file:/data/custom.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/.next/standalone ./.next/standalone
RUN mkdir -p /data
EXPOSE 3000
# Create/sync the SQLite schema, then boot the standalone server on 0.0.0.0:$PORT.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js db push --skip-generate && exec node .next/standalone/server.js"]
