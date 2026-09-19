from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import HTTPException

from models.project import Catalog
from services import platform_service as platform
from services import project_manager as pm
from services.reference_templates import (
    REFERENCE_PROJECT_IDS,
    load_default_assortment,
    load_reference_template,
)


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path / "projects")
    token = platform.set_current_user(None)
    yield
    platform.reset_current_user(token)


def _register(name: str = "Alice") -> dict:
    return platform.register_user(name, f"{name.lower()}@example.com", "long-password")


def _assets(user: dict) -> dict[str, str]:
    with platform._connect() as conn:
        return {
            row["asset_key"]: row["resource_id"]
            for row in conn.execute(
                "SELECT asset_key, resource_id FROM tenant_default_assets WHERE tenant_id = ?",
                (user["tenantId"],),
            )
        }


def test_new_tenants_receive_independent_persisted_projects_and_real_catalog():
    alice, bob = _register(), _register("Bob")
    alice_assets, bob_assets = _assets(alice), _assets(bob)
    assert set(alice_assets) == {
        *REFERENCE_PROJECT_IDS, "carrefour_city_layout", "carrefour_express_layout", "assortment"
    }
    assert not set(alice_assets.values()) & set(bob_assets.values())
    assert not set(REFERENCE_PROJECT_IDS) & platform.list_owned_project_ids(alice)

    for source_id in REFERENCE_PROJECT_IDS:
        project_id = alice_assets[source_id]
        snapshot = load_reference_template(source_id)
        assert pm.load_project_file(project_id, "scene.json") == snapshot["scene"]
        assert pm.load_project_file(project_id, "catalog.json") == snapshot["catalog"]
        assert pm.load_project_file(project_id, "planograms.json")["planograms"] == snapshot["planograms"]
        assert (pm.STORAGE_ROOT / project_id / "scene.json").is_file()
        assert not (pm.STORAGE_ROOT / project_id / "scene.json").is_symlink()

    token = platform.set_current_user(alice)
    try:
        dashboard = platform.get_dashboard()
        assert dashboard["stats"]["projectCount"] == 5
        assert dashboard["stats"]["catalogCount"] == 1
        workspace = dashboard["catalogs"][0]
        assert workspace["name"] == "Assortiment Carrefour"
        products = Catalog.model_validate(workspace["payload"]).products
        source = json.loads((Path(__file__).resolve().parents[2] / "assortment.json").read_text())
        assert len(products) == workspace["productCount"] == len(source) == 4807
        assert products[0].ean == source[0]["barcode"]
        assert products[0].name == source[0]["product_name"]
        assert products[0].imageUrl == source[0]["image_url"]
        assert products[0].priceBuyEur == source[0]["cost_price_eur"]
        assert products[0].priceSellEur == source[0]["suggested_price_eur"]
        assert not platform.current_user_can_access_project(bob_assets["carrefour_city"])
    finally:
        platform.reset_current_user(token)


def test_layout_defaults_keep_store_and_furniture_but_remove_all_assignments():
    user = _register()
    assets = _assets(user)
    for source_id in REFERENCE_PROJECT_IDS[:2]:
        full_scene = load_reference_template(source_id)["scene"]
        layout_id = assets[f"{source_id}_layout"]
        scene = pm.load_project_file(layout_id, "scene.json")
        assert scene["store"] == full_scene["store"]
        assert len(scene["furniture"]) == len(full_scene["furniture"]) > 0
        for item, original in zip(scene["furniture"], full_scene["furniture"]):
            assert {k: v for k, v in item.items() if k != "faces"} == {
                k: v for k, v in original.items() if k != "faces"
            }
            assert not any(item["faces"].values())
        assert pm.load_project_file(layout_id, "planograms.json") == {"planograms": []}
        assert pm.load_project_file(layout_id, "catalog.json") == load_default_assortment()


