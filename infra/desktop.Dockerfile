FROM node:24-bookworm-slim AS node
FROM rust:1-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && rustup component add rustfmt \
 && apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf xvfb xauth \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/apps/web
