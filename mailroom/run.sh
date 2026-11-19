#!/usr/bin/env bash
set -euo pipefail
umask 077

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
bus="$root/mailroom/bus"
python=${PYTHON:-python3}
export BUS_DASHBOARD_DIR="${BUS_DASHBOARD_DIR:-$root/mailroom/web/out}"

case "${1:-}" in
  init)
    # Resolve the same store that the command-line and server use.
    store=$("$python" -c 'import sys; sys.path.insert(0, sys.argv[1]); from coord_store import resolve_store; print(resolve_store()[0])' "$bus")
    mkdir -p -- "$store/"{bus,attachments,todo,status}
    "$python" "$bus/bus.py" todo seed
    ;;
  build)
    cd "$root/mailroom/web"
    npm ci
    npm run build
    ;;
  serve)
    shift
    if [[ ! -s "$BUS_DASHBOARD_DIR/index.html" ]]; then
      echo "Missing UI export in $BUS_DASHBOARD_DIR. Run ./mailroom/run.sh build." >&2
      exit 1
    fi
    exec "$python" "$bus/bus.py" serve "$@"
    ;;
  *)
    echo "Usage: $0 init | build | serve [--port 8766] [--admin-port 8768]" >&2
    exit 2
    ;;
esac
