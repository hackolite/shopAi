"""Parse product catalog imports into a :class:`~models.project.Catalog`.

Expected columns: ``ean, name, brand, category, widthCm, depthCm, heightCm,
weightG`` (required) plus optional ``subcategory, productRange, format,
description, imageUrl, priceBuyEur, marginPct, priceSellEur``. One row per
product.
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

from fastapi import HTTPException

from models.project import Catalog, Product

_REQUIRED_COLUMNS = {"ean", "name", "brand", "category", "widthCm", "depthCm", "heightCm", "weightG"}
_NUMERIC_COLUMNS = {"widthCm", "depthCm", "heightCm", "weightG"}
_OPTIONAL_NUMERIC_COLUMNS = {"priceBuyEur", "marginPct", "priceSellEur"}


def _catalog_from_assortment_rows(rows: list[dict[str, Any]]) -> Catalog:
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
            "widthCm": 10,
            "depthCm": 10,
            "heightCm": 20,
            "weightG": weight,
            "imageUrl": row.get("image_url") or None,
            "priceBuyEur": row.get("cost_price_eur"),
            "priceSellEur": row.get("suggested_price_eur"),
            "marginPct": row.get("margin_rate_pct"),
        })
    return Catalog.model_validate({"products": products})


def parse_catalog_csv(csv_text: str) -> Catalog:
    reader = csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames:
        raise HTTPException(status_code=422, detail="Empty CSV file")

    missing = _REQUIRED_COLUMNS - set(reader.fieldnames)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Missing required columns: {', '.join(sorted(missing))}",
        )

    products: list[Product] = []
    for row_index, row in enumerate(reader, start=2):
        ean = (row.get("ean") or "").strip()
        name = (row.get("name") or "").strip()
        if not ean or not name:
            continue

        cleaned: dict[str, Any] = {"ean": ean, "name": name}
        for key in ("brand", "category", "subcategory", "productRange", "format", "description", "imageUrl"):
            value = (row.get(key) or "").strip()
            cleaned[key] = value or None
        cleaned["brand"] = cleaned["brand"] or ""
        cleaned["category"] = cleaned["category"] or ""

        for key in _NUMERIC_COLUMNS:
            raw_value = (row.get(key) or "").strip()
            try:
                cleaned[key] = float(raw_value) if raw_value else 0.0
            except ValueError as exc:
                raise HTTPException(
                    status_code=422, detail=f"Row {row_index}: invalid number for '{key}'"
                ) from exc

        for key in _OPTIONAL_NUMERIC_COLUMNS:
            raw_value = (row.get(key) or "").strip()
            if not raw_value:
                cleaned[key] = None
                continue
            try:
                cleaned[key] = float(raw_value)
            except ValueError as exc:
                raise HTTPException(
                    status_code=422, detail=f"Row {row_index}: invalid number for '{key}'"
                ) from exc

        try:
            products.append(Product.model_validate(cleaned))
        except Exception as exc:  # noqa: BLE001 - surface pydantic error as HTTP 422
            raise HTTPException(status_code=422, detail=f"Row {row_index}: {exc}") from exc

    return Catalog(products=products)


def parse_catalog_json(json_text: str) -> Catalog:
    try:
        data = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON file: {exc}") from exc

    if isinstance(data, dict):
        products = data.get("products")
        if not isinstance(products, list):
            raise HTTPException(status_code=422, detail='JSON object must contain a "products" array')
        try:
            return Catalog.model_validate({"products": products})
        except Exception as exc:  # noqa: BLE001 - surface pydantic error as HTTP 422
            raise HTTPException(status_code=422, detail=f"Invalid catalog JSON: {exc}") from exc

    if not isinstance(data, list):
        raise HTTPException(status_code=422, detail="JSON root must be an array or an object with 'products'")

    if not data:
        return Catalog(products=[])

    if all(isinstance(item, dict) and ("barcode" in item or "product_name" in item) for item in data):
        try:
            return _catalog_from_assortment_rows(data)
        except KeyError as exc:
            raise HTTPException(status_code=422, detail=f"Missing assortment field: {exc.args[0]}") from exc

    try:
        return Catalog.model_validate({"products": data})
    except Exception as exc:  # noqa: BLE001 - surface pydantic error as HTTP 422
        raise HTTPException(status_code=422, detail=f"Invalid catalog JSON: {exc}") from exc
