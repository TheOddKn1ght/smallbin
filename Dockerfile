FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM oven/bun:1.4.2 AS production-dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3210 HOST=0.0.0.0 DATA_DIR=/data MIGRATIONS_DIR=/app/drizzle
RUN mkdir -p /data && chown bun:bun /data && chmod 700 /data
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
USER bun
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3210}/healthz`, { signal: AbortSignal.timeout(4000) }); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "dist/index.js"]
