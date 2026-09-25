from __future__ import annotations

import io
import json
import tempfile
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import services.project_manager as pm

_tmp_root = Path(tempfile.mkdtemp(prefix="shopai_platform_test_"))
pm.STORAGE_ROOT = _tmp_root / "projects"

from main import app  # noqa: E402
from models.project import SceneData, SimulationConfig  # noqa: E402
from services import platform_service  # noqa: E402
from services.walkable_partition import compute_walkable_partition  # noqa: E402


def _make_client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


def _register(client: TestClient, *, name: str, email: str) -> dict:
    response = client.post(
        "/api/platform/auth/register",
        json={"name": name, "email": email, "password": "supersafepass"},
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]


def test_dashboard_and_project_visibility_are_tenant_scoped() -> None:
    alpha = _make_client()
    beta = _make_client()

    alpha_user = _register(alpha, name="Alice Retail", email="alice@example.com")
    assert alpha_user["email"] == "alice@example.com"

    project_response = alpha.post("/api/cad/projects/", json={"name": "Alice Store"})
    assert project_response.status_code == 200, project_response.text
    alpha_project_id = project_response.json()["id"]

    catalog_response = alpha.post(
        "/api/platform/catalogs",
        json={
            "name": "Catalog Alice",
            "description": "Assortiment premium",
            "sourceProjectId": alpha_project_id,
            "productCount": 42,
        },
    )
    assert catalog_response.status_code == 200, catalog_response.text

    simulation_response = alpha.post(
        "/api/platform/simulations",
        json={
            "name": "Simulation Alice",
            "description": "Rush midi",
            "sourceProjectId": alpha_project_id,
            "scenarioCount": 3,
        },
    )
    assert simulation_response.status_code == 200, simulation_response.text

    agent_response = alpha.post(
        "/api/platform/agent-requests",
        json={
            "provider": "github-copilot",
            "targetResourceType": "project",
            "targetResourceId": alpha_project_id,
            "prompt": "Ajoute un onboarding retail.",
        },
    )
    assert agent_response.status_code == 200, agent_response.text

    beta_user = _register(beta, name="Bob Retail", email="bob@example.com")
    assert beta_user["email"] == "bob@example.com"
    beta_project_response = beta.post("/api/cad/projects/", json={"name": "Bob Store"})
    assert beta_project_response.status_code == 200, beta_project_response.text
    beta_project_id = beta_project_response.json()["id"]

    alpha_projects = alpha.get("/api/cad/projects/")
    assert alpha_projects.status_code == 200, alpha_projects.text
    alpha_ids = {item["id"] for item in alpha_projects.json()["projects"]}
    assert alpha_project_id in alpha_ids
    assert len(alpha_ids) == 6

    beta_projects = beta.get("/api/cad/projects/")
    assert beta_projects.status_code == 200, beta_projects.text
    beta_ids = {item["id"] for item in beta_projects.json()["projects"]}
    assert beta_project_id in beta_ids
    assert len(beta_ids) == 6
    assert not alpha_ids & beta_ids

    forbidden = alpha.get(f"/api/cad/projects/{beta_project_id}")
    assert forbidden.status_code == 403, forbidden.text

    dashboard = alpha.get("/api/platform/dashboard")
    assert dashboard.status_code == 200, dashboard.text
    payload = dashboard.json()
    assert payload["stats"] == {
        "projectCount": 6,
        "catalogCount": 2,
        "simulationCount": 1,
        "agentRequestCount": 1,
        "storeLayoutCount": 1,
        "pedestrianDatasetCount": 1,
    }
    assert payload["projects"][0]["id"] == alpha_project_id
    assert payload["catalogs"][0]["sourceProjectId"] == alpha_project_id
    assert payload["simulations"][0]["sourceProjectId"] == alpha_project_id
    assert payload["agentRequests"][0]["targetResourceId"] == alpha_project_id


def test_oauth_redirect_and_callback_create_a_real_session(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _make_client()
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "google-secret")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "http://testserver/api/platform/auth/oauth/google/callback")

    start = client.get("/api/platform/auth/oauth/google/start?next=%2F", follow_redirects=False)
    assert start.status_code == 302, start.text
    location = start.headers["location"]
    assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth?"), location
    assert "client_id=google-client" in location
    assert "redirect_uri=http%3A%2F%2Ftestserver%2Fapi%2Fplatform%2Fauth%2Foauth%2Fgoogle%2Fcallback" in location

    monkeypatch.setattr(
        platform_service,
        "_fetch_oauth_profile",
        lambda provider, code, request_base_url: ("charlie@example.com", "Charlie Ops"),
    )
    callback = client.get(
        "/api/platform/auth/oauth/google/callback",
        params={
            "code": "oauth-code",
            "state": platform_service.build_oauth_state("google", "/"),
        },
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text
    assert callback.headers["location"] == "http://testserver/"

    session = client.get("/api/platform/session")
    assert session.status_code == 200, session.text
    assert session.json()["user"]["email"] == "charlie@example.com"


def test_oauth_callback_rejects_external_redirect_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _make_client()
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "google-secret")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "http://testserver/api/platform/auth/oauth/google/callback")
    monkeypatch.setattr(
        platform_service,
        "_fetch_oauth_profile",
        lambda provider, code, request_base_url: ("charlie@example.com", "Charlie Ops"),
    )

    callback = client.get(
        "/api/platform/auth/oauth/google/callback",
        params={
            "code": "oauth-code",
            "state": platform_service.build_oauth_state("google", "https://evil.example/steal"),
        },
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text
    assert callback.headers["location"] == "http://testserver/"


def test_agent_guide_and_project_capability_audit() -> None:
    client = _make_client()
    _register(client, name="Charlie Ops", email="charlie-capability@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Capability Store"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    furniture_response = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "id": "fixture-gondola",
            "name": "Gondole centrale",
            "type": "gondola_double",
            "libraryId": "gondola_double",
            "position": [100.0, 0.0, 100.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 120.0, "depth": 80.0, "height": 200.0},
        },
    )
    assert furniture_response.status_code == 200, furniture_response.text

    product_response = client.post(
        f"/api/cad/projects/{project_id}/catalog/products",
        json={
            "ean": "3017620422003",
            "name": "Pâte à tartiner",
            "brand": "Ferrero",
            "category": "Épicerie",
            "widthCm": 10.0,
            "depthCm": 8.0,
            "heightCm": 20.0,
            "weightG": 400.0,
            "imageUrl": None,
        },
    )
    assert product_response.status_code == 200, product_response.text

    planogram_response = client.post(
        f"/api/cad/projects/{project_id}/planograms",
        json={
            "id": "planogram-1",
            "name": "Gondole centrale - front",
            "furnitureId": "fixture-gondola",
            "face": "front",
            "rows": 1,
            "cols": 1,
            "widthCm": 120.0,
            "heightCm": 100.0,
            "cells": [{"id": "cell-1", "ean": "3017620422003", "row": 0, "col": 0, "rotation": 0}],
        },
    )
    assert planogram_response.status_code == 200, planogram_response.text

    agent_guide = client.get("/api/platform/agent-guide")
    assert agent_guide.status_code == 200, agent_guide.text
    assert agent_guide.json()["openApiUrl"] == "http://testserver/openapi.json"

    capability = client.get("/api/platform/agent-capabilities", params={"projectId": project_id})
    assert capability.status_code == 200, capability.text
    payload = capability.json()
    assert payload["agentPilot"]["supportsStoreDimensioning"] is True
    assert payload["agentPilot"]["supportsFurniturePlacement"] is True
    assert payload["agentPilot"]["supportsProductPlacement"] is True
    assert payload["projectAudit"]["ok"] is True
    assert payload["projectAudit"]["issueCount"] == 0


