# Build stage: dev dependencies (TypeScript) never reach the runtime image.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and compiled JS only.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Numeric uid so Kubernetes can verify runAsNonRoot. Files stay root-owned: the app only reads them.
USER 10001
EXPOSE 3000
CMD ["node", "dist/server.js"]
