from __future__ import annotations

import tempfile
from pathlib import Path
from time import time
from uuid import uuid4

import services.project_manager as pm

_tmp_storage = tempfile.mkdtemp(prefix="shopai_live_sensor_test_")
pm.STORAGE_ROOT = Path(_tmp_storage)

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app, raise_server_exceptions=True)


def _register() -> None:
    response = client.post(
        "/api/platform/auth/register",
        json={
            "name": "Live Sensor",
            "email": f"{uuid4().hex}@example.com",
            "password": "live-sensor-test-password",
        },
    )
    assert response.status_code == 200, response.text


def _create_project() -> str:
    response = client.post("/api/cad/projects", json={"name": f"Live {uuid4().hex}"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


_register()


def test_live_sensor_ingest_snapshot_and_stats():
    project_id = _create_project()
    settings = client.put(
        f"/api/cad/projects/{project_id}/settings",
        json={"live": {"bufferSeconds": 120}},
    )
    assert settings.status_code == 200, settings.text

    response = client.post(
        f"/api/cad/projects/{project_id}/live/ingest",
        json={
            "samples": [
                {
                    "sourceId": "sensor-a",
                    "sourceLabel": "Sensor A",
                    "coordinate": {"kind": "normalized", "x": 10, "y": 20},
                    "data": [{"name": "temperature", "value": 18.5, "unit": "°C"}],
                },
                {
                    "sourceId": "sensor-b",
                    "coordinate": {"kind": "gps", "lat": 48.9, "lon": 2.3},
                    "data": [{"name": "temperature", "value": 24.5, "unit": "°C"}],
                },
            ]
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["inserted"] == 2
    assert payload["snapshot"]["sampleCount"] == 2

    snapshot = client.get(f"/api/cad/projects/{project_id}/live/snapshot")
    assert snapshot.status_code == 200, snapshot.text
    body = snapshot.json()
    assert body["retentionSeconds"] == 120
    assert body["sources"] == ["sensor-a", "sensor-b"]
    assert body["sourceLabels"]["sensor-a"] == "Sensor A"
    assert sorted(body["coordinateKinds"]) == ["gps", "normalized"]
    assert body["normalizedBounds"] == {"minX": 10.0, "maxX": 10.0, "minY": 20.0, "maxY": 20.0}
    assert body["gpsBounds"] == {"minLat": 48.9, "maxLat": 48.9, "minLon": 2.3, "maxLon": 2.3}
    assert body["metrics"] == [{
        "name": "temperature",
        "min": 18.5,
        "max": 24.5,
        "unit": "°C",
        "count": 2,
    }]


def test_live_sensor_snapshot_purges_expired_samples():
    project_id = _create_project()
    client.put(
        f"/api/cad/projects/{project_id}/settings",
        json={"live": {"bufferSeconds": 10}},
    )
    now_ms = int(time() * 1000)
    response = client.post(
        f"/api/cad/projects/{project_id}/live/ingest",
        json={
            "samples": [
                {
                    "sourceId": "old",
                    "timestampMs": now_ms - 30_000,
                    "coordinate": {"kind": "normalized", "x": 5, "y": 5},
                    "data": [{"name": "affluence", "value": 1}],
                },
                {
                    "sourceId": "fresh",
                    "timestampMs": now_ms,
                    "coordinate": {"kind": "normalized", "x": 10, "y": 10},
                    "data": [{"name": "affluence", "value": 9}],
                },
            ]
        },
    )
    assert response.status_code == 200, response.text

    snapshot = client.get(f"/api/cad/projects/{project_id}/live/snapshot")
    assert snapshot.status_code == 200, snapshot.text
    body = snapshot.json()
    assert body["sampleCount"] == 1
    assert [sample["sourceId"] for sample in body["samples"]] == ["fresh"]


def test_live_sensor_websocket_pushes_updated_snapshot():
    project_id = _create_project()

    with client.websocket_connect(f"/api/cad/projects/{project_id}/live/ws") as websocket:
        initial = websocket.receive_json()
        assert initial["type"] == "snapshot"
        assert initial["payload"]["sampleCount"] == 0

        response = client.post(
            f"/api/cad/projects/{project_id}/live/ingest",
            json={
                "samples": [
                    {
                        "sourceId": "ws-1",
                        "coordinate": {"kind": "normalized", "x": 55, "y": 45},
                        "data": [{"name": "decibel", "value": 62}],
                    }
                ]
            },
        )
        assert response.status_code == 200, response.text

        update = websocket.receive_json()
        assert update["type"] == "snapshot"
        assert update["reason"] == "ingest"
        assert update["payload"]["sampleCount"] == 1
        sample = update["payload"]["samples"][0]
        assert sample["sourceId"] == "ws-1"
        assert sample["coordinate"]["kind"] == "normalized"
        assert sample["coordinate"]["x"] == 55.0
        assert sample["coordinate"]["y"] == 45.0
        assert isinstance(sample["timestampMs"], int)
        assert sample["data"] == [{"name": "decibel", "value": 62.0, "unit": None}]
