from __future__ import annotations

from fastapi import HTTPException

from services.demo_generator import generate_retail_cad_demo
from services.project_manager import create_project, get_project_metadata, save_project_file


_DEMO_PROJECT_ID = "retail_cad"
_DEMO_PROJECT_NAME = "Retail CAD Demo"


def init_retail_cad_demo() -> None:
    try:
        get_project_metadata(_DEMO_PROJECT_ID)
        return
    except HTTPException as exc:
        if exc.status_code != 404:
            raise

    demo = generate_retail_cad_demo()
    create_project(_DEMO_PROJECT_ID, _DEMO_PROJECT_NAME)
    save_project_file(_DEMO_PROJECT_ID, "scene.json", demo["scene"])
    save_project_file(_DEMO_PROJECT_ID, "catalog.json", demo["catalog"])
    save_project_file(_DEMO_PROJECT_ID, "planograms.json", demo["planograms"])
    save_project_file(_DEMO_PROJECT_ID, "materials.json", demo["materials"])
