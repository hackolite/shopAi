from __future__ import annotations

import random

from models.project import (
    FurnitureInstance,
    PedestrianRecord,
    Planogram,
    PlanogramCell,
)
from services.pedestrian_import import parse_pedestrian_csv
from services.pickup_planning import (
    build_pedestrian_plan,
    resolve_ean_position,
)


def _furniture(**overrides) -> FurnitureInstance:
    base = dict(
        id="fx-1",
        name="Gondole",
        type="gondola",
        libraryId="lib-gondola",
        position=[100.0, 0.0, 200.0],
        rotation=[0.0, 0.0, 0.0],
        dimensions={"width": 100.0, "depth": 40.0, "height": 180.0},
    )
    base.update(overrides)
    return FurnitureInstance.model_validate(base)


def _planogram(face: str = "front", **overrides) -> Planogram:
    base = dict(
        id="pg-1",
        name="Face avant",
        furnitureId="fx-1",
        face=face,
        rows=1,
        cols=2,
        widthCm=100.0,
        heightCm=180.0,
        cells=[
            PlanogramCell(id="c0", ean="EAN0", row=0, col=0),
            PlanogramCell(id="c1", ean="EAN1", row=0, col=1),
        ],
    )
    base.update(overrides)
    return Planogram.model_validate(base)


class TestParsePedestrianCsv:
    def test_aggregates_rows_by_pedestrian(self) -> None:
        csv_text = (
            "pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n"
            "1,1000,1.2,\"{\"\"type\"\": \"\"leisure\"\"}\",EAN0\n"
            "1,1000,1.2,\"{\"\"type\"\": \"\"leisure\"\"}\",EAN1\n"
            "2,1010,0.9,,\n"
        )
        records, anomalies = parse_pedestrian_csv(csv_text)
        assert anomalies == []
        assert set(records.keys()) == {1, 2}
        assert records[1].wantedProducts == ["EAN0", "EAN1"]
        assert records[1].profile == {"type": "leisure"}
        assert records[2].wantedProducts == []
        assert records[2].speedMps == 0.9

    def test_rejects_out_of_range_speed(self) -> None:
        csv_text = "pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n1,1000,25.0,,EAN0\n"
        records, anomalies = parse_pedestrian_csv(csv_text)
        assert records == {}
        assert len(anomalies) == 1
        assert "out of realistic range" in anomalies[0].reason

    def test_invalid_profile_json_falls_back_to_empty_dict(self) -> None:
        csv_text = "pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n1,1000,1.0,not-json,EAN0\n"
        records, anomalies = parse_pedestrian_csv(csv_text)
        assert records[1].profile == {}
        assert any("Invalid profile_json" in anomaly.reason for anomaly in anomalies)

    def test_missing_required_column_reports_anomaly(self) -> None:
        csv_text = "pedestrian_id,speed_mps\n1,1.0\n"
        records, anomalies = parse_pedestrian_csv(csv_text)
        assert records == {}
        assert len(anomalies) == 1
        assert "Missing required column" in anomalies[0].reason


class TestResolveEanPosition:
    def test_resolves_front_face_cell_to_world_position(self) -> None:
        furniture = _furniture()
        planogram = _planogram(face="front")
        position = resolve_ean_position("EAN0", [planogram], {"fx-1": furniture})
        assert position is not None
        x_cm, z_cm = position
        # Front face aisle is z in [center_z, center_z + depth/2]; column 0 is the
        # left half of the width.
        assert 100.0 <= x_cm <= 150.0
        assert 220.0 <= z_cm <= 220.0 + 20.0

    def test_returns_none_when_ean_not_in_any_planogram(self) -> None:
        furniture = _furniture()
        planogram = _planogram(face="front")
        assert resolve_ean_position("UNKNOWN", [planogram], {"fx-1": furniture}) is None

    def test_rotated_furniture_still_resolves(self) -> None:
        furniture = _furniture(rotation=[0.0, 90.0, 0.0])
        planogram = _planogram(face="front")
        position = resolve_ean_position("EAN0", [planogram], {"fx-1": furniture})
        assert position is not None