def test_layout_constraints_reject_invalid_furniture_and_planograms() -> None:
    client = _make_client()
    _register(client, name="Delta Ops", email="delta@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Constraint Store"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    invalid_furniture = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "id": "too-wide",
            "name": "Frigo hors zone",
            "type": "fridge",
            "libraryId": "fridge",
            "position": [4950.0, 0.0, 100.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 80.0, "height": 210.0},
        },
    )
    assert invalid_furniture.status_code == 422, invalid_furniture.text
    assert "exceeds store width bounds" in invalid_furniture.text

    valid_furniture = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "id": "fixture-fridge",
            "name": "Frigo OK",
            "type": "fridge",
            "libraryId": "fridge",
            "position": [100.0, 0.0, 100.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 80.0, "height": 210.0},
        },
    )
    assert valid_furniture.status_code == 200, valid_furniture.text

    invalid_planogram = client.post(
        f"/api/cad/projects/{project_id}/planograms",
        json={
            "id": "bad-planogram",
            "name": "Planogram invalide",
            "furnitureId": "fixture-fridge",
            "face": "front",
            "rows": 1,
            "cols": 1,
            "widthCm": 140.0,
            "heightCm": 50.0,
            "cells": [{"id": "bad-cell", "ean": "missing", "row": 0, "col": 0, "rotation": 0}],
        },
    )
    assert invalid_planogram.status_code == 422, invalid_planogram.text
    assert "exceeds face width" in invalid_planogram.text


def test_store_layout_and_pedestrian_dataset_survive_source_project_deletion() -> None:
    client = _make_client()
    _register(client, name="Layout Owner", email="layout-owner@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Boutique modèle"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    furniture_response = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "id": "fixture-gondola",
            "name": "Gondole",
            "type": "gondola",
            "libraryId": "gondola",
            "position": [200.0, 0.0, 200.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 120.0, "depth": 60.0, "height": 180.0},
        },
    )
    assert furniture_response.status_code == 200, furniture_response.text

    layout_response = client.post(
        "/api/platform/store-layouts",
        json={
            "name": "Layout modèle",
            "description": "Implantation de référence",
            "sourceProjectId": project_id,
        },
    )
    assert layout_response.status_code == 200, layout_response.text
    layout = layout_response.json()
    assert layout["furnitureCount"] == 1
    layout_id = layout["id"]

    csv_body = (
        "pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n"
        "1,1700000000,1.2,{},\n"
    )
    import_response = client.post(
        f"/api/cad/projects/{project_id}/simulation/import-pedestrians",
        data={"datasetName": "Affluence témoin"},
        files={"file": ("pedestrians.csv", csv_body, "text/csv")},
    )
    assert import_response.status_code == 200, import_response.text
    dataset_id = import_response.json()["datasetId"]

    delete_response = client.delete(f"/api/cad/projects/{project_id}")
    assert delete_response.status_code == 200, delete_response.text

    # Both tenant resources remain accessible after the source project is gone.
    layout_after = client.get(f"/api/platform/store-layouts/{layout_id}")
    assert layout_after.status_code == 200, layout_after.text
    assert layout_after.json()["sourceProjectId"] == project_id

    dataset_after = client.get(f"/api/platform/pedestrian-datasets/{dataset_id}")
    assert dataset_after.status_code == 200, dataset_after.text
    assert dataset_after.json()["pedestrianCount"] == 1

    dashboard = client.get("/api/platform/dashboard")
    assert dashboard.status_code == 200, dashboard.text
    stats = dashboard.json()["stats"]
    assert stats["storeLayoutCount"] == 2
    assert stats["pedestrianDatasetCount"] == 2


def test_create_project_seeds_from_selected_layout_catalog_and_pedestrians() -> None:
    client = _make_client()
    _register(client, name="Seeder", email="seeder@example.com")

    source_project = client.post("/api/cad/projects/", json={"name": "Source"})
    assert source_project.status_code == 200, source_project.text
    source_project_id = source_project.json()["id"]

    client.post(
        f"/api/cad/projects/{source_project_id}/scene/furniture",
        json={
            "id": "fixture-shelf",
            "name": "Étagère",
            "type": "shelf",
            "libraryId": "shelf",
            "position": [150.0, 0.0, 150.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 100.0, "depth": 50.0, "height": 180.0},
        },
    )

    layout = client.post(
        "/api/platform/store-layouts",
        json={"name": "Layout de base", "sourceProjectId": source_project_id},
    ).json()

    catalog = client.post(
        "/api/platform/catalogs",
        json={
            "name": "Catalogue de base",
            "payload": {"products": []},
            "productCount": 0,
        },
    ).json()

    csv_body = "pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n1,1700000000,1.2,{},\n"
    import_response = client.post(
        f"/api/cad/projects/{source_project_id}/simulation/import-pedestrians",
        data={"datasetName": "Jeu témoin"},
        files={"file": ("pedestrians.csv", csv_body, "text/csv")},
    )
    dataset_id = import_response.json()["datasetId"]

    new_project = client.post(
        "/api/cad/projects/",
        json={
            "name": "Nouveau projet",
            "storeLayoutId": layout["id"],
            "catalogId": catalog["id"],
            "pedestrianDatasetId": dataset_id,
        },
    )
    assert new_project.status_code == 200, new_project.text
    new_project_id = new_project.json()["id"]

    scene = client.get(f"/api/cad/projects/{new_project_id}/scene")
    assert scene.status_code == 200, scene.text
    assert len(scene.json()["furniture"]) == 1

    pedestrians = client.get(f"/api/cad/projects/{new_project_id}/simulation/pedestrians")
    assert pedestrians.status_code == 200, pedestrians.text
    assert pedestrians.json()["pedestrianCount"] == 1


