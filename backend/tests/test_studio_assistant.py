from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from services import project_manager as pm
from services import reference_templates
from services import studio_assistant as assistant


@pytest.fixture
def workspace(monkeypatch: pytest.MonkeyPatch):
    root = Path(__file__).resolve().parent.parent / ".test-studio-work" / uuid4().hex
    root.mkdir(parents=True)
    monkeypatch.setattr(pm, "STORAGE_ROOT", root / "projects")
    try:
        yield root
    finally:
        shutil.rmtree(root)
        if not any(root.parent.iterdir()):
            root.parent.rmdir()


def _register(client: TestClient, name: str = "Studio") -> None:
    result = client.post("/api/platform/auth/register", json={
        "name": name, "email": f"{uuid4().hex}@example.com", "password": "studio-test-password",
    })
    assert result.status_code == 200, result.text


@pytest.fixture
def studio(workspace):
    # Set storage before importing main: startup creates demo data.
    from main import app

    with TestClient(app) as client:
        _register(client)
        result = client.post("/api/cad/projects/", json={"name": "Mon projet existant"})
        assert result.status_code == 200, result.text
        yield client, result.json()["id"]


def _ask(client: TestClient, project_id: str, prompt: str, **extra) -> dict:
    result = client.post(f"/api/cad/projects/{project_id}/assistant", json={"prompt": prompt, **extra})
    assert result.status_code == 200, result.text
    payload = result.json()
    assert isinstance(payload["requiresConfirmation"], bool)
    assert isinstance(payload["changed"], bool)
    assert "sans LLM" in payload["message"]
    return payload


@pytest.mark.parametrize("model", ["City", "Express", "Express aéroport"])
def test_complete_generation_requires_confirmation_and_persists_all_files(studio, model):
    client, original_id = studio
    original = client.get(f"/api/cad/projects/{original_id}/export").content
    before_ids = {item["id"] for item in client.get("/api/cad/projects/").json()["projects"]}
    prompt = f"Crée une implantation complète Carrefour {model}"
    preview = _ask(client, original_id, prompt)
    assert preview["requiresConfirmation"] and not preview["changed"]
    assert "projectId" not in preview
    assert before_ids == {item["id"] for item in client.get("/api/cad/projects/").json()["projects"]}

    result = _ask(client, original_id, prompt, confirm=True)
    assert result["changed"] and not result["requiresConfirmation"]
    generated_id = result["projectId"]
    assert generated_id != original_id
    assert client.get(f"/api/cad/projects/{generated_id}").status_code == 200
    assert generated_id in {item["id"] for item in client.get("/api/cad/projects/").json()["projects"]}
    assert client.get(f"/api/cad/projects/{original_id}/export").content == original

    with zipfile.ZipFile(io.BytesIO(client.get(f"/api/cad/projects/{generated_id}/export").content)) as archive:
        exported = {Path(name).stem: json.loads(archive.read(name)) for name in archive.namelist()}
    for name in ("scene", "catalog", "planograms", "materials", "settings", "textures", "project"):
        assert exported[name] == pm.load_project_file(generated_id, f"{name}.json")
    assert exported["project"]["id"] == generated_id
    assert exported["scene"]["store"]["walls"]
    assert exported["scene"]["furniture"]
    assert len(exported["catalog"]["products"]) > 2000
    assert exported["planograms"]["planograms"]
    assert any(item["cells"] for item in exported["planograms"]["planograms"])
    assert exported["settings"]
    template_id = {"City": "carrefour_city", "Express": "carrefour_express",
                   "Express aéroport": "carrefour_express_aeroport"}[model]
    reference = assistant.load_reference_snapshot(template_id)
    for name in ("catalog", "materials", "settings", "textures"):
        assert exported[name] == reference[name]
    reloaded = client.get(f"/api/cad/projects/{generated_id}/scene")
    assert reloaded.status_code == 200, reloaded.text
    assert len(reloaded.json()["furniture"]) == len(exported["scene"]["furniture"])
    saved = client.put(f"/api/cad/projects/{generated_id}/snapshot", json={
        "scene": reloaded.json(), "simulation": exported["settings"]["simulation"],
    })
    assert saved.status_code == 200, saved.text
    audit = _ask(client, generated_id, "vérifie")
    assert not audit["changed"]
    assert "0 anomalie(s)" in audit["message"]
    assert not audit["steps"]


@pytest.mark.parametrize("prompt", [
    "implantation seule",
    "Crée une implantation seule Carrefour Express",
    "Crée une implantation Carrefour City sans produits",
])
def test_layout_only_has_no_products_or_dangling_faces(studio, prompt):
    client, project_id = studio
    assert _ask(client, project_id, prompt)["requiresConfirmation"]
    result = _ask(client, project_id, prompt, confirm=True)
    assert result["changed"]
    generated_id = result["projectId"]
    assert pm.load_project_file(generated_id, "scene.json")["furniture"]
    assert pm.load_project_file(generated_id, "catalog.json") == {"products": []}
    assert pm.load_project_file(generated_id, "planograms.json") == {"planograms": []}
    assert all(not item["faces"] for item in pm.load_project_file(generated_id, "scene.json")["furniture"])


