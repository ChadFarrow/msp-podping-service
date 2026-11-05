#!/bin/bash
set -e

# Diagnostic: log which of our expected env vars are present (names + lengths only, no values)
echo "--- entrypoint env check ---"
for var in PORT PODPING_SHARED_SECRET HIVE_ACCOUNT_NAME HIVE_POSTING_KEY STABLEKRAFT_BASE_URL CONSUMER_ENABLED GOSSIP_SIGNING_KEY GOSSIP_ENABLED; do
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

# Supervise the child processes. Any exit (any reason) kills the others and
# propagates the exit code so Railway's container supervisor restarts us.
trap 'kill 0' EXIT INT TERM

# gossip-writer — optional. hivepinger writes podpings to Hive only, and the
# podping gossip network (which musicindex.org and other indexers watch) never
# sees them. With a key set, hivepinger also forwards each podping it wrote to
# Hive over ZMQ to this writer, which signs it and broadcasts it on gossip.
# Watchers accept only signers in their trusted-publishers list, so the key must
# never change: it comes from a Railway secret, not a file in the container.
# Every failure here turns gossip off; none of it may stop the pusher.
GOSSIP_DIR=/data/gossip
GOSSIP_ZMQ=tcp://127.0.0.1:9998
export GOSSIP_WRITER_ENABLED=false
if [ "${GOSSIP_ENABLED:-true}" = "false" ]; then
    echo "[gossip] disabled: GOSSIP_ENABLED=false"
elif [ -z "${GOSSIP_SIGNING_KEY:-}" ]; then
    echo "[gossip] disabled: GOSSIP_SIGNING_KEY unset"
elif [[ ! "$GOSSIP_SIGNING_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "[gossip] disabled: GOSSIP_SIGNING_KEY is not 64 hex characters (make one with: openssl rand -hex 32)"
elif ! mkdir -p "$GOSSIP_DIR" \
    || ! (umask 077 && printf '%s' "$GOSSIP_SIGNING_KEY" \
        | python3 -c 'import sys; sys.stdout.buffer.write(bytes.fromhex(sys.stdin.read()))' \
        > "$GOSSIP_DIR/iroh.key"); then
    echo "[gossip] disabled: could not write $GOSSIP_DIR/iroh.key"
else
    export GOSSIP_WRITER_ENABLED=true
    export GOSSIP_WRITER_ZMQ="$GOSSIP_ZMQ"
    (
        # A crash restarts the writer alone. `set -e` from above would let one
        # failed run end this loop, and `wait -n` would then stop the container.
        set +e
        export ZMQ_BIND_ADDR="$GOSSIP_ZMQ"
        export IROH_SECRET_FILE="$GOSSIP_DIR/iroh.key"
        export IROH_NODE_KEY_FILE="$GOSSIP_DIR/iroh_node.key"
        export KNOWN_PEERS_FILE="$GOSSIP_DIR/known_peers.txt"
        export TRUSTED_PUBLISHERS_FILE="$GOSSIP_DIR/trusted_publishers.txt"
        export TRUSTED_MONITORS_FILE="$GOSSIP_DIR/trusted_monitors.txt"
        export NODE_FRIENDLY_NAME="${GOSSIP_FRIENDLY_NAME:-MSP2.0-podping}"
        while true; do
            gossip-writer
            echo "[gossip] gossip-writer exited with code $?; restarting in 10s"
            sleep 10
        done
    ) &
    echo "[gossip] enabled: gossip-writer on $GOSSIP_ZMQ"
fi

# hivepinger — Python, bound to 127.0.0.1:8000, never public
(cd /hivepinger && python -m hivepinger.api --host 127.0.0.1 --port 8000) &

# podping consumer — Node, tails Hive and forwards music podpings to stablekraft-app
node /consumer/dist/index.js &

# Caddy — public, terminates bearer auth, reverse-proxies to hivepinger
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

# `wait -n` returns as soon as any child exits.
wait -n
exit $?
