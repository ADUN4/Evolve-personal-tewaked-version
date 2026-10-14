# Global ARGs
# node:16.20 was not viable: esbuild 0.25 (pinned in package.json) requires Node >= 18.
# node:20-slim is Debian/glibc, so the prebuilt esbuild binary works without extra setup.
ARG BUILDER_IMAGE=node:20-slim
ARG NGINX_IMAGE=nginx:1.26.1-alpine
ARG WORKSPACE=/workspace
ARG WEB_PATH=/usr/share/nginx/html

# Builder
FROM $BUILDER_IMAGE as builder
ARG WORKSPACE

WORKDIR $WORKSPACE
COPY ./ $WORKSPACE/
# .dockerignore keeps the host node_modules/ and dist/ out of the build context.
# npm ci needs package-lock.json to be in sync with package.json.
RUN npm ci --no-audit --no-fund \
    && node deploy/make-dist.mjs

# Web server
FROM $NGINX_IMAGE
ARG WORKSPACE
ARG WEB_PATH

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder $WORKSPACE/dist $WEB_PATH