def test_repeated_login_dashboard_and_concurrent_backfill_preserve_edits():
    user = _register()
    assets = _assets(user)
    scene = pm.load_project_file(assets["carrefour_city"], "scene.json")
    scene["store"]["name"] = "My edited store"
    pm.save_project_file(assets["carrefour_city"], "scene.json", scene)
    with platform._connect() as conn:
        conn.execute(
            "UPDATE catalog_workspaces SET name = ?, payload_json = ?, product_count = 0 WHERE id = ?",
            ("My assortment", '{"products":[]}', assets["assortment"]),
        )
    platform.login_user(user["email"], "long-password")
    token = platform.set_current_user(user)
    try:
        for _ in range(2):
            assert platform.get_dashboard()["stats"]["projectCount"] == 5
        assert platform.get_dashboard()["catalogs"][0]["name"] == "My assortment"
        assert platform.get_dashboard()["catalogs"][0]["payload"] == {"products": []}
    finally:
        platform.reset_current_user(token)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(platform.ensure_tenant_defaults, [user] * 3))
    assert _assets(user) == assets
    assert pm.load_project_file(assets["carrefour_city"], "scene.json") == scene
    assert load_reference_template("carrefour_city")["scene"] != scene


def test_existing_users_are_backfilled_and_claimed_originals_are_migrated(monkeypatch):
    real_ensure = platform.ensure_tenant_defaults
    monkeypatch.setattr(platform, "ensure_tenant_defaults", lambda user: None)
    user = _register()
    monkeypatch.setattr(platform, "ensure_tenant_defaults", real_ensure)
    pm.create_project("carrefour_city", "Previously edited reference")
    scene = pm.load_project_file("carrefour_city", "scene.json")
    with platform._connect() as conn:
        conn.execute(
            "INSERT INTO project_memberships VALUES (?, ?, ?, ?)",
            ("carrefour_city", user["tenantId"], user["id"], platform._utc_now()),
        )
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(platform.ensure_tenant_defaults, [user] * 3))
    assets = _assets(user)
    assert len(assets) == 6
    assert len(platform.list_owned_project_ids(user)) == 5
    assert assets["carrefour_city"] != "carrefour_city"
    assert pm.load_project_file(assets["carrefour_city"], "scene.json") == scene
    assert pm.get_project_metadata(assets["carrefour_city"])["name"] == "Previously edited reference"
    other = _register("Bob")
    assert pm.load_project_file(_assets(other)["carrefour_city"], "scene.json") == (
        load_reference_template("carrefour_city")["scene"]
    )
    token = platform.set_current_user(user)
    try:
        with pytest.raises(HTTPException) as error:
            platform.assign_project_to_current_user("carrefour_city")
        assert error.value.status_code == 403
        assert not platform.current_user_can_access_project("carrefour_city")
    finally:
        platform.reset_current_user(token)


def test_deleted_default_is_not_resurrected_and_loader_returns_fresh_data():
    user = _register()
    assets = _assets(user)
    pm.delete_project(assets["carrefour_city"])
    platform.ensure_tenant_defaults(user)
    assert _assets(user) == assets
    assert len(platform.list_owned_project_ids(user)) == 4
    token = platform.set_current_user(user)
    try:
        assert platform.get_dashboard()["stats"]["projectCount"] == 4
    finally:
        platform.reset_current_user(token)
    snapshot = load_reference_template("carrefour_city")
    snapshot["scene"]["furniture"].clear()
    assert load_reference_template("carrefour_city")["scene"]["furniture"]
    with pytest.raises(HTTPException):
        load_reference_template("../../projects/carrefour_city")


def test_oauth_defaults_are_idempotent():
    user = platform.oauth_sign_in("google", "oauth@example.com", "OAuth User")
    assets = _assets(user)
    assert len(assets) == 6
    assert platform.oauth_sign_in("google", "oauth@example.com", "OAuth User") == user
    assert _assets(user) == assets


def test_canonical_project_access_is_denied_without_a_session():
    assert platform.get_current_user() is None
    for source_id in REFERENCE_PROJECT_IDS:
        assert not platform.current_user_can_access_project(source_id)
        with pytest.raises(HTTPException) as error:
            platform.require_current_user_project_access(source_id)
        assert error.value.status_code == 403


def test_public_cad_routes_cannot_modify_canonical_sources():
    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app)
    before = load_reference_template("carrefour_city")
    prefix = "/api/cad/projects/carrefour_city"
    assert client.delete(prefix).status_code == 403
    assert client.post(f"{prefix}/duplicate", json={"name": "Unsafe copy"}).status_code == 403
    assert client.put(f"{prefix}/settings", json=before["settings"]).status_code == 403
    assert client.put(f"{prefix}/scene/store", json=before["scene"]["store"]).status_code == 403
    assert load_reference_template("carrefour_city") == before