def test_catalog_json_upload_persists_tenant_catalog() -> None:
    client = _make_client()
    _register(client, name="Cataloguer", email="cataloguer@example.com")

    assortment_body = json.dumps([
        {
            "barcode": "1234567890123",
            "product_name": "Jus d'orange 1L",
            "brand": "MarqueA",
            "category_name": "Boissons",
            "image_url": "https://example.com/a.jpg",
            "cost_price_eur": 1.25,
            "suggested_price_eur": 2.15,
            "margin_rate_pct": 42.0,
            "quantity": "1 L",
        }
    ])
    response = client.post(
        "/api/platform/catalogs/import-json",
        data={"name": "Catalogue importé", "description": "Depuis JSON"},
        files={"file": ("assortment.json", assortment_body, "application/json")},
    )
    assert response.status_code == 200, response.text
    catalog = response.json()
    assert catalog["productCount"] == 1
    assert catalog["payload"]["products"][0]["ean"] == "1234567890123"
    assert catalog["payload"]["products"][0]["name"] == "Jus d'orange 1L"

    dashboard = client.get("/api/platform/dashboard")
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()["stats"]["catalogCount"] == 2


def test_catalog_list_and_load_into_project() -> None:
    client = _make_client()
    _register(client, name="Loader", email="loader@example.com")

    project = client.post("/api/cad/projects/", json={"name": "Cible"})
    assert project.status_code == 200, project.text
    project_id = project.json()["id"]

    assortment_body = json.dumps([
        {
            "barcode": "3234567890123",
            "product_name": "Café moulu 250g",
            "brand": "MarqueC",
            "category_name": "Épicerie",
            "suggested_price_eur": 3.50,
            "quantity": "250 g",
        }
    ])
    created = client.post(
        "/api/platform/catalogs/import-json",
        data={"name": "Catalogue à charger", "description": ""},
        files={"file": ("assortment.json", assortment_body, "application/json")},
    )
    assert created.status_code == 200, created.text
    catalog_id = created.json()["id"]

    listing = client.get("/api/platform/catalogs")
    assert listing.status_code == 200, listing.text
    catalog_ids = [item["id"] for item in listing.json()["catalogs"]]
    assert catalog_id in catalog_ids

    loaded = client.post(f"/api/cad/projects/{project_id}/catalog/load-tenant-catalog/{catalog_id}")
    assert loaded.status_code == 200, loaded.text
    assert loaded.json()["imported"] == 1

    catalog = client.get(f"/api/cad/projects/{project_id}/catalog")
    assert catalog.status_code == 200, catalog.text
    eans = [product["ean"] for product in catalog.json()["products"]]
    assert "3234567890123" in eans


def test_catalog_json_upload_accepts_normalized_products_object() -> None:
    client = _make_client()
    _register(client, name="Describer", email="describer@example.com")

    payload = {
        "products": [
            {
                "ean": "4234567890123",
                "name": "Chips nature 150g",
                "brand": "MarqueD",
                "category": "Épicerie",
                "widthCm": 20,
                "depthCm": 10,
                "heightCm": 30,
                "weightG": 150,
                "description": "Chips artisanales salées",
            }
        ]
    }
    response = client.post(
        "/api/platform/catalogs/import-json",
        data={"name": "Catalogue avec descriptions", "description": ""},
        files={"file": ("catalog.json", json.dumps(payload), "application/json")},
    )
    assert response.status_code == 200, response.text
    product = response.json()["payload"]["products"][0]
    assert product["description"] == "Chips artisanales salées"


def test_store_layout_import_json_uses_shopai_retail_layout_format() -> None:
    client = _make_client()
    _register(client, name="Layout Importer", email="layout-importer@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Boutique source"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    furniture_response = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "id": "fixture-gondola-import",
            "name": "Gondole",
            "type": "gondola",
            "libraryId": "gondola",
            "position": [200.0, 0.0, 200.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 120.0, "depth": 60.0, "height": 180.0},
        },
    )
    assert furniture_response.status_code == 200, furniture_response.text

    export_response = client.get(f"/api/cad/projects/{project_id}/export/retail-layout")
    assert export_response.status_code == 200, export_response.text
    layout_json = export_response.text

    import_response = client.post(
        "/api/platform/store-layouts/import-json",
        data={"name": "Implantation importée", "description": "Depuis export ShopAI"},
        files={"file": ("retail_layout.json", layout_json, "application/json")},
    )
    assert import_response.status_code == 200, import_response.text
    layout = import_response.json()
    assert layout["furnitureCount"] == 1
    assert layout["payload"]["scene"]["furniture"][0]["id"] == "fixture-gondola-import"


