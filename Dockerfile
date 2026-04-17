FROM brianoflondon/podping-hivepinger:1.4.1

USER root

# Install Caddy v2 binary (matches caddy:2-alpine stability, minus Alpine)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz" \
        | tar -xz -C /usr/local/bin caddy \
    && chmod +x /usr/local/bin/caddy \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY Caddyfile.template /etc/caddy/Caddyfile.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
