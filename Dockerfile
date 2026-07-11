# --- Build stage ---
FROM node:22-slim AS builder
WORKDIR /app

# Install all deps (incl. dev) for the TypeScript build.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies only.
RUN npm prune --omit=dev

# --- Runtime stage ---
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Non-root for safety.
USER node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node package.json ./

# Railway injects PORT; the app reads it via config.
EXPOSE 3000
CMD ["node", "dist/index.js"]
