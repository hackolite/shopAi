from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from api.cad_projects import router as cad_router
from api.furniture_library import router as furniture_router
from services import project_manager as pm


@pytest.fixture(params=[False, True], ids=["development", "compiled"])
def compiled_frontend(request: pytest.FixtureRequest) -> bool:
    return request.param


@pytest.fixture
def client(compiled_frontend: bool, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(pm, "STORAGE_ROOT", tmp_path / "projects")
    app = FastAPI()
    app.include_router(cad_router)
    app.include_router(furniture_router)
    if compiled_frontend:
        frontend = tmp_path / "dist"
        frontend.mkdir()
        (frontend / "index.html").write_text("<html>ShopAI</html>", encoding="utf-8")
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    with TestClient(app, follow_redirects=False) as test_client:
        yield test_client


@pytest.mark.parametrize("suffix", ["", "/"])
def test_create_and_list_projects(client: TestClient, suffix: str) -> None:
    url = f"/api/cad/projects{suffix}"
    response = client.post(url, json={"name": "Compiled project"})
    assert response.status_code == 200, response.text
    project_id = response.json()["id"]
    assert pm.load_project_file(project_id, "project.json")["name"] == "Compiled project"

    response = client.get(url)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "projects": [{"id": project_id, "name": "Compiled project"}],
    }
    response = client.get(f"/api/cad/projects/{project_id}")
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Compiled project"


@pytest.mark.parametrize("suffix", ["", "/"])
def test_list_furniture(client: TestClient, suffix: str) -> None:
    response = client.get(f"/api/furniture-library{suffix}")
    assert response.status_code == 200, response.text
    assert response.json()["furniture"]


def test_frontend_index(client: TestClient, compiled_frontend: bool) -> None:
    response = client.get("/")
    assert response.status_code == (200 if compiled_frontend else 404), response.text
    if compiled_frontend:
        assert response.text == "<html>ShopAI</html>"
