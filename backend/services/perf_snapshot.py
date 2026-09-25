from __future__ import annotations

import os
import resource
from typing import Any


def _read_fd_count() -> int | None:
    try:
        return len(os.listdir("/proc/self/fd"))
    except OSError:
        return None


def _read_load_avg() -> tuple[float, float, float] | None:
    try:
        return os.getloadavg()
    except OSError:
        return None


def capture_process_snapshot() -> dict[str, Any]:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    load_avg = _read_load_avg()
    return {
        "cpuUserMs": round(usage.ru_utime * 1000.0, 2),
        "cpuSystemMs": round(usage.ru_stime * 1000.0, 2),
        "maxRssMb": round(float(usage.ru_maxrss) / 1024.0, 2),
        "voluntaryContextSwitches": usage.ru_nvcsw,
        "involuntaryContextSwitches": usage.ru_nivcsw,
        "openFileDescriptors": _read_fd_count(),
        "loadAvg1m": round(load_avg[0], 3) if load_avg else None,
        "loadAvg5m": round(load_avg[1], 3) if load_avg else None,
        "loadAvg15m": round(load_avg[2], 3) if load_avg else None,
    }
