#!/bin/sh
set -eu

APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ShopAI/data"
LOG_ROOT="$DATA_ROOT/logs"
PID_ROOT="$DATA_ROOT/processes"
BACKEND_PYTHON="$DATA_ROOT/backend-venv/bin/python"
ORCHESTRATOR_PYTHON="$DATA_ROOT/orchestrator-venv/bin/python"
BACKEND_URL="http://127.0.0.1:8000/"
ORCHESTRATOR_URL="http://127.0.0.1:8010/"

if [ ! -x "$BACKEND_PYTHON" ] || [ ! -x "$ORCHESTRATOR_PYTHON" ]; then
    printf '%s\n' "ShopAI's Python environments are missing. Run the ShopAI-Setup.run installer again." >&2
    exit 1
fi

mkdir -p "$LOG_ROOT" "$PID_ROOT" "$DATA_ROOT/projects"
export SHOPAI_STORAGE_ROOT="$DATA_ROOT/projects"
export SHOPAI_LOG_DIR="$LOG_ROOT"
export PYTHONUTF8=1
export STUDIO_LLM_WEBHOOK_URL="${STUDIO_LLM_WEBHOOK_URL:-http://127.0.0.1:8010/webhook/llm}"
export BACKEND_BASE_URL="${BACKEND_BASE_URL:-http://127.0.0.1:8000}"

http_ready() {
    "$BACKEND_PYTHON" -c '
import sys
import urllib.request
try:
    body = urllib.request.urlopen(sys.argv[1], timeout=2).read().decode()
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if sys.argv[2] in body else 1)
' "$1" "$2" >/dev/null 2>&1
}

wait_for_service() {
    url=$1
    marker=$2
    name=$3
    pid_file=$4
    attempt=0
    while [ "$attempt" -lt 60 ]; do
        if http_ready "$url" "$marker"; then
            return 0
        fi
        if [ -f "$pid_file" ] && ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
            break
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    printf 'ShopAI %s failed to start. Check %s/%s-stderr.log\n' "$name" "$LOG_ROOT" "$name" >&2
    return 1
}

if ! http_ready "$BACKEND_URL" '<div id="root">'; then
    (
        cd "$APP_ROOT/backend"
        nohup "$BACKEND_PYTHON" -m uvicorn main:app --host 127.0.0.1 --port 8000 \
            >>"$LOG_ROOT/backend-stderr.log" 2>&1 </dev/null &
        printf '%s\n' "$!" >"$PID_ROOT/backend.pid"
    )
    wait_for_service "$BACKEND_URL" '<div id="root">' backend "$PID_ROOT/backend.pid"
fi

if ! http_ready "$ORCHESTRATOR_URL" 'shopai-orchestrator'; then
    (
        cd "$APP_ROOT/orchestrator"
        nohup "$ORCHESTRATOR_PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8010 \
            >>"$LOG_ROOT/orchestrator-stderr.log" 2>&1 </dev/null &
        printf '%s\n' "$!" >"$PID_ROOT/orchestrator.pid"
    )
    wait_for_service "$ORCHESTRATOR_URL" 'shopai-orchestrator' orchestrator "$PID_ROOT/orchestrator.pid"
fi

if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$BACKEND_URL" >/dev/null 2>&1 || printf 'Open ShopAI at %s\n' "$BACKEND_URL"
else
    printf 'Open ShopAI at %s\n' "$BACKEND_URL"
fi
