from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from .config import Settings
from .schemas import OrchestrationPlan


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
        max_retries = retries if retries is not None else self.settings.max_retries
        url = f"{self.settings.backend_base_url}{path}"
        headers: dict[str, str] = {"Accept": "application/json"}
        if self.session_cookie:
            headers["X-ShopAI-Session"] = self.session_cookie

        last_error: BackendApiError | None = None
        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
                    response = await client.request(method, url, json=payload, headers=headers)
                if response.status_code < 400:
                    if not response.text.strip():
                        return None
                    return response.json()

                detail = response.text
                try:
                    detail = str(response.json().get("detail", detail))
                except ValueError:
                    pass
                error = BackendApiError(response.status_code, detail, method, path)

                if response.status_code in {409, 422}:
                    raise error
                if response.status_code >= 500 and attempt < max_retries - 1:
                    continue
                raise error
            except httpx.HTTPError as exc:
                if attempt == max_retries - 1:
                    raise BackendApiError(502, f"Backend unreachable: {exc}", method, path) from exc
            except BackendApiError as exc:
                last_error = exc
                if exc.status_code in {409, 422}:
                    raise
                if attempt == max_retries - 1:
                    raise
        if last_error:
            raise last_error
        raise BackendApiError(500, "Unknown backend error", method, path)

    async def health_check(self) -> Any:
        return await self._request("GET", "/")

    async def create_project(self, name: str) -> dict[str, Any]:
        payload = {"name": (name or "Magasin IA")[:120]}
        try:
            return await self._request("POST", "/api/cad/projects/", payload)
        except BackendApiError as exc:
            if exc.status_code == 422:
                payload["name"] = "Magasin IA"
                return await self._request("POST", "/api/cad/projects/", payload)
            raise

    async def get_furniture_library(self) -> dict[str, Any]:
        return await self._request("GET", "/api/furniture-library/")

    async def set_store_dimensions(self, project_id: str, project_name: str, store: dict[str, float]) -> dict[str, Any]:
        corrected = {
            "width": max(200.0, float(store.get("width", 3000.0))),
            "depth": max(200.0, float(store.get("depth", 2000.0))),
            "height": max(200.0, float(store.get("height", 400.0))),
        }
        payload = {"name": project_name or "Magasin IA", "dimensions": corrected}
        try:
            return await self._request("PUT", f"/api/cad/projects/{project_id}/scene/store", payload)
        except BackendApiError as exc:
            if exc.status_code == 422:
                payload["dimensions"] = {"width": 3000.0, "depth": 2000.0, "height": 400.0}
                return await self._request("PUT", f"/api/cad/projects/{project_id}/scene/store", payload)
            raise

    async def place_furniture(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = dict(payload)
        data.setdefault("id", str(uuid4()))
        data["position"] = [float(v) for v in data.get("position", [0.0, 0.0, 0.0])]
        data["rotation"] = [float(v) for v in data.get("rotation", [0.0, 0.0, 0.0])]
        dimensions = data.get("dimensions") or {}
        data["dimensions"] = {
            "width": max(10.0, float(dimensions.get("width", 100.0))),
            "depth": max(10.0, float(dimensions.get("depth", 50.0))),
            "height": max(10.0, float(dimensions.get("height", 100.0))),
        }

        offset = self.settings.collision_offset_cm
        for attempt in range(self.settings.collision_max_retries):
            try:
                return await self._request("POST", f"/api/cad/projects/{project_id}/scene/furniture", data)
            except BackendApiError as exc:
                if exc.status_code == 409:
                    data["position"][0] += offset
                    data["position"][2] += offset if attempt % 2 else 0.0
                    continue
                if exc.status_code == 422:
                    data["name"] = str(data.get("name") or "Mobilier")[:120]
                    continue
                raise
        raise BackendApiError(409, "Unable to place furniture without overlap after retries", "POST", "scene/furniture")

    async def import_catalog(self, project_id: str, products: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {"products": products, "merge": False}
        try:
            return await self._request("POST", f"/api/cad/projects/{project_id}/catalog/import", payload)
        except BackendApiError as exc:
            if exc.status_code == 422:
                payload["products"] = products[:100]
                return await self._request("POST", f"/api/cad/projects/{project_id}/catalog/import", payload)
            raise

    async def create_planogram(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self._request("POST", f"/api/cad/projects/{project_id}/planograms", payload)
        except BackendApiError as exc:
            if exc.status_code == 422:
                payload["rows"] = max(1, int(payload.get("rows", 4)))
                payload["cols"] = max(1, int(payload.get("cols", 6)))
                return await self._request("POST", f"/api/cad/projects/{project_id}/planograms", payload)
            raise

    async def export_retail_layout(self, project_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/cad/projects/{project_id}/export/retail-layout")

    def plan_layout(self, library: dict[str, dict[str, Any]], plan: OrchestrationPlan) -> list[dict[str, Any]]:
        width = float(plan.store.width)
        depth = float(plan.store.depth)
        wall_margin = 100.0
        aisle_gap = 180.0

        instances: list[dict[str, Any]] = []

        def add(def_id: str, name: str, x: float, z: float, rotation_y: float = 0.0) -> None:
            definition = library[def_id]
            dims = definition["defaultDimensions"]
            instances.append(
                {
                    "id": str(uuid4()),
                    "name": name,
                    "type": definition["type"],
                    "libraryId": definition["id"],
                    "position": [x, 0.0, z],
                    "rotation": [0.0, rotation_y, 0.0],
                    "dimensions": {
                        "width": float(dims["width"]),
                        "depth": float(dims["depth"]),
                        "height": float(dims["height"]),
                    },
                    "materialId": definition.get("defaultMaterial"),
                }
            )

        if "fridge" in library:
            fridge = library["fridge"]["defaultDimensions"]
            fridge_z = depth - wall_margin - float(fridge["depth"])
            x = wall_margin
            for index in range(4):
                add("fridge", f"Frigo frais {index + 1}", x, fridge_z)
                x += float(fridge["width"]) + 20.0

        if "gondola_double" in library:
            gondola = library["gondola_double"]["defaultDimensions"]
            row_z = wall_margin + 300.0
            for row in range(3):
                x = wall_margin + 200.0
                for col in range(4):
                    add("gondola_double", f"Gondole A{row + 1}-{col + 1}", x, row_z)
                    x += float(gondola["width"]) + 40.0
                row_z += float(gondola["depth"]) + aisle_gap

        if "gondola_single" in library:
            single = library["gondola_single"]["defaultDimensions"]
            z = wall_margin + 300.0
            for index in range(3):
                add("gondola_single", f"Rayon mural {index + 1}", 20.0, z)
                z += float(single["width"]) + 50.0

        if "register" in library:
            register = library["register"]["defaultDimensions"]
            x = width - wall_margin - 3 * (float(register["width"]) + 80.0)
            for index in range(3):
                add("register", f"Caisse {index + 1}", x, wall_margin)
                x += float(register["width"]) + 80.0

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
                products.append(
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
                )
                if len(products) >= max_products:
                    break

        if products:
            return products

        fallback: list[dict[str, Any]] = []
        for index in range(max_products):
            fallback.append(
                {
                    "ean": f"999000{index:06d}",
                    "name": f"Produit IA {index + 1}",
                    "brand": "ShopAI",
                    "category": "misc",
                    "subcategory": None,
                    "widthCm": 10.0,
                    "depthCm": 8.0,
                    "heightCm": 20.0,
                    "weightG": 500.0,
                }
            )
        return fallback

    def build_planograms(
        self,
        placed_furniture: list[dict[str, Any]],
        products: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
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
