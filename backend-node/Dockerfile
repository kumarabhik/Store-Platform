FROM node:20-alpine

WORKDIR /app

# Build deps for better-sqlite3 (node-gyp)
RUN apk add --no-cache python3 make g++ 

COPY package.json package-lock.json* ./
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm ci


COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Create non-root user with NUMERIC uid/gid for Kubernetes runAsNonRoot verification
RUN addgroup -g 10001 -S app \
  && adduser  -u 10001 -S app -G app \
  && mkdir -p /data \
  && chown -R 10001:10001 /app /data

USER 10001

EXPOSE 8000
CMD ["node", "dist/server.js"]
