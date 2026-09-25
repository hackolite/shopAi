from __future__ import annotations

from types import SimpleNamespace

import services.perf_snapshot as perf_snapshot


def test_capture_process_snapshot_without_resource(monkeypatch):
    monkeypatch.setattr(perf_snapshot, "_resource", None)
    monkeypatch.setattr(
        perf_snapshot.os,
        "times",
        lambda: SimpleNamespace(user=1.25, system=0.75),
    )

    snapshot = perf_snapshot.capture_process_snapshot()

    assert snapshot["cpuUserMs"] == 1250.0
    assert snapshot["cpuSystemMs"] == 750.0
    assert snapshot["maxRssMb"] is None
    assert snapshot["voluntaryContextSwitches"] is None
    assert snapshot["involuntaryContextSwitches"] is None
    assert set(snapshot) == {
        "cpuUserMs",
        "cpuSystemMs",
        "maxRssMb",
        "voluntaryContextSwitches",
        "involuntaryContextSwitches",
        "openFileDescriptors",
        "loadAvg1m",
        "loadAvg5m",
        "loadAvg15m",
    }


def test_rss_conversion_is_platform_consistent(monkeypatch):
    monkeypatch.setattr(perf_snapshot.sys, "platform", "darwin")
    assert perf_snapshot._rss_mb_from_ru_maxrss(4 * 1024 * 1024) == 4.0

    monkeypatch.setattr(perf_snapshot.sys, "platform", "linux")
    assert perf_snapshot._rss_mb_from_ru_maxrss(4096) == 4.0
