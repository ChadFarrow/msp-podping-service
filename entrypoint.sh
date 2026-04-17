#!/bin/sh
set -e

# Render Caddyfile from template with env var substitution.
# Using sed with literal placeholders so the secret can contain any
# character except the sed delimiter (| here). openssl rand -hex output
# is [0-9a-f] only, so | is safe.
: "${PORT:=8080}"
: "${PODPING_SHARED_SECRET:?PODPING_SHARED_SECRET is required}"

sed \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__PODPING_SHARED_SECRET__|${PODPING_SHARED_SECRET}|g" \
    /etc/caddy/Caddyfile.template > /etc/caddy/Caddyfile

# Start hivepinger on localhost only; Caddy is the only public-facing process.
cd /hivepinger
python -m hivepinger.api serve --host 127.0.0.1 --port 8000 &

# Launch Caddy in foreground; config is now fully materialized.
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
