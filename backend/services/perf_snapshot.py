from __future__ import annotations

import os
import sys
from typing import Any

try:
    import resource as _resource
except ImportError:  # pragma: no cover - depends on runtime platform
    _resource = None


def _read_fd_count() -> int | None:
    try:
        return len(os.listdir("/proc/self/fd"))
    except OSError:
        return None


def _read_load_avg() -> tuple[float, float, float] | None:
    try:
        return os.getloadavg()
    except (AttributeError, OSError):
        return None


def _rss_mb_from_ru_maxrss(ru_maxrss: float) -> float:
    if sys.platform == "darwin":
        return float(ru_maxrss) / (1024.0 * 1024.0)
    return float(ru_maxrss) / 1024.0


def _snapshot_from_resource() -> dict[str, Any] | None:
    if _resource is None:
        return None

    usage = _resource.getrusage(_resource.RUSAGE_SELF)
    return {
        "cpuUserMs": round(usage.ru_utime * 1000.0, 2),
        "cpuSystemMs": round(usage.ru_stime * 1000.0, 2),
        "maxRssMb": round(_rss_mb_from_ru_maxrss(usage.ru_maxrss), 2),
        "voluntaryContextSwitches": usage.ru_nvcsw,
        "involuntaryContextSwitches": usage.ru_nivcsw,
    }


def _snapshot_from_os_times() -> dict[str, Any]:
    times = os.times()
    return {
        "cpuUserMs": round(float(times.user) * 1000.0, 2),
        "cpuSystemMs": round(float(times.system) * 1000.0, 2),
        "maxRssMb": None,
        "voluntaryContextSwitches": None,
        "involuntaryContextSwitches": None,
    }


def capture_process_snapshot() -> dict[str, Any]:
    base_snapshot = _snapshot_from_resource() or _snapshot_from_os_times()
    load_avg = _read_load_avg()
    return {
        **base_snapshot,
        "openFileDescriptors": _read_fd_count(),
        "loadAvg1m": round(load_avg[0], 3) if load_avg else None,
        "loadAvg5m": round(load_avg[1], 3) if load_avg else None,
        "loadAvg15m": round(load_avg[2], 3) if load_avg else None,
    }
