#!/bin/sh
set -e

# Diagnostic: log which of our expected env vars are present (not values — just names + lengths)
echo "--- entrypoint env check ---"
for var in PORT PODPING_SHARED_SECRET HIVE_ACCOUNT_NAME HIVE_POSTING_KEY; do
    eval "val=\$$var"
    if [ -n "$val" ]; then
        len=${#val}
        echo "$var: set (len=$len)"
    else
        echo "$var: UNSET or empty"
    fi
done
echo "--- end env check ---"

: "${PORT:=8080}"
: "${PODPING_SHARED_SECRET:?PODPING_SHARED_SECRET is required}"

sed \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__PODPING_SHARED_SECRET__|${PODPING_SHARED_SECRET}|g" \
    /etc/caddy/Caddyfile.template > /etc/caddy/Caddyfile

cd /hivepinger
python -m hivepinger.api serve --host 127.0.0.1 --port 8000 &

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
