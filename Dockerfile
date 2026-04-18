FROM brianoflondon/podping-hivepinger:1.4.1

USER root

ARG CADDY_VERSION=2.8.4
ARG CADDY_SHA256=a7e8306c54138cf88e371c5ec0caf7baf142ecc1d60a30897dfb67d65d3748c8
ARG NODE_MAJOR=20

# Install Caddy (pinned sha256) and Node.js
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
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

COPY Caddyfile.template /etc/caddy/Caddyfile.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
