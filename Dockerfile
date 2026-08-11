# Adeia — one image serving the landing page and the API from one origin.
#
# Two stages. The first needs a compiler because better-sqlite3 is a native
# module; the second does not, and copying the built node_modules across
# keeps the toolchain out of the shipped image. Both stages share a base, so
# the compiled binding is ABI-compatible.
#
# TypeScript is not built. Node runs the sources directly with
# --experimental-strip-types, which is how the dev script runs them too —
# one execution path, not two.

# ---------- stage 1: dependencies ----------
FROM node:22-slim AS deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests first, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
COPY src/shared/package.json  src/shared/
COPY src/backend/package.json src/backend/
COPY src/sdk/package.json     src/sdk/

# The demo agent under examples/ is a workspace but is not part of the
# server; leaving it out keeps its dependency tree out of the image.
RUN npm ci --omit=dev --workspace @adeia/server --include-workspace-root

# ---------- stage 2: runtime ----------
FROM node:22-slim AS runner

ENV NODE_ENV=production
# Written to the mounted volume, not the container filesystem — anything
# else is lost on the next deploy.
ENV ADEIA_DB_PATH=/data/adeia.db
ENV PORT=3000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/shared  ./src/shared
COPY src/backend ./src/backend
COPY src/sdk     ./src/sdk
COPY src/frontend ./src/frontend
COPY scripts ./scripts

# Drop root. The volume is chowned by the platform at mount time.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/backend/src/server.ts"]
