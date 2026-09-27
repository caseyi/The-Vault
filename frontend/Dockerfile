# syntax=docker/dockerfile:1
#
# The Vault - frontend image (React build served by nginx, which also proxies
# /api and /images to the backend container).

# The build output is plain static files, so build on the runner's native
# platform even when producing images for other architectures.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG GIT_SHA=dev
ENV REACT_APP_GIT_SHA=${GIT_SHA} \
    GENERATE_SOURCEMAP=false
RUN npm run build

FROM nginx:1.28-alpine

ARG GIT_SHA=dev
ARG BUILD_DATE=
LABEL org.opencontainers.image.title="stlvault-frontend" \
      org.opencontainers.image.description="The Vault - self-hosted 3D print library manager (web UI)" \
      org.opencontainers.image.source="https://github.com/caseyi/The-Vault" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