class TestBuildPedestrianPlan:
    def test_marks_missing_ean_as_not_found(self) -> None:
        from models.project import Catalog, Product, SceneData, Store

        scene = SceneData(
            store=Store(id="s", name="s", dimensions={"width": 1000.0, "depth": 1000.0, "height": 300.0}),
            furniture=[_furniture()],
        )
        catalog = Catalog(products=[Product(ean="EAN0", name="Eau", brand="X", category="c", widthCm=1, depthCm=1, heightCm=1, weightG=1)])
        planograms = [_planogram(face="front")]
        record = PedestrianRecord(pedestrianId=1, startUnixTs=1000, speedMps=1.2, wantedProducts=["EAN0", "MISSING"])

        plan = build_pedestrian_plan(record, scene, planograms, catalog, rng=random.Random(0))

        found = {item.ean: item for item in plan.items}
        assert found["EAN0"].found is True
        assert found["EAN0"].xCm is not None
        assert 1.0 <= found["EAN0"].pickupDurationSeconds <= 4.0
        assert found["MISSING"].found is False
        assert found["MISSING"].reasonNotFound


class TestImportPedestriansEndpoint:
    def test_import_endpoint_builds_plans_and_reports_anomalies(self) -> None:
        import io
        import tempfile
        from pathlib import Path

        import services.project_manager as pm

        pm.STORAGE_ROOT = Path(tempfile.mkdtemp(prefix="shopai_pedestrian_test_"))
        from main import app
        from fastapi.testclient import TestClient

        client = TestClient(app, raise_server_exceptions=True)

        project = client.post("/api/cad/projects/", json={"name": "pedestrian-test"})
        assert project.status_code == 200, project.text
        project_id = project.json()["id"]

        furniture = client.post(
            f"/api/cad/projects/{project_id}/scene/furniture",
            json={
                "name": "Gondole test",
                "type": "gondola",
                "libraryId": "lib-gondola",
                "position": [100.0, 0.0, 200.0],
                "rotation": [0.0, 0.0, 0.0],
                "dimensions": {"width": 100.0, "depth": 40.0, "height": 180.0},
            },
        )
        assert furniture.status_code == 200, furniture.text
        furniture_id = furniture.json()["id"]

        product = client.post(
            f"/api/cad/projects/{project_id}/catalog/products",
            json={
                "ean": "TESTEAN0",
                "name": "Eau minérale",
                "brand": "Test",
                "category": "Boissons",
                "widthCm": 6.0,
                "depthCm": 6.0,
                "heightCm": 20.0,
                "weightG": 500.0,
                "priceSellEur": 1.5,
                "priceBuyEur": 0.8,
            },
        )
        assert product.status_code == 200, product.text

        planogram = client.post(
            f"/api/cad/projects/{project_id}/planograms",
            json={
                "name": "Face avant",
                "furnitureId": furniture_id,
                "face": "front",
                "rows": 1,
                "cols": 2,
                "widthCm": 100.0,
                "heightCm": 180.0,
                "cells": [{"ean": "TESTEAN0", "row": 0, "col": 0}],
            },
        )
        assert planogram.status_code == 200, planogram.text

        csv_bytes = (
            b"pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n"
            b"1,1000,1.2,,TESTEAN0\n"
            b"1,1000,1.2,,UNKNOWN_EAN\n"
            b"2,1010,0.9,,\n"
        )
        response = client.post(
            f"/api/cad/projects/{project_id}/simulation/import-pedestrians",
            files={"file": ("pedestrians.csv", io.BytesIO(csv_bytes), "text/csv")},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["pedestrianCount"] == 2
        plans_by_id = {plan["pedestrianId"]: plan for plan in body["plans"]}
        items_by_ean = {item["ean"]: item for item in plans_by_id[1]["items"]}
        assert items_by_ean["TESTEAN0"]["found"] is True
        assert items_by_ean["TESTEAN0"]["xCm"] is not None
        assert items_by_ean["UNKNOWN_EAN"]["found"] is False
        assert plans_by_id[2]["items"] == []
        assert any(anomaly["ean"] == "UNKNOWN_EAN" for anomaly in body["anomalies"])

        stored = client.get(f"/api/cad/projects/{project_id}/simulation/pedestrians")
        assert stored.status_code == 200, stored.text
        assert stored.json()["pedestrianCount"] == 2
