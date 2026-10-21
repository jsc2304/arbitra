# ---- Build stage ----
FROM node:24-alpine AS builder

WORKDIR /app

# Firebase client config (baked into client JS at build time)
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
# Google Workspace domain lock (#1062) — baked into the client bundle so the
# sign-in popup's `hd` parameter reflects it; omitted (empty string) is
# treated as unset by firebase-client.ts.
ARG NEXT_PUBLIC_AUTH_HOSTED_DOMAIN
# Optional env badge label next to the logo (`prod` or `dev`).
ARG NEXT_PUBLIC_ARBITRA_ENV
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY
ENV NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID
ENV NEXT_PUBLIC_AUTH_HOSTED_DOMAIN=$NEXT_PUBLIC_AUTH_HOSTED_DOMAIN
ENV NEXT_PUBLIC_ARBITRA_ENV=$NEXT_PUBLIC_ARBITRA_ENV

# Install dependencies
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

RUN npm ci

# Copy source
COPY packages/shared packages/shared
COPY packages/backend packages/backend
COPY packages/frontend packages/frontend

# Helper-bot docs corpus — read at runtime by
# packages/backend/src/services/helper-bot/corpus-loader.ts
COPY docs ./docs

# IDE setup assets served by /api/init/*
COPY templates ./templates

# Build all packages (shared → backend → frontend)
RUN npm run build

# ---- Production stage ----
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# Next.js standalone output includes all dependencies
COPY --from=builder /app/packages/frontend/.next/standalone ./
COPY --from=builder /app/packages/frontend/.next/static ./packages/frontend/.next/static
# Copy public dir if it exists (optional static assets)
RUN mkdir -p /app/packages/frontend/public
COPY --from=builder /app/packages/frontend/public* ./packages/frontend/public/

# Helper-bot docs corpus — read at runtime by
# packages/backend/src/services/helper-bot/corpus-loader.ts
COPY --from=builder /app/docs ./docs

# IDE setup assets (served by /api/init/*)
COPY --from=builder /app/templates ./templates

EXPOSE 8080

CMD ["node", "packages/frontend/server.js"]
