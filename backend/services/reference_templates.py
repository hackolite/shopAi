"""Shipped reference assets, separate from mutable tenant project storage."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from services.catalog_import import parse_catalog_json

REFERENCE_PROJECT_IDS = (
    "carrefour_city",
    "carrefour_express",
    "carrefour_express_aeroport",
)
REFERENCE_PROJECT_NAMES = {
    "carrefour_city": "Carrefour City",
    "carrefour_express": "Carrefour Express",
    "carrefour_express_aeroport": "Carrefour Express aeroport",
}
_TEMPLATE_ROOT = Path(__file__).resolve().parent.parent / "storage" / "templates"
_ASSORTMENT_PATH = Path(__file__).resolve().parents[2] / "assortment.json"


def load_default_assortment() -> dict[str, Any]:
    """Normalize the supplied Carrefour assortment into the CAD catalog schema."""
    return parse_catalog_json(_ASSORTMENT_PATH.read_text(encoding="utf-8")).model_dump(mode="json")


def build_demo_pedestrian_dataset() -> dict[str, Any]:
    """Build a small, deterministic pseudo piéton/panier dataset for demo purposes.

    Baskets reference a handful of EANs from the default assortment; positions
    are left unresolved (``found=False``) since this dataset is not tied to
    any particular store scene — resolving shelf positions happens when the
    dataset is loaded into a project via ``pickup_planning``.
    """
    assortment = load_default_assortment()
    sample_products = assortment["products"][:20]
    baskets = [
        sample_products[0:2],
        sample_products[2:5],
        sample_products[5:6],
        sample_products[6:9],
        sample_products[9:11],
    ]
    base_ts = 1_700_000_000
    plans = []
    for index, basket in enumerate(baskets):
        items = [
            {
                "ean": product["ean"],
                "name": product["name"],
                "found": False,
                "reasonNotFound": "Dataset de démonstration : position non résolue",
                "xCm": None,
                "zCm": None,
                "pickupDurationSeconds": None,
            }
            for product in basket
        ]
        plans.append({
            "pedestrianId": index + 1,
            "startUnixTs": base_ts + index * 90,
            "speedMps": 1.1 + (index % 3) * 0.15,
            "profile": {"label": "Client démonstration"},
            "items": items,
        })
    return {
        "pedestrianCount": len(plans),
        "rowCount": len(plans),
        "plans": plans,
        "anomalies": [],
    }


def load_reference_template(template_id: str, *, layout_only: bool = False) -> dict[str, Any]:
    """Return a fresh snapshot; never read templates from mutable STORAGE_ROOT."""
    if template_id not in REFERENCE_PROJECT_IDS:
        raise HTTPException(status_code=400, detail="Unknown reference template")
    directory = _TEMPLATE_ROOT / template_id
    snapshot = {
        key: json.loads((directory / f"{key}.json").read_text(encoding="utf-8"))
        for key in ("scene", "catalog", "planograms", "settings", "materials", "textures")
    }
    snapshot["planograms"] = snapshot["planograms"]["planograms"]
    if layout_only:
        for furniture in snapshot["scene"]["furniture"]:
            furniture["faces"] = {face: None for face in (furniture.get("faces") or {})}
        snapshot["planograms"] = []
        snapshot["catalog"] = load_default_assortment()
    return snapshot
