from __future__ import annotations

import builtins
import logging
import runpy
from pathlib import Path
from types import SimpleNamespace

import pytest

RUNTIME_PATH = Path(__file__).resolve().parents[1] / "services" / "jupedsim_runtime.py"


@pytest.mark.parametrize(
    "error",
    [
        ModuleNotFoundError("No module named 'jupedsim'"),
        ImportError("DLL load failed while importing py_jupedsim"),
        OSError("[WinError 126] The specified module could not be found"),
    ],
)
def test_native_import_failure_is_preserved_and_logged(monkeypatch, caplog, error):
    original_import = builtins.__import__

    def failing_import(name, *args, **kwargs):
        if name == "jupedsim":
            raise error
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", failing_import)
    runtime = runpy.run_path(str(RUNTIME_PATH))
    assert runtime["jps"] is None

    with caplog.at_level(logging.ERROR), pytest.raises(RuntimeError) as caught:
        runtime["raise_jupedsim_unavailable"]()

    assert caught.value.__cause__ is error
    assert "could not be loaded" in str(caught.value)
    assert "ShopAI-Setup.exe" in str(caught.value)
    assert "Microsoft Visual C++ x64 runtime" in str(caught.value)
    assert str(error) in caplog.text
    assert "Traceback" in caplog.text


def test_successful_import_keeps_native_module(monkeypatch):
    original_import = builtins.__import__
    native_module = SimpleNamespace(Simulation=object())

    def successful_import(name, *args, **kwargs):
        if name == "jupedsim":
            return native_module
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", successful_import)
    runtime = runpy.run_path(str(RUNTIME_PATH))
    assert runtime["jps"] is native_module
    assert runtime["_import_error"] is None


@pytest.mark.parametrize("mode", ["batch", "live"])
def test_simulation_reports_native_load_failure(monkeypatch, caplog, mode):
    from models.project import SceneData, SimulationConfig
    from services import jupedsim_runtime, live_simulation, simulation

    error = ImportError("DLL load failed while importing py_jupedsim")
    monkeypatch.setattr(jupedsim_runtime, "_import_error", error)
    service = simulation if mode == "batch" else live_simulation
    monkeypatch.setattr(service, "jps", None)
    scene = SceneData.model_validate({
        "store": {
            "id": "test",
            "name": "Test",
            "dimensions": {"width": 1000, "depth": 1000, "height": 300},
        },
    })

    with caplog.at_level(logging.ERROR), pytest.raises(RuntimeError) as caught:
        if mode == "batch":
            simulation.run_flow_simulation(scene, SimulationConfig())
        else:
            live_simulation.LiveSimulationSession("test", scene, SimulationConfig())

    assert caught.value.__cause__ is error
    assert "Microsoft Visual C++ x64 runtime" in str(caught.value)
    assert str(error) in caplog.text
