FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Unprivileged nginx: runs as uid 101 and listens on 8080, so the pod needs no root and no
# NET_BIND_SERVICE. The chart mounts its own server config (with the /api proxy) over conf.d.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
