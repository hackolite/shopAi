#!/bin/sh
set -eu

if [ -z "${HOME:-}" ]; then
    printf '%s\n' 'ShopAI cannot determine your home directory.' >&2
    exit 1
fi

PAYLOAD_LINE=$(awk '$0 == "__SHOPAI_PAYLOAD_BELOW__" { print NR + 1; exit }' "$0")
if [ -z "$PAYLOAD_LINE" ]; then
    printf '%s\n' 'This ShopAI installer is incomplete: its application payload is missing.' >&2
    exit 1
fi

PAYLOAD_DIR=$(mktemp -d)
trap 'rm -rf "$PAYLOAD_DIR"' 0
trap 'exit 1' HUP INT TERM
tail -n +"$PAYLOAD_LINE" "$0" | tar -xz -C "$PAYLOAD_DIR"

APP_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ShopAI"
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ShopAI/data"
BIN_ROOT="${HOME}/.local/bin"
DESKTOP_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'Python 3.11 or newer is required. Install Python 3 and its venv package, then run this installer again.' >&2
    exit 1
fi

if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
    printf '%s\n' 'Python 3.11 or newer is required. Install a supported Python version, then run this installer again.' >&2
    exit 1
fi

if [ -x "$APP_ROOT/scripts/stop-shopai.sh" ]; then
    "$APP_ROOT/scripts/stop-shopai.sh"
fi

mkdir -p "$APP_ROOT" "$DATA_ROOT/logs" "$BIN_ROOT" "$DESKTOP_ROOT"
cp -a "$PAYLOAD_DIR/." "$APP_ROOT/"

if ! python3 -m venv "$DATA_ROOT/backend-venv"; then
    printf '%s\n' 'Could not create the backend Python environment. Install your distribution’s Python venv package (for example, python3-venv) and try again.' >&2
    exit 1
fi
if ! python3 -m venv "$DATA_ROOT/orchestrator-venv"; then
    printf '%s\n' 'Could not create the orchestrator Python environment. Install your distribution’s Python venv package (for example, python3-venv) and try again.' >&2
    exit 1
fi

if ! "$DATA_ROOT/backend-venv/bin/python" -m pip install --disable-pip-version-check -r "$APP_ROOT/backend/requirements.txt" >"$DATA_ROOT/logs/install-backend.log" 2>&1; then
    tail -n 40 "$DATA_ROOT/logs/install-backend.log" >&2
    printf '%s\n' "Could not install backend dependencies. Check your internet connection and retry. Details: $DATA_ROOT/logs/install-backend.log" >&2
    exit 1
fi
if ! "$DATA_ROOT/orchestrator-venv/bin/python" -m pip install --disable-pip-version-check -r "$APP_ROOT/orchestrator/requirements.txt" >>"$DATA_ROOT/logs/install-backend.log" 2>&1; then
    tail -n 40 "$DATA_ROOT/logs/install-backend.log" >&2
    printf '%s\n' "Could not install orchestrator dependencies. Check your internet connection and retry. Details: $DATA_ROOT/logs/install-backend.log" >&2
    exit 1
fi

ln -sf "$APP_ROOT/scripts/launch-shopai.sh" "$BIN_ROOT/shopai"
ln -sf "$APP_ROOT/scripts/stop-shopai.sh" "$BIN_ROOT/shopai-stop"
SHOPAI_LAUNCHER="$APP_ROOT/scripts/launch-shopai.sh" \
    SHOPAI_DESKTOP_FILE="$DESKTOP_ROOT/shopai.desktop" \
    python3 - <<'PY'
import os


def desktop_quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


launcher = os.environ["SHOPAI_LAUNCHER"]
desktop_file = os.environ["SHOPAI_DESKTOP_FILE"]
with open(desktop_file, "w", encoding="utf-8") as entry:
    entry.write(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=ShopAI\n"
        "Comment=Retail store design and simulation\n"
        f"Exec={desktop_quote(launcher)}\n"
        "Terminal=false\n"
        "Categories=Office;\n"
    )
PY

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_ROOT" >/dev/null 2>&1 || true
fi

printf 'ShopAI was installed in %s\n' "$APP_ROOT"
printf 'Launch it from your applications menu or run: %s/shopai\n' "$BIN_ROOT"
"$APP_ROOT/scripts/launch-shopai.sh"

exit 0

__SHOPAI_PAYLOAD_BELOW__
