#!/bin/bash
set -e

# Diagnostic: log which of our expected env vars are present (names + lengths only, no values)
echo "--- entrypoint env check ---"
for var in PORT PODPING_SHARED_SECRET HIVE_ACCOUNT_NAME HIVE_POSTING_KEY STABLEKRAFT_BASE_URL CONSUMER_ENABLED; do
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

# Supervise three child processes. Any exit (any reason) kills the others and
# propagates the exit code so Railway's container supervisor restarts us.
trap 'kill 0' EXIT INT TERM

# hivepinger — Python, bound to 127.0.0.1:8000, never public
(cd /hivepinger && python -m hivepinger.api --host 127.0.0.1 --port 8000) &

# podping consumer — Node, tails Hive and forwards music podpings to stablekraft-app
node /consumer/dist/index.js &

# Caddy — public, terminates bearer auth, reverse-proxies to hivepinger
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

# `wait -n` returns as soon as any child exits.
wait -n
exit $?
