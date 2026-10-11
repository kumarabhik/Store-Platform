# The official MCP reference server, unmodified, pinned by package-lock.json. Installed at build
# time so the pod never downloads code at start (no `npx -y` in production).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
USER 10001
EXPOSE 3001
# Streamable HTTP transport on $PORT (default 3001), path /mcp.
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