def test_unsupported_custom_commands_never_report_success(studio):
    client, project_id = studio
    before = client.get("/api/cad/projects/").json()
    for prompt in ("Ajoute 300 produits biologiques", "Supprime tout",
                   "Crée une implantation complète Carrefour Express et double sa surface",
                   "Crée une implantation complète Auchan", "Crée une implantation complète sans produits",
                   "Crée une implantation complète Carrefour ../../secrets"):
        result = _ask(client, project_id, prompt, confirm=True)
        assert not result["changed"] and not result["requiresConfirmation"]
        assert "non prise en charge" in result["message"]
    assert client.get("/api/cad/projects/").json() == before


def test_save_reloads_actual_persisted_state_and_audit_reports_issues(studio):
    client, project_id = studio
    scene = pm.load_project_file(project_id, "scene.json")
    scene["store"]["dimensions"]["width"] = -1
    pm.save_project_file(project_id, "scene.json", scene)
    metadata_before = pm.get_project_metadata(project_id)
    result = _ask(client, project_id, "enregistre")
    assert not result["changed"] and not result["requiresConfirmation"]
    assert result["projectId"] == project_id
    assert "0 meubles" in result["message"]
    assert f"{len(pm.load_project_file(project_id, 'catalog.json')['products'])} produits" in result["message"]
    assert metadata_before["updatedAt"] in result["message"]
    assert "non transmises" in result["message"]
    assert pm.get_project_metadata(project_id) == metadata_before
    audit = _ask(client, project_id, "vérifie")
    assert audit["steps"] and not audit["changed"]
    (pm.STORAGE_ROOT / project_id / "settings.json").unlink()
    assert "incomplet" in _ask(client, project_id, "enregistre")["message"]


def test_authentication_and_tenant_access_are_required(studio):
    from main import app

    client, project_id = studio
    result = _ask(client, project_id, "implantation seule", confirm=True)
    with TestClient(app) as outsider:
        for target_id in (project_id, result["projectId"]):
            response = outsider.post(f"/api/cad/projects/{target_id}/assistant", json={"prompt": "enregistre"})
            assert response.status_code == 401
        _register(outsider, "Other tenant")
        for target_id in (project_id, result["projectId"]):
            for prompt in ("enregistre", "vérifie", "implantation seule"):
                response = outsider.post(f"/api/cad/projects/{target_id}/assistant",
                                          json={"prompt": prompt, "confirm": True})
                assert response.status_code == 403


@pytest.mark.parametrize("payload", [
    {"prompt": ""}, {"prompt": "   "}, {"prompt": "a" * 2001},
    {"prompt": 123}, {"prompt": "enregistre", "confirm": "yes"},
    {"prompt": "enregistre", "template": "../other"},
])
def test_prompt_is_bounded_and_strictly_validated(studio, payload):
    client, project_id = studio
    response = client.post(f"/api/cad/projects/{project_id}/assistant", json=payload)
    assert response.status_code == 422


def test_mutable_runtime_projects_are_not_used_as_templates(studio):
    client, project_id = studio
    pm.create_project("carrefour_express_aeroport", "Unrelated mutable tenant content")
    result = _ask(client, project_id, "implantation seule", confirm=True)
    assert result["changed"]
    assert len(pm.load_project_file(result["projectId"], "scene.json")["furniture"]) == 29


def test_modified_reference_is_rejected_before_creation(studio, workspace, monkeypatch):
    client, project_id = studio
    template = "carrefour_express_aeroport"
    references = workspace / "references"
    shutil.copytree(reference_templates._TEMPLATE_ROOT / template, references / template)
    (references / template / "scene.json").write_text('{"private":"other tenant"}', encoding="utf-8")
    monkeypatch.setattr(reference_templates, "_TEMPLATE_ROOT", references)
    before = client.get("/api/cad/projects/").json()
    result = _ask(client, project_id, "implantation seule", confirm=True)
    assert not result["changed"] and not result["requiresConfirmation"]
    assert "modifié" in result["message"]
    assert client.get("/api/cad/projects/").json() == before


def test_failed_template_audit_never_creates_a_project(studio, monkeypatch):
    client, project_id = studio
    monkeypatch.setattr(assistant, "_audit", lambda *args: {"ok": False, "issueCount": 1})
    before = client.get("/api/cad/projects/").json()
    result = _ask(client, project_id, "implantation seule", confirm=True)
    assert not result["changed"] and not result["requiresConfirmation"]
    assert "refusé par l'audit" in result["message"]
    assert client.get("/api/cad/projects/").json() == before


