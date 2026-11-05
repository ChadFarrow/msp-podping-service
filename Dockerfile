# gossip-writer signs podpings and broadcasts them on the podping iroh gossip
# network, which some indexers watch instead of Hive. Only its binary is used;
# entrypoint.sh starts it when GOSSIP_SIGNING_KEY is set. Pinned by digest.
FROM podcastindexorg/podping-gossipwriter:0.15.0@sha256:6f6fa7b11710abf82c74e746eba3d7ce3f38a28871d4df974a1419b5b978b34f AS gossip-writer

FROM brianoflondon/podping-hivepinger:1.4.1

USER root

ARG CADDY_VERSION=2.11.3
ARG CADDY_SHA256=3894577b14657feab3624d782f64175050211e52a228a6f57b4f24f4b0d970f3
ARG NODE_MAJOR=24

# Install Caddy (pinned sha256), Node.js, and libstdc++6 (gossip-writer links it;
# its ZMQ is built in, so no libzmq5)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg libstdc++6 \
    && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" -o /tmp/caddy.tgz \
    && echo "${CADDY_SHA256}  /tmp/caddy.tgz" | sha256sum -c - \
    && tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy \
    && chmod +x /usr/local/bin/caddy \
    && rm /tmp/caddy.tgz \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Build the podping consumer
COPY consumer/package.json consumer/package-lock.json /consumer/
COPY consumer/tsconfig.json /consumer/
COPY consumer/src /consumer/src/
WORKDIR /consumer
RUN npm ci --no-audit --no-fund \
    && npx tsc \
    && npm prune --omit=dev
WORKDIR /

COPY --from=gossip-writer /opt/gossip-writer/gossip-writer /usr/local/bin/gossip-writer

COPY Caddyfile.template /etc/caddy/Caddyfile.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
