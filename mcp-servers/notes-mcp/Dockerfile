# Node 22 for the built-in node:sqlite module (no native addon, no build toolchain).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# node:sqlite prints an ExperimentalWarning on start; it's expected (DESIGN §4.1), not an error.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Numeric uid for runAsNonRoot. Only /data (the PVC) is written.
USER 10001
EXPOSE 3000
CMD ["node", "dist/server.js"]
