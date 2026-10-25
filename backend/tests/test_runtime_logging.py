from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi.testclient import TestClient

from services import platform_service, project_manager, reference_templates
from services.runtime_logging import configure_file_logging


def test_registration_failure_is_logged_and_login_recovers(tmp_path, monkeypatch):
    from main import app

    monkeypatch.setattr(project_manager, "STORAGE_ROOT", tmp_path / "projects")
    monkeypatch.setenv("SHOPAI_LOG_DIR", str(tmp_path / "logs"))
    original_assortment = reference_templates._ASSORTMENT_PATH
    missing_assortment = tmp_path / "missing-assortment.json"
    monkeypatch.setattr(reference_templates, "_ASSORTMENT_PATH", missing_assortment)
    root = logging.getLogger()
    previous_level = root.level
    previous_handlers = set(root.handlers)
    log_path = configure_file_logging()
    assert log_path == tmp_path / "logs" / "backend.log"
    try:
        configure_file_logging()
        handlers = [
            handler for handler in root.handlers
            if isinstance(handler, RotatingFileHandler)
            and handler.baseFilename == str(log_path)
        ]
        assert len(handlers) == 1
        assert handlers[0].maxBytes == 5 * 1024 * 1024
        assert handlers[0].backupCount == 3

        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/platform/auth/register",
            json={"name": "Windows User", "email": "windows@example.com", "password": "private-password"},
        )
        assert response.status_code == 500
        text = log_path.read_text(encoding="utf-8")
        assert "Account defaults failed" in text
        assert "POST /api/platform/auth/register" in text
        assert "Traceback" in text
        assert "FileNotFoundError" in text
        assert str(missing_assortment) in text
        assert "private-password" not in text
        assert "windows@example.com" not in text
        assert platform_service.count_users() == 1

        monkeypatch.setattr(reference_templates, "_ASSORTMENT_PATH", original_assortment)
        response = client.post(
            "/api/platform/auth/login",
            json={"email": "windows@example.com", "password": "private-password"},
        )
        assert response.status_code == 200, response.text
        assert "Account defaults ready" in log_path.read_text(encoding="utf-8")
        dashboard = client.get("/api/platform/dashboard")
        assert dashboard.status_code == 200
        assert dashboard.json()["stats"]["projectCount"] == 5
    finally:
        for handler in set(root.handlers) - previous_handlers:
            root.removeHandler(handler)
            logging.getLogger("uvicorn").removeHandler(handler)
            handler.close()
        root.setLevel(previous_level)


def test_windows_installer_includes_default_assortment():
    repository = Path(__file__).resolve().parents[2]
    installer = (repository / "installer" / "windows" / "ShopAI.iss").read_text()
    assert 'Source: "..\\..\\assortment.json"; DestDir: "{app}"' in installer
    assert (repository / "assortment.json").is_file()
