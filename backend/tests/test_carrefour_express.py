"""Tests du projet « Carrefour Express 110 m² – Zone touristique »."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.carrefour_express_generator import (
    STORE_DEPTH_CM,
    STORE_WIDTH_CM,
    generate_carrefour_express,
)

_LIBRARY_PATH = Path(__file__).resolve().parent.parent / "storage" / "furniture_library.json"


@pytest.fixture(scope="module")
def demo() -> dict:
    return generate_carrefour_express()


@pytest.fixture(scope="module")
def products(demo: dict) -> list[dict]:
    return demo["catalog"]["products"]


@pytest.fixture(scope="module")
def planograms(demo: dict) -> list[dict]:
    return demo["planograms"]["planograms"]


@pytest.fixture(scope="module")
def furniture(demo: dict) -> list[dict]:
    return demo["scene"]["furniture"]


def _rotated_footprint(item: dict) -> tuple[float, float, float, float]:
    """Emprise au sol (x0, z0, x1, z1) tenant compte de la rotation Y.

    La rotation pivote autour du centre de l'emprise (position + dims / 2) ;
    à 90°/270° un meuble W×D occupe centre ± D/2 en X et centre ± W/2 en Z.
    """
    px, _, pz = item["position"]
    width = item["dimensions"]["width"]
    depth = item["dimensions"]["depth"]
    rot = item["rotation"][1] % 360
    cx, cz = px + width / 2.0, pz + depth / 2.0
    if rot in (90, 270):
        return (cx - depth / 2.0, cz - width / 2.0, cx + depth / 2.0, cz + width / 2.0)
    return (px, pz, px + width, pz + depth)


def test_store_surface_is_110_m2(demo: dict) -> None:
    dims = demo["scene"]["store"]["dimensions"]
    assert dims["width"] * dims["depth"] == pytest.approx(110.0 * 10_000)


def test_catalog_has_about_3000_skus(products: list[dict]) -> None:
    assert 2_800 <= len(products) <= 3_200


def test_eans_are_unique(products: list[dict]) -> None:
    eans = [product["ean"] for product in products]
    assert len(set(eans)) == len(eans)


def test_hierarchy_and_prices_are_complete(products: list[dict]) -> None:
    for product in products:
        assert product["category"]
        assert product["subcategory"]
        assert product["brand"]
        assert product["productRange"]
        assert product["name"]
        assert product["format"]
        buy = product["priceBuyEur"]
        sell = product["priceSellEur"]
        margin = product["marginPct"]
        assert 0.0 < buy < sell
        assert 0.0 < margin < 100.0
        # Marge brute cohérente avec le taux de marge déclaré (arrondis au centime).
        assert buy == pytest.approx(sell * (1.0 - margin / 100.0), abs=0.011)


def test_only_library_furniture_types_are_used(furniture: list[dict]) -> None:
    library = json.loads(_LIBRARY_PATH.read_text(encoding="utf-8"))
    library_ids = {entry["id"] for entry in library["furniture"]}
    for item in furniture:
        assert item["libraryId"] in library_ids
        assert item["type"] in library_ids


def test_furniture_stays_inside_store(furniture: list[dict]) -> None:
    for item in furniture:
        x0, z0, x1, z1 = _rotated_footprint(item)
        assert x0 >= -0.01 and z0 >= -0.01, item["name"]
        assert x1 <= STORE_WIDTH_CM + 0.01 and z1 <= STORE_DEPTH_CM + 0.01, item["name"]


def test_no_furniture_overlaps(furniture: list[dict]) -> None:
    footprints = [(item["name"], _rotated_footprint(item)) for item in furniture]
    for i, (name_a, (a0, b0, a1, b1)) in enumerate(footprints):
        for name_b, (c0, d0, c1, d1) in footprints[i + 1:]:
            overlaps = a0 < c1 and c0 < a1 and b0 < d1 and d0 < b1
            assert not overlaps, f"{name_a} chevauche {name_b}"


def test_entrance_zone_is_clear(demo: dict, furniture: list[dict]) -> None:
    zones = demo["scene"]["store"]["zones"]
    entrance = next(zone for zone in zones if zone["type"] == "entrance")
    e0, e1 = entrance["x"], entrance["x"] + entrance["width"]
    f0, f1 = entrance["z"], entrance["z"] + entrance["depth"]
    for item in furniture:
        x0, z0, x1, z1 = _rotated_footprint(item)
        overlaps = x0 < e1 and e0 < x1 and z0 < f1 and f0 < z1
        assert not overlaps, f"{item['name']} bloque l'entrée"


def test_every_cell_references_a_catalog_product(products: list[dict], planograms: list[dict]) -> None:
    eans = {product["ean"] for product in products}
    for planogram in planograms:
        for cell in planogram["cells"]:
            assert cell["ean"] in eans


def test_every_sku_is_implanted_once(products: list[dict], planograms: list[dict]) -> None:
    placed = [cell["ean"] for planogram in planograms for cell in planogram["cells"]]
    assert sorted(placed) == sorted(product["ean"] for product in products)


def test_each_face_holds_a_single_subcategory(products: list[dict], planograms: list[dict]) -> None:
    """Compliance catégorielle : une face de meuble = une seule sous-catégorie."""
    by_ean = {product["ean"]: product for product in products}
    for planogram in planograms:
        pairs = {
            (by_ean[cell["ean"]]["category"], by_ean[cell["ean"]]["subcategory"])
            for cell in planogram["cells"]
        }
        assert len(pairs) == 1, planogram["name"]


def test_brands_stay_grouped_within_each_face(products: list[dict], planograms: list[dict]) -> None:
    """Une marque forme un bloc contigu dans l'ordre de lecture du planogramme."""
    by_ean = {product["ean"]: product for product in products}
    for planogram in planograms:
        cells = sorted(planogram["cells"], key=lambda cell: (cell["row"], cell["col"]))
        brands = [by_ean[cell["ean"]]["brand"] for cell in cells]
        seen: list[str] = []
        for brand in brands:
            if not seen or seen[-1] != brand:
                assert brand not in seen, f"Marque {brand} fragmentée dans {planogram['name']}"
                seen.append(brand)


def test_planogram_faces_match_furniture_capabilities(demo: dict, furniture: list[dict]) -> None:
    library = json.loads(_LIBRARY_PATH.read_text(encoding="utf-8"))
    faces_by_id = {entry["id"]: set(entry["hasFaces"]) for entry in library["furniture"]}
    for item in furniture:
        allowed = faces_by_id[item["libraryId"]]
        used = {face for face, planogram_id in item["faces"].items() if planogram_id}
        assert used <= allowed, f"{item['name']} utilise des faces non supportées: {used - allowed}"


def test_committed_project_files_match_generator_shape() -> None:
    project_dir = Path(__file__).resolve().parent.parent / "storage" / "projects" / "carrefour_express"
    assert (project_dir / "project.json").exists()
    catalog = json.loads((project_dir / "catalog.json").read_text(encoding="utf-8"))
    scene = json.loads((project_dir / "scene.json").read_text(encoding="utf-8"))
    planograms = json.loads((project_dir / "planograms.json").read_text(encoding="utf-8"))
    assert 2_800 <= len(catalog["products"]) <= 3_200
    assert scene["store"]["dimensions"]["width"] * scene["store"]["dimensions"]["depth"] == 110.0 * 10_000
    assert planograms["planograms"]
