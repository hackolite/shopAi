"""Shipped reference assets, separate from mutable tenant project storage."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from models.project import Catalog

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
    rows = json.loads(_ASSORTMENT_PATH.read_text(encoding="utf-8"))
    products = []
    for row in rows:
        quantity = str(row.get("quantity") or "")
        match = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*(kg|g)\s*", quantity, re.IGNORECASE)
        weight = float(match[1].replace(",", ".")) * (1000 if match[2].lower() == "kg" else 1) if match else 0
        products.append({
            "ean": str(row["barcode"]),
            "name": row["product_name"],
            "brand": row.get("brand") or "",
            "category": row.get("category_name") or "",
            "subcategory": row.get("subcategory_name"),
            "format": quantity or None,
            "productRange": "MDD" if row.get("is_mdd") else None,
            # The source does not provide packaging dimensions.
            "widthCm": 10,
            "depthCm": 10,
            "heightCm": 20,
            "weightG": weight,
            "imageUrl": row.get("image_url") or None,
            "priceBuyEur": row.get("cost_price_eur"),
            "priceSellEur": row.get("suggested_price_eur"),
            "marginPct": row.get("margin_rate_pct"),
        })
    return Catalog.model_validate({"products": products}).model_dump(mode="json")


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
