#!/bin/sh
set -e

# Start hivepinger on localhost only; Caddy is the only public-facing process.
cd /hivepinger
python -m hivepinger.api serve --host 127.0.0.1 --port 8000 &

# Launch Caddy in foreground; Railway injects $PORT.
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
