from __future__ import annotations

import json
import logging
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any

_MAX_LOG_ENTRIES = 2000
_entries: deque[dict[str, Any]] = deque(maxlen=_MAX_LOG_ENTRIES)
_guard = threading.Lock()
_logger = logging.getLogger("shopai.diagnostics")

_LEVEL_BY_NAME = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _entry_line(entry: dict[str, Any]) -> str:
    details = entry.get("details")
    details_suffix = f" | details={json.dumps(details, ensure_ascii=False, sort_keys=True)}" if details else ""
    return (
        f"{entry['timestamp']} | {entry['level'].upper()} | {entry['source']}:{entry['category']} | "
        f"{entry['message']}{details_suffix}"
    )


def append_log(
    *,
    source: str,
    category: str,
    message: str,
    details: dict[str, Any] | None = None,
    level: str = "info",
) -> dict[str, Any]:
    normalized_level = str(level or "info").lower()
    log_level = _LEVEL_BY_NAME.get(normalized_level, logging.INFO)
    entry = {
        "timestamp": _utc_iso_now(),
        "level": normalized_level,
        "source": source,
        "category": category,
        "message": message,
        "details": details or None,
    }
    entry["line"] = _entry_line(entry)
    with _guard:
        _entries.append(entry)
    _logger.log(log_level, entry["line"])
    return entry


def list_logs(limit: int = 200) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit), _MAX_LOG_ENTRIES))
    with _guard:
        return list(_entries)[-safe_limit:]


def logs_text(limit: int = 200) -> str:
    return "\n".join(entry["line"] for entry in list_logs(limit))
