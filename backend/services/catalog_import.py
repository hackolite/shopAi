"""Parse a product catalog CSV file into a :class:`~models.project.Catalog`.

Expected columns: ``ean, name, brand, category, widthCm, depthCm, heightCm,
weightG`` (required) plus optional ``subcategory, productRange, format,
imageUrl, priceBuyEur, marginPct, priceSellEur``. One row per product.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from fastapi import HTTPException

from models.project import Catalog, Product

_REQUIRED_COLUMNS = {"ean", "name", "brand", "category", "widthCm", "depthCm", "heightCm", "weightG"}
_NUMERIC_COLUMNS = {"widthCm", "depthCm", "heightCm", "weightG"}
_OPTIONAL_NUMERIC_COLUMNS = {"priceBuyEur", "marginPct", "priceSellEur"}


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
        for key in ("brand", "category", "subcategory", "productRange", "format", "imageUrl"):
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
