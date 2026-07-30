# Next.js app image (free-beta Block D1) — the Cloud Run *service* half of the
# GCP migration. Companion to Dockerfile.worker (the worker-pool half); the two
# share a base image and env conventions but nothing else: this one runs a real
# `next build` and serves HTTP, the worker imports src/lib under tsx.
#
#   docker build -t learning-app \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=… \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=… .
#   docker run --rm -p 8080:8080 --env-file <env file> learning-app
#
# Built on `output: 'standalone'` (next.config.ts): `next build` emits a
# self-contained .next/standalone with only the traced subset of node_modules,
# so the runtime stage never runs npm and carries no build toolchain.
#
# ── Prisma ───────────────────────────────────────────────────────────────────
# No engine binaries to match against the base image: Prisma 7 generates a WASM
# query compiler (node_modules/.prisma/client/query_compiler_fast_bg.wasm) and
# talks to Postgres through @prisma/adapter-pg, so the client is architecture-
# independent — musl vs debian is not a question here. The wasm is pulled into
# the standalone bundle by Next's output file tracing.
#
# ── Env contract ─────────────────────────────────────────────────────────────
# Runtime (provided by the platform; .dockerignore keeps .env* out of the build
# context) — see .env.example for the full inventory:
#
#   Required:  DATABASE_URL, GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION
#   Optional:  YOUTUBE_API_KEY, GOOGLE_VERTEX_ANTHROPIC_LOCATION,
#              GOOGLE_VERTEX_GEMINI3_LOCATION, MODEL_EMBEDDING, APP_ORIGIN
#   Vertex auth: ADC (the Cloud Run runtime service account). Leave
#              GOOGLE_APPLICATION_CREDENTIALS_JSON unset in cloud — its absence
#              is what selects the ADC path (src/lib/ai/vertex.ts).
#
# BUILD-time (not runtime): the two NEXT_PUBLIC_* values are inlined into the
# client bundle by `next build`, so they are ARGs, not runtime env — the image
# is bound to one Supabase project, and rotating the anon key means rebuilding.
# Everything else stays a runtime secret mount.
#
# DIRECT_URL is NOT needed: it is Prisma-CLI-only (migrations), and the build's
# `prisma generate` uses prisma.config.ts's placeholder fallback.

FROM node:22-slim AS deps
WORKDIR /app
# prisma/ and prisma.config.ts must precede npm ci: the postinstall hook runs
# `prisma generate`, which reads the config for the schema path.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci


FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# next-env.d.ts is deliberately absent: it is generated (and gitignored), and
# `next build` rewrites it before type-checking. COPYing it made the image build
# depend on a file that exists on a developer's disk but not in a clean
# checkout — which is exactly what a Cloud Build source upload is.
COPY package.json package-lock.json prisma.config.ts tsconfig.json next.config.ts postcss.config.mjs ./
COPY prisma ./prisma
COPY public ./public
COPY src ./src
# Not app code — `next build` type-checks the whole tsconfig `include`, which
# covers prisma/seed.ts, which imports data/seed-sources. Cheap to satisfy;
# tracing keeps it out of the standalone output.
COPY data ./data

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

# src/lib/db.ts and src/lib/ai/vertex.ts validate their env at MODULE EVAL, and
# `next build` evaluates route modules while collecting page data. These
# placeholders satisfy that check without shipping a credential — every route is
# dynamic, so nothing connects at build time and no placeholder value is baked
# into the output. (Contrast the NEXT_PUBLIC_* ARGs above, which genuinely are.)
ENV DATABASE_URL=postgresql://placeholder@localhost:5432/placeholder
ENV GOOGLE_VERTEX_PROJECT=placeholder
ENV GOOGLE_VERTEX_LOCATION=us-central1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# standalone ships its own minimal server.js plus the traced node_modules, but
# deliberately omits public/ and .next/static (Vercel serves those from a CDN).
# Cloud Run has no CDN in front of it, so copy both in — server.js picks them up
# automatically once they sit at these exact paths.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node

# Cloud Run injects PORT (8080) and routes to it; HOSTNAME must be 0.0.0.0 or
# server.js binds loopback and every health check fails.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
EXPOSE 8080

CMD ["node", "server.js"]
