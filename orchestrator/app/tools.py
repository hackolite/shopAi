from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from .config import Settings
from .schemas import OrchestrationPlan, ProductSpec

_log = logging.getLogger("uvicorn.error.shopai.tools")


_FACEABLE_TYPES = {
    "gondola_single": ["front"],
    "gondola_double": ["front", "back"],
    "fridge": ["front"],
}


@dataclass
class BackendApiError(Exception):
    status_code: int
    detail: str
    method: str
    path: str

    def __str__(self) -> str:
        return f"{self.method} {self.path} -> HTTP {self.status_code}: {self.detail}"


class BackendTools:
    def __init__(self, settings: Settings, session_cookie: str | None = None) -> None:
        self.settings = settings
        self.session_cookie = session_cookie

    async def _request(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        retries: int | None = None,
    ) -> Any:
        if not self.session_cookie or not self.session_cookie.strip():
            raise BackendApiError(401, "ShopAI session is required", method, path)
        max_retries = max(1, retries if retries is not None else self.settings.max_retries) if method == "GET" else 1
        url = f"{self.settings.backend_base_url}{path}"
        headers: dict[str, str] = {"Accept": "application/json"}
        headers["X-ShopAI-Session"] = self.session_cookie

        for attempt in range(max_retries):
            started = time.monotonic()
            _log.info("Backend callback started method=%s attempt=%d", method, attempt + 1)
            try:
                async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
                    response = await client.request(method, url, json=payload, headers=headers)
                _log.info(
                    "Backend callback completed method=%s status=%d duration_ms=%.0f",
                    method, response.status_code, (time.monotonic() - started) * 1000,
                )
                if response.status_code < 400:
                    if not response.text.strip():
                        return None
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise BackendApiError(502, "Invalid backend JSON response", method, path) from exc

                _log.warning("Backend callback rejected method=%s status=%d", method, response.status_code)
                error = BackendApiError(response.status_code, "Backend request rejected", method, path)

                if response.status_code >= 500 and attempt < max_retries - 1:
                    continue
                raise error
            except httpx.HTTPError as exc:
                _log.warning(
                    "Backend callback transport failure method=%s error_class=%s duration_ms=%.0f",
                    method, type(exc).__name__, (time.monotonic() - started) * 1000,
                )
                if attempt == max_retries - 1:
                    raise BackendApiError(502, "Backend unreachable", method, path) from exc
        raise BackendApiError(500, "Unknown backend error", method, path)

    async def health_check(self) -> Any:
        return await self._request("GET", "/")

    async def create_project(self, name: str) -> dict[str, Any]:
        payload = {"name": (name or "Magasin IA")[:120]}
        return await self._request("POST", "/api/cad/projects/", payload)

    async def get_furniture_library(self) -> dict[str, Any]:
        return await self._request("GET", "/api/furniture-library/")

    async def set_store_dimensions(self, project_id: str, project_name: str, store: dict[str, float]) -> dict[str, Any]:
        payload = {"name": project_name, "dimensions": store}
        return await self._request("PUT", f"/api/cad/projects/{project_id}/scene/store", payload)

    async def place_furniture(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", f"/api/cad/projects/{project_id}/scene/furniture", payload)

    async def import_catalog(self, project_id: str, products: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._request("POST", f"/api/cad/projects/{project_id}/catalog/import", {"products": products, "merge": True})

    async def create_planogram(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", f"/api/cad/projects/{project_id}/planograms", payload)

    async def export_retail_layout(self, project_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/cad/projects/{project_id}/export/retail-layout")

    def plan_layout(self, library: dict[str, dict[str, Any]], plan: OrchestrationPlan) -> list[dict[str, Any]]:
        if plan.store is None:
            raise ValueError("Store dimensions are required for layout generation")
        width, depth = plan.store.width, plan.store.depth
        instances: list[dict[str, Any]] = []
        x, z, row_depth = 100.0, 100.0, 0.0
        for definition_id, count in [("register", 2), ("gondola_double", 12), ("gondola_single", 3), ("fridge", 4)]:
            definition = library.get(definition_id)
            if not definition:
                continue
            dims = definition["defaultDimensions"]
            if not all(math.isfinite(float(v)) and float(v) > 0 for v in dims.values()):
                raise ValueError("Invalid furniture library dimensions")
            for index in range(count):
                if x + dims["width"] > width - 100:
                    x, z, row_depth = 100.0, z + row_depth + 180.0, 0.0
                if x + dims["width"] > width - 100 or z + dims["depth"] > depth - 100 or dims["height"] > plan.store.height:
                    break
                instances.append({
                    "id": str(uuid4()), "name": f"{definition['name']} {index + 1}",
                    "type": definition["type"], "libraryId": definition["id"],
                    "position": [x, 0.0, z], "rotation": [0.0, 0.0, 0.0],
                    "dimensions": dict(dims), "materialId": definition.get("defaultMaterial"),
                })
                x += dims["width"] + 100.0
                row_depth = max(row_depth, dims["depth"])
        if not instances:
            raise ValueError("Aucun mobilier ne peut être placé dans les dimensions demandées.")
        return instances

    def load_products(self, max_products: int) -> list[dict[str, Any]]:
        catalog_path = self.settings.catalog_json_path
        if catalog_path:
            path = Path(catalog_path)
        else:
            path = Path(__file__).resolve().parents[2] / "assortment.json"

        products: list[dict[str, Any]] = []
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                raw = raw.get("products", [])
            for item in raw:
                ean = str(item.get("barcode") or item.get("ean") or "").strip()
                name = str(item.get("product_name") or item.get("name") or "").strip()
                if not ean or not name:
                    continue
                products.append(ProductSpec.model_validate(
                    {
                        "ean": ean,
                        "name": name,
                        "brand": str(item.get("brand") or "N/A"),
                        "category": str(item.get("category_id") or item.get("category") or "misc"),
                        "subcategory": item.get("subcategory_id"),
                        "widthCm": 10.0,
                        "depthCm": 8.0,
                        "heightCm": 20.0,
                        "weightG": 500.0,
                        "imageUrl": item.get("image_url"),
                        "priceBuyEur": item.get("cost_price_eur"),
                        "priceSellEur": item.get("suggested_price_eur"),
                        "marginPct": item.get("margin_rate_pct"),
                    }
                ).model_dump())
                if len(products) >= max_products:
                    break

        if products:
            return products

        raise ValueError("Aucun produit disponible dans le catalogue local; fournis un catalogue réel.")

    def build_planograms(
        self,
        placed_furniture: list[dict[str, Any]],
        products: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        if not products:
            raise ValueError("Un catalogue non vide est requis.")
        cursor = 0
        for furniture in placed_furniture:
            for face in _FACEABLE_TYPES.get(furniture.get("type"), []):
                rows, cols = 4, 6
                cells: list[dict[str, Any]] = []
                for row in range(rows):
                    for col in range(cols):
                        product = products[cursor % len(products)]
                        cursor += 1
                        cells.append({"ean": product["ean"], "row": row, "col": col})

                dims = furniture["dimensions"]
                payloads.append(
                    {
                        "name": f"{furniture['name']} — {face}",
                        "furnitureId": furniture["id"],
                        "face": face,
                        "rows": rows,
                        "cols": cols,
                        "widthCm": float(dims["width"]),
                        "heightCm": float(dims["height"]),
                        "cells": cells,
                    }
                )
        return payloads
