# syntax=docker/dockerfile:1.7

# ─── build stage ────────────────────────────────────────────────────────────
# `-dev` variant has a shell and apk, which we need for the build. The runtime
# stage uses the distroless variant.
FROM cgr.dev/chainguard/node:latest-dev AS build

USER root
WORKDIR /app

# Use the pnpm version pinned in package.json's `packageManager` field via
# corepack (bundled with Node 24). Disable the first-run download prompt so
# the install step is non-interactive in CI.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Install all deps (incl. devDeps for tsc) using the lockfile
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Drop devDeps so we ship a slim node_modules in the final image
RUN pnpm prune --prod

# ─── final stage ────────────────────────────────────────────────────────────
# Distroless Chainguard node — no shell, no package manager, just node + libc.
# Default user is `nonroot` (uid 65532); no need to create one.
FROM cgr.dev/chainguard/node:latest

WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /app/package.json   ./package.json
COPY --from=build --chown=nonroot:nonroot /app/node_modules   ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist           ./dist

ENV NODE_ENV=production
EXPOSE 8099

ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--transport", "http-streamable", "--port", "8099", "--path", "/mcp"]
