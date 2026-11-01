#!/bin/sh
set -eu

DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ShopAI/data"
PID_ROOT="$DATA_ROOT/processes"
BACKEND_PYTHON="$DATA_ROOT/backend-venv/bin/python"
ORCHESTRATOR_PYTHON="$DATA_ROOT/orchestrator-venv/bin/python"

stop_service() {
    name=$1
    python_path=$2
    module=$3
    pid_file="$PID_ROOT/$name.pid"
    [ -f "$pid_file" ] || return 0
    pid=$(cat "$pid_file")
    case "$pid" in
        ''|*[!0-9]*) rm -f "$pid_file"; return 0 ;;
    esac

    if [ -r "/proc/$pid/cmdline" ]; then
        command_line=$(tr '\000' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
        case "$command_line" in
            *"$python_path"*"-m uvicorn $module"*)
                kill "$pid" 2>/dev/null || true
                ;;
        esac
    fi
    rm -f "$pid_file"
}

stop_service orchestrator "$ORCHESTRATOR_PYTHON" 'app.main:app'
stop_service backend "$BACKEND_PYTHON" 'main:app'