def test_store_layout_import_json_normalizes_dimension_and_face_aliases() -> None:
    client = _make_client()
    _register(client, name="Alias Importer", email="alias-importer@example.com")

    layout_json = json.dumps(
        {
            "version": "1.0",
            "projectId": "urban-waterfront",
            "projectName": "Urban Waterfront",
            "unit": "cm",
            "store": {
                "id": "store-urban",
                "name": "Urban Waterfront",
                "dimensions": {"widthCm": 60000, "lengthCm": 40000, "heightCm": 8000},
                "zones": [],
            },
            "furniture": [
                {
                    "id": "fixture-mooring",
                    "name": "Mooring nodes",
                    "type": "urban-fixture",
                    "libraryId": "urban-fixture",
                    "position": {"x": 1000, "y": 0, "z": 2000},
                    "rotation": {"x": 0, "y": 0, "z": 0},
                    "dimensions": {"widthCm": 28000, "lengthCm": 1500, "heightCm": 300},
                    "placements": [
                        {
                            "face": "waterfront",
                            "planogramId": "plano-mooring-nodes",
                            "planogramName": "Mooring nodes",
                            "rows": 1,
                            "cols": 1,
                            "widthCm": 28000,
                            "heightCm": 300,
                            "slots": [],
                        }
                    ],
                },
                {
                    "id": "fixture-bus-stop",
                    "name": "Bus stop",
                    "type": "urban-fixture",
                    "libraryId": "urban-fixture",
                    "position": {"x": 32000, "y": 0, "z": 5000},
                    "rotation": {"x": 0, "y": 0, "z": 0},
                    "dimensions": {"widthCm": 15000, "lengthCm": 12000, "heightCm": 250},
                    "placements": [
                        {
                            "face": "roadside",
                            "planogramId": "plano-bus-stops",
                            "planogramName": "Bus stops",
                            "rows": 1,
                            "cols": 1,
                            "widthCm": 15000,
                            "heightCm": 250,
                            "slots": [],
                        }
                    ],
                },
            ],
        }
    )

    import_response = client.post(
        "/api/platform/store-layouts/import-json",
        data={"name": "Implantation waterfront", "description": "Depuis image"},
        files={"file": ("retail_layout.json", layout_json, "application/json")},
    )
    assert import_response.status_code == 200, import_response.text
    layout = import_response.json()
    assert layout["payload"]["scene"]["store"]["dimensions"] == {
        "width": 60000.0,
        "depth": 40000.0,
        "height": 8000.0,
    }
    assert layout["payload"]["scene"]["furniture"][0]["dimensions"] == {
        "width": 28000.0,
        "depth": 1500.0,
        "height": 300.0,
    }
    assert layout["payload"]["scene"]["furniture"][0]["faces"]["front"] == "plano-mooring-nodes"
    assert layout["payload"]["scene"]["furniture"][1]["faces"]["back"] == "plano-bus-stops"

    project_response = client.post(
        "/api/cad/projects/",
        json={"name": "Projet waterfront", "storeLayoutId": layout["id"]},
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    assert scene["store"]["dimensions"] == {"width": 60000.0, "depth": 40000.0, "height": 8000.0}
    assert scene["furniture"][0]["dimensions"] == {"width": 28000.0, "depth": 1500.0, "height": 300.0}
    assert scene["furniture"][0]["faces"]["front"] == "plano-mooring-nodes"
    assert scene["furniture"][1]["faces"]["back"] == "plano-bus-stops"


def test_store_layout_import_osm_maps_building_types_to_colors() -> None:
    client = _make_client()
    _register(client, name="OSM Importer", email="osm-importer@example.com")

    osm_xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <bounds minlat="14.6000" minlon="-61.0800" maxlat="14.6010" maxlon="-61.0790"/>
  <node id="1" lat="14.6009" lon="-61.0799"/>
  <node id="2" lat="14.6009" lon="-61.0797"/>
  <node id="3" lat="14.6007" lon="-61.0797"/>
  <node id="4" lat="14.6007" lon="-61.0799"/>
  <node id="5" lat="14.6006" lon="-61.0796"/>
  <node id="6" lat="14.6006" lon="-61.0794"/>
  <node id="7" lat="14.6004" lon="-61.0794"/>
  <node id="8" lat="14.6004" lon="-61.0796"/>
  <node id="9" lat="14.6003" lon="-61.0799"/>
  <node id="10" lat="14.6003" lon="-61.0797"/>
  <node id="11" lat="14.6001" lon="-61.0797"/>
  <node id="12" lat="14.6001" lon="-61.0799"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
    <tag k="building" v="retail"/>
    <tag k="height" v="9"/>
  </way>
  <way id="200">
    <nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/>
    <tag k="building" v="warehouse"/>
    <tag k="building:levels" v="2"/>
  </way>
  <way id="300">
    <nd ref="9"/><nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="9"/>
    <tag k="building" v="hangar"/>
  </way>
</osm>
"""
    import_response = client.post(
        "/api/platform/store-layouts/import-osm",
        data={"name": "Fort de France OSM", "description": "Import test OSM"},
        files={"file": ("fort_de_france.osm", osm_xml, "application/xml")},
    )
    assert import_response.status_code == 200, import_response.text
    payload = import_response.json()["payload"]
    scene = payload["scene"]
    zones = payload["scene"]["store"]["zones"]
    assert len(zones) == 3
    assert payload["scene"]["furniture"] == []

    zones_by_id = {zone["id"]: zone for zone in zones}
    assert zones_by_id["building-100"]["color"] == "#2A9D8F"
    assert zones_by_id["building-100"]["opacity"] == 0.62
    assert zones_by_id["building-100"]["heightCm"] == 900.0
    assert zones_by_id["building-100"]["mounted"] is True
    assert zones_by_id["building-200"]["color"] == "#4D908E"
    assert zones_by_id["building-200"]["opacity"] == 0.62
    assert zones_by_id["building-200"]["heightCm"] == 600.0
    assert zones_by_id["building-200"]["mounted"] is True
    assert zones_by_id["building-300"]["color"] == "#9CA3AF"
    assert zones_by_id["building-300"]["opacity"] == 0.32
    assert zones_by_id["building-300"]["heightCm"] == 1000.0
    assert zones_by_id["building-300"]["mounted"] is True
    assert zones_by_id["building-100"]["source"]["osmWayId"] == "100"
    assert zones_by_id["building-100"]["source"]["buildingType"] == "retail"
    assert zones_by_id["building-100"]["source"]["heightSource"] == "height"
    assert zones_by_id["building-100"]["source"]["height"] == "9"
    assert zones_by_id["building-200"]["source"]["heightSource"] == "building:levels"
    assert zones_by_id["building-200"]["source"]["building:levels"] == "2"
    assert zones_by_id["building-300"]["source"]["defaultHeightApplied"] is True
    all_x = [point["x"] for zone in zones for point in zone["points"]]
    all_z = [point["z"] for zone in zones for point in zone["points"]]
    assert min(all_x) >= 0.0
    assert min(all_z) >= 0.0
    assert max(all_x) <= scene["store"]["dimensions"]["width"]
    assert max(all_z) <= scene["store"]["dimensions"]["depth"]
    assert scene["store"]["dimensions"]["height"] == 1000.0

    project_response = client.post(
        "/api/cad/projects/",
        json={"name": "Projet OSM", "storeLayoutId": import_response.json()["id"]},
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    project_scene = client.get(f"/api/cad/projects/{project_id}/scene")
    assert project_scene.status_code == 200, project_scene.text
    assert project_scene.json()["store"]["dimensions"] == scene["store"]["dimensions"]
    assert project_scene.json()["store"]["zones"][0]["source"]["osmWayId"] == zones[0]["source"]["osmWayId"]


def test_store_layout_import_osm_keeps_buildings_only_by_default() -> None:
    client = _make_client()
    _register(client, name="OSM Buildings Only", email="osm-buildings-only@example.com")

    osm_xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <bounds minlat="14.6000" minlon="-61.0800" maxlat="14.6010" maxlon="-61.0790"/>
  <node id="1" lat="14.6009" lon="-61.0799"/>
  <node id="2" lat="14.6009" lon="-61.0797"/>
  <node id="3" lat="14.6007" lon="-61.0797"/>
  <node id="4" lat="14.6007" lon="-61.0799"/>
  <node id="5" lat="14.6006" lon="-61.0796"/>
  <node id="6" lat="14.6006" lon="-61.0794"/>
  <node id="7" lat="14.6004" lon="-61.0794"/>
  <node id="8" lat="14.6004" lon="-61.0796"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
    <tag k="building" v="retail"/>
  </way>
  <way id="200">
    <nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/>
    <tag k="landuse" v="grass"/>
  </way>
</osm>
"""
    import_response = client.post(
        "/api/platform/store-layouts/import-osm",
        data={"name": "OSM bâtiments uniquement", "description": "filter non-building zones"},
        files={"file": ("buildings-only.osm", osm_xml, "application/xml")},
    )
    assert import_response.status_code == 200, import_response.text
    zones = import_response.json()["payload"]["scene"]["store"]["zones"]
    assert [zone["id"] for zone in zones] == ["building-100"]
    assert zones[0]["source"]["isLikelyBuilding"] is True


def test_store_layout_import_osm_keeps_native_buildings_but_runtime_paths_merge_close_blocks() -> None:
    client = _make_client()
    _register(client, name="OSM Runtime Merge", email="osm-runtime-merge@example.com")

    osm_xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <bounds minlat="14.6000" minlon="-61.0800" maxlat="14.6004" maxlon="-61.0794"/>
  <node id="1" lat="14.6003" lon="-61.07995"/>
  <node id="2" lat="14.6003" lon="-61.07985"/>
  <node id="3" lat="14.6001" lon="-61.07985"/>
  <node id="4" lat="14.6001" lon="-61.07995"/>
  <node id="5" lat="14.6003" lon="-61.07982"/>
  <node id="6" lat="14.6003" lon="-61.07972"/>
  <node id="7" lat="14.6001" lon="-61.07972"/>
  <node id="8" lat="14.6001" lon="-61.07982"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
    <tag k="building" v="retail"/>
  </way>
  <way id="200">
    <nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/>
    <tag k="building" v="retail"/>
  </way>
</osm>
"""
    import_response = client.post(
        "/api/platform/store-layouts/import-osm",
        data={"name": "OSM blocs contigus", "description": "native buildings + runtime merge"},
        files={"file": ("close-buildings.osm", osm_xml, "application/xml")},
    )
    assert import_response.status_code == 200, import_response.text

    scene_payload = import_response.json()["payload"]["scene"]
    zones = scene_payload["store"]["zones"]
    assert [zone["id"] for zone in zones] == ["building-100", "building-200"]

    scene = SceneData.model_validate(scene_payload)
    merged_partition = compute_walkable_partition(scene, SimulationConfig.model_validate({"waypoints": []}))

    manual_scene = scene.model_copy(deep=True)
    for zone in manual_scene.store.zones:
        if zone.source:
            zone.source.pop("osmWayId", None)
    manual_partition = compute_walkable_partition(
        manual_scene,
        SimulationConfig.model_validate({"waypoints": []}),
    )

    assert merged_partition.connected.area < manual_partition.connected.area
    assert merged_partition.runtime_connected.area < manual_partition.runtime_connected.area


def test_store_layout_import_osm_rejects_invalid_xml() -> None:
    client = _make_client()
    _register(client, name="OSM Invalid XML", email="osm-invalid-xml@example.com")

    invalid_xml = "<osm><way></osm>"
    response = client.post(
        "/api/platform/store-layouts/import-osm",
        data={"name": "OSM invalide", "description": "broken xml"},
        files={"file": ("invalid.osm", invalid_xml, "application/xml")},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"].startswith("Invalid OSM document:")

    logs_response = client.get("/api/platform/logs?limit=50")
    assert logs_response.status_code == 200, logs_response.text
    logs = logs_response.json()["logs"]
    assert any(
        entry.get("category") == "osm-import"
        and entry.get("message") == "OSM import failed: invalid OSM document"
        for entry in logs
    )


def test_store_layout_import_osm_rejects_non_utf8_payload() -> None:
    client = _make_client()
    _register(client, name="OSM Invalid Encoding", email="osm-invalid-encoding@example.com")

    response = client.post(
        "/api/platform/store-layouts/import-osm",
        data={"name": "OSM encodage invalide", "description": "bad encoding"},
        files={"file": ("invalid.osm", b"\xff\xfe\x00\x00", "application/xml")},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == "File must be UTF-8 encoded OSM XML text"


def test_client_logs_are_persisted_and_returned_as_text() -> None:
    client = _make_client()
    _register(client, name="Logger User", email="logger@example.com")

    post_response = client.post(
        "/api/platform/logs/client",
        json={
            "source": "studio-monitor",
            "category": "3d-load",
            "message": "3D project load failed",
            "details": {"projectId": "demo", "error": "boom"},
        },
    )
    assert post_response.status_code == 200, post_response.text
    assert post_response.json()["logged"] is True
    assert post_response.json()["entry"]["details"] == {"projectId": "demo", "error": "boom"}

    logs_response = client.get("/api/platform/logs?limit=20")
    assert logs_response.status_code == 200, logs_response.text
    payload = logs_response.json()
    assert "3D project load failed" in payload["text"]
    assert any(
        entry.get("source") == "studio-monitor"
        and entry.get("category") == "3d-load"
        and entry.get("message") == "3D project load failed"
        and entry.get("details") == {"projectId": "demo", "error": "boom"}
        for entry in payload["logs"]
    )

    client.post(
        "/api/platform/logs/client",
        json={"source": "studio-monitor", "category": "3d-load", "message": "second log"},
    )
    limit_response = client.get("/api/platform/logs?limit=1")
    assert limit_response.status_code == 200, limit_response.text
    limited = limit_response.json()["logs"]
    assert len(limited) == 1
    assert limited[0]["message"] == "second log"


def test_diagnostic_logs_endpoints_require_authentication() -> None:
    client = _make_client()

    logs_response = client.get("/api/platform/logs?limit=20")
    assert logs_response.status_code == 401, logs_response.text
    assert logs_response.json()["detail"] == "Authentication required"

    append_response = client.post(
        "/api/platform/logs/client",
        json={"source": "frontend", "category": "3d-load", "message": "test"},
    )
    assert append_response.status_code == 401, append_response.text
    assert append_response.json()["detail"] == "Authentication required"


def test_store_layout_import_osm_without_bounds_derives_extent_from_nodes() -> None:
    client = _make_client()
    _register(client, name="OSM No Bounds", email="osm-no-bounds@example.com")

    osm_xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <node id="1" lat="14.6009" lon="-61.0799"/>
  <node id="2" lat="14.6009" lon="-61.0797"/>
  <node id="3" lat="14.6007" lon="-61.0797"/>
  <node id="4" lat="14.6007" lon="-61.0799"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
    <tag k="building" v="office"/>
  </way>
</osm>
"""
    response = client.post(
        "/api/platform/store-layouts/import-osm",
        data={"name": "OSM sans bounds", "description": "node-derived extents"},
        files={"file": ("no-bounds.osm", osm_xml, "application/xml")},
    )
    assert response.status_code == 200, response.text

    scene = response.json()["payload"]["scene"]
    dims = scene["store"]["dimensions"]
    zones = scene["store"]["zones"]
    assert len(zones) == 1
    assert dims["width"] > 0
    assert dims["depth"] > 0
    assert zones[0]["x"] == 0.0
    assert zones[0]["z"] == 0.0
    assert zones[0]["heightCm"] == 1000.0
    assert zones[0]["color"] == "#577590"
    assert zones[0]["opacity"] == 0.32
    assert zones[0]["mounted"] is True


def test_store_layout_import_osm_rebases_geometries_when_bounds_are_inconsistent() -> None:
    client = _make_client()
    _register(client, name="OSM Inconsistent Bounds", email="osm-inconsistent-bounds@example.com")

    osm_xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <bounds minlat="14.6002" minlon="-61.0797" maxlat="14.6008" maxlon="-61.0793"/>
  <node id="1" lat="14.6009" lon="-61.0799"/>
  <node id="2" lat="14.6009" lon="-61.0798"/>
  <node id="3" lat="14.6008" lon="-61.0798"/>
  <node id="4" lat="14.6008" lon="-61.0799"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
    <tag k="building" v="retail"/>
  </way>
</osm>
"""
    response = client.post(
        "/api/platform/store-layouts/import-osm",
        data={"name": "OSM bounds incohérents", "description": "zones rebased to store origin"},
        files={"file": ("inconsistent-bounds.osm", osm_xml, "application/xml")},
    )
    assert response.status_code == 200, response.text

    scene = response.json()["payload"]["scene"]
    zones = scene["store"]["zones"]
    assert len(zones) == 1

    all_x = [point["x"] for zone in zones for point in zone["points"]]
    all_z = [point["z"] for zone in zones for point in zone["points"]]

    assert min(all_x) >= 0.0
    assert min(all_z) >= 0.0
    assert max(all_x) <= scene["store"]["dimensions"]["width"]
    assert max(all_z) <= scene["store"]["dimensions"]["depth"]


def test_project_import_snapshot_normalizes_dimension_and_face_aliases() -> None:
    client = _make_client()
    _register(client, name="Snapshot Importer", email="snapshot-importer@example.com")

    response = client.post(
        "/api/cad/projects/import",
        json={
            "name": "Projet snapshot waterfront",
            "snapshot": {
                "scene": {
                    "store": {
                        "id": "store-snapshot",
                        "name": "Snapshot Store",
                        "dimensions": {"widthCm": 12000, "lengthCm": 8000, "heightCm": 400},
                    },
                    "furniture": [
                        {
                            "id": "fixture-snapshot",
                            "name": "Quai",
                            "type": "urban-fixture",
                            "libraryId": "urban-fixture",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "dimensions": {"widthCm": 3000, "lengthCm": 2000, "heightCm": 20},
                            "faces": {"waterfront": "plano-waterfront"},
                        }
                    ],
                },
                "planograms": [
                    {
                        "id": "plano-waterfront",
                        "name": "Waterfront",
                        "furnitureId": "fixture-snapshot",
                        "face": "waterfront",
                        "rows": 1,
                        "cols": 1,
                        "widthCm": 3000,
                        "heightCm": 20,
                        "cells": [],
                    }
                ],
            },
        },
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["id"]

    scene = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene.status_code == 200, scene.text
    assert scene.json()["store"]["dimensions"] == {"width": 12000.0, "depth": 8000.0, "height": 400.0}
    assert scene.json()["furniture"][0]["dimensions"] == {"width": 3000.0, "depth": 2000.0, "height": 20.0}
    assert scene.json()["furniture"][0]["faces"]["front"] == "plano-waterfront"

    planogram = client.get(f"/api/cad/projects/{project_id}/planograms/plano-waterfront")
    assert planogram.status_code == 200, planogram.text
    assert planogram.json()["face"] == "front"


def test_create_project_from_layout_normalizes_zone_and_directional_face_aliases() -> None:
    client = _make_client()
    _register(client, name="Layout Alias Seeder", email="layout-alias@example.com")

    layout_response = client.post(
        "/api/platform/store-layouts",
        json={
            "name": "Layout alias",
            "payload": {
                "scene": {
                    "store": {
                        "id": "store-layout-alias",
                        "name": "Alias Store",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "dimensions": {"width": 5000, "depth": 3000, "height": 400},
                        "zones": [
                            {
                                "id": "zone-sud-front",
                                "type": "entrance",
                                "label": "Zone sud",
                                "x": 0,
                                "z": 0,
                                "widthCm": 1000,
                                "lengthCm": 1000,
                            },
                            {
                                "id": "zone-nord",
                                "type": "exit",
                                "label": "Zone nord",
                                "x": 200,
                                "z": 300,
                                "Width": 500,
                                "DEPTH": 700,
                            },
                        ],
                    },
                    "furniture": [
                        {
                            "id": "fixture-1",
                            "name": "Facing mer",
                            "type": "shelf",
                            "libraryId": "shelf",
                            "position": [0, 0, 0],
                            "rotation": [0, 0, 0],
                            "dimensions": {"width": 120, "depth": 60, "height": 180},
                            "faces": {"south_sea_view": "plano-bayview-terrace"},
                        },
                        {
                            "id": "fixture-2",
                            "name": "Charging",
                            "type": "shelf",
                            "libraryId": "shelf",
                            "position": [200, 0, 0],
                            "rotation": [0, 0, 0],
                            "dimensions": {"width": 120, "depth": 60, "height": 180},
                            "faces": {"north_charging": "plano-charging-hub"},
                        },
                    ],
                },
                "planograms": [],
            },
        },
    )
    assert layout_response.status_code == 200, layout_response.text
    layout_id = layout_response.json()["id"]

    project_response = client.post(
        "/api/cad/projects/",
        json={"name": "Projet alias", "storeLayoutId": layout_id},
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    scene = scene_response.json()
    assert scene["store"]["zones"][0]["width"] == 1000.0
    assert scene["store"]["zones"][0]["depth"] == 1000.0
    assert scene["store"]["zones"][1]["width"] == 500.0
    assert scene["store"]["zones"][1]["depth"] == 700.0
    assert scene["furniture"][0]["faces"]["front"] == "plano-bayview-terrace"
    assert scene["furniture"][1]["faces"]["back"] == "plano-charging-hub"


def test_store_layout_rejects_conflicting_zone_dimension_aliases() -> None:
    client = _make_client()
    _register(client, name="Layout Conflict Seeder", email="layout-conflict@example.com")

    response = client.post(
        "/api/platform/store-layouts",
        json={
            "name": "Layout conflict",
            "payload": {
                "scene": {
                    "store": {
                        "id": "store-conflict",
                        "name": "Conflict Store",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "dimensions": {"width": 5000, "depth": 3000, "height": 400},
                        "zones": [
                            {
                                "id": "zone-conflict",
                                "type": "entrance",
                                "label": "Zone conflict",
                                "x": 0,
                                "z": 0,
                                "width": 900,
                                "widthCm": 1000,
                                "depth": 1000,
                            }
                        ],
                    },
                    "furniture": [],
                },
                "planograms": [],
            },
        },
    )
    assert response.status_code == 422, response.text
    assert "conflicting aliases for width" in response.text


def test_create_project_from_layout_defaults_sparse_legacy_zones() -> None:
    client = _make_client()
    _register(client, name="Sparse Zone Seeder", email="sparse-zone@example.com")

    layout_response = client.post(
        "/api/platform/store-layouts",
        json={
            "name": "Sparse zone layout",
            "payload": {
                "scene": {
                    "store": {
                        "id": "store-sparse-zone",
                        "name": "Sparse Zone Store",
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "dimensions": {"width": 5000, "depth": 3000, "height": 400},
                        "zones": [
                            {
                                "id": "zone-centre-hotel",
                                "widthCm": 1200,
                                "lengthCm": 1000,
                            }
                        ],
                    },
                    "furniture": [],
                },
                "planograms": [],
            },
        },
    )
    assert layout_response.status_code == 200, layout_response.text
    layout_id = layout_response.json()["id"]

    project_response = client.post(
        "/api/cad/projects/",
        json={"name": "Projet sparse zone", "storeLayoutId": layout_id},
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    zone = scene_response.json()["store"]["zones"][0]
    assert zone["type"] == "forbidden"
    assert zone["label"] == "Zone interdite"
    assert zone["x"] == 0.0
    assert zone["z"] == 0.0
    assert zone["width"] == 1200.0
    assert zone["depth"] == 1000.0


def test_dashboard_and_scene_endpoint_normalize_legacy_sparse_zone_aliases() -> None:
    client = _make_client()
    _register(client, name="Legacy Zone Viewer", email="legacy-zone-viewer@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Projet legacy zone"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    scene = pm.load_project_file(project_id, "scene.json")
    scene["store"]["zones"] = [{"id": "zone-nord-ouest", "widthCm": 900, "lengthCm": 700}]
    pm.save_project_file(project_id, "scene.json", scene)

    dashboard = client.get("/api/platform/dashboard")
    assert dashboard.status_code == 200, dashboard.text
    project_ids = {item["id"] for item in dashboard.json()["projects"]}
    assert project_id in project_ids

    scene_response = client.get(f"/api/cad/projects/{project_id}/scene")
    assert scene_response.status_code == 200, scene_response.text
    zone = scene_response.json()["store"]["zones"][0]
    assert zone["type"] == "forbidden"
    assert zone["label"] == "Zone interdite"
    assert zone["x"] == 0.0
    assert zone["z"] == 0.0
    assert zone["width"] == 900.0
    assert zone["depth"] == 700.0


def test_simulation_import_json_persists_scenarios() -> None:
    client = _make_client()
    _register(client, name="Simulation Importer", email="simulation-importer@example.com")

    payload = {"scenarios": [{"name": "Samedi 14h"}, {"name": "Vendredi 18h"}]}
    response = client.post(
        "/api/platform/simulations/import-json",
        data={"name": "Simulation importée", "description": "Depuis JSON"},
        files={"file": ("scenarios.json", json.dumps(payload), "application/json")},
    )
    assert response.status_code == 200, response.text
    simulation = response.json()
    assert simulation["scenarioCount"] == 2
    assert simulation["payload"]["scenarios"][0]["name"] == "Samedi 14h"


def test_workspace_resources_expose_downloadable_json() -> None:
    client = _make_client()
    _register(client, name="Downloader", email="downloader@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Projet source téléchargement"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    furniture_response = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "id": "fixture-download",
            "name": "Gondole download",
            "type": "gondola",
            "libraryId": "gondola",
            "position": [200.0, 0.0, 200.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 120.0, "depth": 60.0, "height": 180.0},
        },
    )
    assert furniture_response.status_code == 200, furniture_response.text

    catalog_response = client.post(
        "/api/platform/catalogs",
        json={"name": "Catalogue download", "payload": {"products": [{"ean": "123"}]}, "productCount": 1},
    )
    assert catalog_response.status_code == 200, catalog_response.text
    catalog_id = catalog_response.json()["id"]

    simulation_response = client.post(
        "/api/platform/simulations",
        json={"name": "Simulation download", "payload": {"scenarios": [{"name": "soir"}]}, "scenarioCount": 1},
    )
    assert simulation_response.status_code == 200, simulation_response.text
    simulation_id = simulation_response.json()["id"]

    layout_response = client.post(
        "/api/platform/store-layouts",
        json={"name": "Layout download", "sourceProjectId": project_id},
    )
    assert layout_response.status_code == 200, layout_response.text
    layout_id = layout_response.json()["id"]

    catalog_download = client.get(f"/api/platform/catalogs/{catalog_id}/download")
    assert catalog_download.status_code == 200, catalog_download.text
    assert catalog_download.headers["content-disposition"].endswith('"Catalogue_download_catalog.json"')
    assert json.loads(catalog_download.text)["products"][0]["ean"] == "123"

    simulation_download = client.get(f"/api/platform/simulations/{simulation_id}/download")
    assert simulation_download.status_code == 200, simulation_download.text
    assert simulation_download.headers["content-disposition"].endswith('"Simulation_download_simulation.json"')
    assert json.loads(simulation_download.text)["scenarios"][0]["name"] == "soir"

    layout_download = client.get(f"/api/platform/store-layouts/{layout_id}/download")
    assert layout_download.status_code == 200, layout_download.text
    assert layout_download.headers["content-disposition"].endswith('"Layout_download_retail_layout.json"')
    retail_layout = json.loads(layout_download.text)
    assert retail_layout["store"]["name"] == "Projet source téléchargement"
    assert retail_layout["furniture"][0]["name"] == "Gondole download"


def test_workspace_pedestrian_dataset_is_downloadable_as_csv() -> None:
    client = _make_client()
    _register(client, name="Dataset Downloader", email="dataset-downloader@example.com")

    dataset_response = client.post(
        "/api/platform/pedestrian-datasets",
        json={
            "name": "Piétons démo",
            "pedestrianCount": 2,
            "payload": {
                "pedestrianCount": 2,
                "rowCount": 3,
                "plans": [
                    {
                        "pedestrianId": 1,
                        "startUnixTs": 1700000000,
                        "speedMps": 1.2,
                        "profile": {"type": "rush"},
                        "items": [{"ean": "123", "found": False}, {"ean": "456", "found": False}],
                    },
                    {
                        "pedestrianId": 2,
                        "startUnixTs": 1700000300,
                        "speedMps": 1.0,
                        "profile": {},
                        "items": [],
                    },
                ],
                "anomalies": [],
            },
        },
    )
    assert dataset_response.status_code == 200, dataset_response.text
    dataset_id = dataset_response.json()["id"]

    dataset_download = client.get(f"/api/platform/pedestrian-datasets/{dataset_id}/download")
    assert dataset_download.status_code == 200, dataset_download.text
    assert dataset_download.headers["content-disposition"].endswith('"Pi_tons_d_mo_pedestrian_dataset.csv"')
    assert dataset_download.headers["content-type"].startswith("text/csv")
    assert dataset_download.text == (
        "pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n"
        '1,1700000000,1.2,"{""type"":""rush""}",123\n'
        '1,1700000000,1.2,"{""type"":""rush""}",456\n'
        "2,1700000300,1.0,{},\n"
    )


def test_workspace_pedestrian_dataset_download_handles_invalid_payload() -> None:
    client = _make_client()
    _register(client, name="Broken Dataset Downloader", email="broken-dataset@example.com")

    dataset_response = client.post(
        "/api/platform/pedestrian-datasets",
        json={
            "name": "Dataset invalide",
            "pedestrianCount": 1,
            "payload": {
                "pedestrianCount": 1,
                "rowCount": 1,
                "plans": [{"startUnixTs": 1700000000, "speedMps": 1.2, "profile": {}, "items": []}],
                "anomalies": [],
            },
        },
    )
    assert dataset_response.status_code == 200, dataset_response.text
    dataset_id = dataset_response.json()["id"]

    dataset_download = client.get(f"/api/platform/pedestrian-datasets/{dataset_id}/download")
    assert dataset_download.status_code == 422, dataset_download.text
    assert dataset_download.json()["detail"] == "Stored pedestrian dataset is invalid and cannot be exported as CSV"


def test_workspace_resources_can_be_deleted() -> None:
    client = _make_client()
    _register(client, name="Cleaner", email="cleaner@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Projet à supprimer"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    catalog_response = client.post(
        "/api/platform/catalogs",
        json={"name": "Catalogue à supprimer", "productCount": 0, "payload": {"products": []}},
    )
    assert catalog_response.status_code == 200, catalog_response.text
    catalog_id = catalog_response.json()["id"]

    simulation_response = client.post(
        "/api/platform/simulations",
        json={"name": "Simulation à supprimer", "scenarioCount": 1, "payload": {"scenarios": [{"name": "test"}]}},
    )
    assert simulation_response.status_code == 200, simulation_response.text
    simulation_id = simulation_response.json()["id"]

    layout_response = client.post(
        "/api/platform/store-layouts",
        json={"name": "Implantation à supprimer", "sourceProjectId": project_id},
    )
    assert layout_response.status_code == 200, layout_response.text
    layout_id = layout_response.json()["id"]

    dataset_response = client.post(
        "/api/platform/pedestrian-datasets",
        json={"name": "Dataset à supprimer", "pedestrianCount": 1, "payload": {"pedestrianCount": 1, "rowCount": 1, "plans": [], "anomalies": []}},
    )
    assert dataset_response.status_code == 200, dataset_response.text
    dataset_id = dataset_response.json()["id"]

    delete_project = client.delete(f"/api/cad/projects/{project_id}")
    assert delete_project.status_code == 200, delete_project.text

    delete_catalog = client.delete(f"/api/platform/catalogs/{catalog_id}")
    assert delete_catalog.status_code == 200, delete_catalog.text

    delete_simulation = client.delete(f"/api/platform/simulations/{simulation_id}")
    assert delete_simulation.status_code == 200, delete_simulation.text

    delete_layout = client.delete(f"/api/platform/store-layouts/{layout_id}")
    assert delete_layout.status_code == 200, delete_layout.text

    delete_dataset = client.delete(f"/api/platform/pedestrian-datasets/{dataset_id}")
    assert delete_dataset.status_code == 200, delete_dataset.text

    dashboard = client.get("/api/platform/dashboard")
    assert dashboard.status_code == 200, dashboard.text
    stats = dashboard.json()["stats"]
    assert stats["catalogCount"] == 1
    assert stats["simulationCount"] == 0
    assert stats["storeLayoutCount"] == 1
    assert stats["pedestrianDatasetCount"] == 1


def test_project_zip_export_embeds_reimportable_store_layout_json() -> None:
    client = _make_client()
    _register(client, name="Exporter", email="exporter@example.com")

    project_response = client.post("/api/cad/projects/", json={"name": "Projet exporté"})
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    furniture_response = client.post(
        f"/api/cad/projects/{project_id}/scene/furniture",
        json={
            "id": "fixture-gondola-export",
            "name": "Gondole export",
            "type": "gondola",
            "libraryId": "gondola",
            "position": [200.0, 0.0, 200.0],
            "rotation": [0.0, 0.0, 0.0],
            "dimensions": {"width": 120.0, "depth": 60.0, "height": 180.0},
        },
    )
    assert furniture_response.status_code == 200, furniture_response.text

    exported_zip = client.get(f"/api/cad/projects/{project_id}/export")
    assert exported_zip.status_code == 200, exported_zip.text

    with zipfile.ZipFile(io.BytesIO(exported_zip.content)) as archive:
        assert "retail-layout.json" in archive.namelist()
        retail_layout = archive.read("retail-layout.json").decode("utf-8")

    import_response = client.post(
        "/api/platform/store-layouts/import-json",
        data={"name": "Implantation depuis ZIP", "description": "Retail layout embarqué"},
        files={"file": ("retail-layout.json", retail_layout, "application/json")},
    )
    assert import_response.status_code == 200, import_response.text
    assert import_response.json()["payload"]["scene"]["furniture"][0]["id"] == "fixture-gondola-export"


def test_pedestrian_dataset_csv_upload_from_workspace() -> None:
    client = _make_client()
    _register(client, name="CSV Importer", email="pedestrian-csv@example.com")

    csv_body = (
        "pedestrian_id,start_unix_ts,speed_mps,profile_json,ean\n"
        "1,1700000000,1.2,{\"type\":\"rush\"},1234567890123\n"
        "1,1700000000,1.2,{\"type\":\"rush\"},2234567890123\n"
    )
    response = client.post(
        "/api/platform/pedestrian-datasets/import-csv",
        data={"name": "Dataset CSV", "description": "Import workspace"},
        files={"file": ("dataset.csv", csv_body, "text/csv")},
    )
    assert response.status_code == 200, response.text
    dataset = response.json()
    assert dataset["pedestrianCount"] == 1
    assert dataset["payload"]["pedestrianCount"] == 1
    assert dataset["payload"]["rowCount"] == 2
    assert len(dataset["payload"]["plans"][0]["items"]) == 2
