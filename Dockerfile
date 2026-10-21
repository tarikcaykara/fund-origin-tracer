# syntax=docker/dockerfile:1
FROM oven/bun:1.4.3-debian AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.4.3-debian
WORKDIR /app
ENV NODE_ENV=production
# Production dependencies only; the web app is prebuilt, so its dependencies are skipped.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --production --filter '!@fot/web'
COPY packages/core/src packages/core/src
COPY packages/core/labels packages/core/labels
COPY apps/server/src apps/server/src
COPY apps/cli/src apps/cli/src
COPY fixtures/demo fixtures/demo
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
ENV DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK CMD bun -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"
CMD ["bun","apps/cli/src/main.ts","serve"]
