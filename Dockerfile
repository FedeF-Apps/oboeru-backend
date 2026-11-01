# ============================================================================
# Etapa 1: Instalación de dependencias y compilación TypeScript
# ============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies para llevar solo paquetes de producción al runtime
RUN npm prune --omit=dev

# ============================================================================
# Etapa 2: Imagen de producción ligera y segura
# Nota: Siguiendo KAMAL_GUIDELINES.md §5.3, NO se declaran ARG/ENV con nombres
# de secretos (DATABASE_URL, AUTH_SECRET) para evitar SecretsUsedInArgOrEnv.
# ============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Usuario sin privilegios de root
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 oboeru

COPY --from=builder --chown=oboeru:nodejs /app/package.json ./package.json
COPY --from=builder --chown=oboeru:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=oboeru:nodejs /app/dist ./dist
COPY --chown=oboeru:nodejs migrations ./migrations
COPY --chown=oboeru:nodejs data ./data

USER oboeru

EXPOSE 3000

CMD ["node", "dist/index.js"]