def test_snapshot_persists_editor_scene_and_simulation_preserving_other_data(studio):
    client, project_id = studio
    original_catalog = pm.load_project_file(project_id, "catalog.json")
    original_planograms = pm.load_project_file(project_id, "planograms.json")
    settings = pm.load_project_file(project_id, "settings.json")
    settings["gridSize"] = 75
    pm.save_project_file(project_id, "settings.json", settings)
    scene = pm.load_project_file(project_id, "scene.json")
    scene["store"]["name"] = "Saved from editor"
    scene["store"]["dimensions"]["width"] = 2700
    simulation = {**settings["simulation"], "maxCustomers": 17, "durationSeconds": 45}
    response = client.put(f"/api/cad/projects/{project_id}/snapshot", json={
        "scene": scene, "simulation": simulation,
    })
    assert response.status_code == 200, response.text
    assert response.json()["saved"] is True
    assert response.json()["projectId"] == project_id
    assert response.json()["updatedAt"] == pm.get_project_metadata(project_id)["updatedAt"]
    persisted_scene = client.get(f"/api/cad/projects/{project_id}/scene").json()
    assert persisted_scene["store"]["name"] == "Saved from editor"
    assert persisted_scene["store"]["dimensions"]["width"] == 2700
    persisted_settings = client.get(f"/api/cad/projects/{project_id}/settings").json()
    assert persisted_settings["simulation"] == simulation
    assert persisted_settings["gridSize"] == 75
    assert pm.load_project_file(project_id, "catalog.json") == original_catalog
    assert pm.load_project_file(project_id, "planograms.json") == original_planograms


@pytest.mark.parametrize("invalid", ["store", "bounds", "overlap", "duplicate", "size", "nonfinite"])
def test_invalid_snapshot_is_rejected_before_any_write(studio, invalid):
    client, project_id = studio
    scene = pm.load_project_file(project_id, "scene.json")
    furniture = {
        "id": "shelf", "name": "Shelf", "libraryId": "gondola_double", "type": "gondola_double",
        "position": [100, 0, 100], "rotation": [0, 0, 0],
        "dimensions": {"width": 100, "depth": 80, "height": 200},
    }
    scene["furniture"] = [furniture]
    if invalid == "store":
        scene["store"]["dimensions"]["depth"] = 0
    elif invalid == "bounds":
        furniture["position"][0] = -100
    elif invalid == "overlap":
        scene["furniture"].append({**furniture, "id": "other"})
    elif invalid == "duplicate":
        scene["furniture"].append({**furniture, "position": [1000, 0, 100]})
    elif invalid == "size":
        furniture["dimensions"]["width"] = -100
    else:
        furniture["position"][0] = "NaN"
    before = client.get(f"/api/cad/projects/{project_id}/export").content
    response = client.put(f"/api/cad/projects/{project_id}/snapshot", json={
        "scene": scene, "simulation": {"maxCustomers": 13},
    })
    assert response.status_code in (409, 422), response.text
    assert client.get(f"/api/cad/projects/{project_id}/export").content == before


def test_snapshot_does_not_orphan_planograms(studio):
    client, project_id = studio
    generated = _ask(client, project_id, "implantation complète", confirm=True)["projectId"]
    scene = pm.load_project_file(generated, "scene.json")
    scene["furniture"] = []
    before = pm.load_project_file(generated, "scene.json")
    response = client.put(f"/api/cad/projects/{generated}/snapshot", json={"scene": scene, "simulation": {}})
    assert response.status_code == 422
    assert "orphan" in response.json()["detail"]
    assert pm.load_project_file(generated, "scene.json") == before


def test_snapshot_requires_authentication_and_tenant_ownership(studio):
    from main import app

    client, project_id = studio
    payload = {"scene": pm.load_project_file(project_id, "scene.json"), "simulation": {}}
    with TestClient(app) as outsider:
        response = outsider.put(f"/api/cad/projects/{project_id}/snapshot", json=payload)
        assert response.status_code == 401
        _register(outsider, "Other tenant")
        response = outsider.put(f"/api/cad/projects/{project_id}/snapshot", json=payload)
        assert response.status_code == 403


def test_canonical_template_ids_reject_public_mutations(studio):
    from main import app

    client, _ = studio
    with TestClient(app) as anonymous:
        for actor in (client, anonymous):
            for template_id in reference_templates.REFERENCE_PROJECT_IDS:
                response = actor.delete(f"/api/cad/projects/{template_id}")
                assert response.status_code == 403
                response = actor.put(f"/api/cad/projects/{template_id}/scene/store", json={"name": "Mutated"})
                assert response.status_code == 403
                response = actor.put(f"/api/cad/projects/{template_id}/settings", json={"gridSize": 1})
                assert response.status_code == 403
