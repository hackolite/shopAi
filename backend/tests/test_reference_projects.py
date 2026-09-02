"""Tests des projets de référence statiques (carrefour_city, carrefour_express,
carrefour_express_aeroport).

Ces projets sont livrés uniquement sous forme de fichiers JSON committés dans
``backend/storage/projects/`` — il n'existe plus de script de génération.
Les tests valident directement les fichiers, en particulier la règle métier :
toute allée de circulation doit faire au moins 1 m (100 cm) de large, sinon
les piétons ne peuvent pas passer.
"""
from __future__ import annotations

import itertools
import json
import math
from pathlib import Path

import pytest

_STORAGE = Path(__file__).resolve().parent.parent / "storage"
_LIBRARY_PATH = _STORAGE / "furniture_library.json"
_PROJECT_IDS = ("carrefour_city", "carrefour_express", "carrefour_express_aeroport")

# Largeur minimale d'une allée de circulation (cm).
MIN_AISLE_CM = 100.0
# En dessous de ce seuil, un interstice est une jonction (meubles quasi
# accolés) et non une allée : aucun piéton n'est censé y passer.
JUNCTION_CM = 30.0
# Recouvrement minimal des projections pour considérer deux meubles en vis-à-vis.
MIN_FACING_OVERLAP_CM = 10.0


def _load(project_id: str, filename: str) -> dict:
    return json.loads((_STORAGE / "projects" / project_id / filename).read_text(encoding="utf-8"))


@pytest.fixture(scope="module", params=_PROJECT_IDS)
def project_id(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture(scope="module")
def scene(project_id: str) -> dict:
    return _load(project_id, "scene.json")


@pytest.fixture(scope="module")
def furniture(scene: dict) -> list[dict]:
    return scene["furniture"]


@pytest.fixture(scope="module")
def catalog(project_id: str) -> dict:
    return _load(project_id, "catalog.json")


@pytest.fixture(scope="module")
def planograms(project_id: str) -> list[dict]:
    return _load(project_id, "planograms.json")["planograms"]


@pytest.fixture(scope="module")
def library() -> dict:
    return json.loads(_LIBRARY_PATH.read_text(encoding="utf-8"))


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


def _region_is_blocked(
    region: tuple[float, float, float, float],
    footprints: list[tuple[str, tuple[float, float, float, float]]],
    exclude: tuple[str, str],
) -> bool:
    """Vrai si un autre meuble couvre entièrement l'interstice entre deux meubles."""
    rx0, rz0, rx1, rz1 = region
    for name, (x0, z0, x1, z1) in footprints:
        if name in exclude:
            continue
        if x0 <= rx0 + 0.01 and x1 >= rx1 - 0.01 and z0 <= rz0 + 0.01 and z1 >= rz1 - 0.01:
            return True
    return False


def test_project_files_exist(project_id: str) -> None:
    project_dir = _STORAGE / "projects" / project_id
    for filename in ("project.json", "scene.json", "catalog.json", "planograms.json"):
        assert (project_dir / filename).exists(), filename


def test_eans_are_unique(catalog: dict) -> None:
    eans = [product["ean"] for product in catalog["products"]]
    assert len(set(eans)) == len(eans)


def test_only_library_furniture_types_are_used(furniture: list[dict], library: dict) -> None:
    library_ids = {entry["id"] for entry in library["furniture"]}
    for item in furniture:
        assert item["libraryId"] in library_ids
        assert item["type"] in library_ids


def test_furniture_stays_inside_store(scene: dict, furniture: list[dict]) -> None:
    dims = scene["store"]["dimensions"]
    for item in furniture:
        x0, z0, x1, z1 = _rotated_footprint(item)
        assert x0 >= -0.01 and z0 >= -0.01, item["name"]
        assert x1 <= dims["width"] + 0.01 and z1 <= dims["depth"] + 0.01, item["name"]


def test_no_furniture_overlaps(furniture: list[dict]) -> None:
    footprints = [(item["name"], _rotated_footprint(item)) for item in furniture]
    for i, (name_a, (a0, b0, a1, b1)) in enumerate(footprints):
        for name_b, (c0, d0, c1, d1) in footprints[i + 1:]:
            overlaps = a0 < c1 and c0 < a1 and b0 < d1 and d0 < b1
            assert not overlaps, f"{name_a} chevauche {name_b}"


def test_aisles_are_at_least_one_meter_wide(furniture: list[dict]) -> None:
    """Toute allée entre deux meubles en vis-à-vis doit faire au moins 1 m."""
    footprints = [(item["name"], _rotated_footprint(item)) for item in furniture]
    violations: list[str] = []
    for (name_a, a), (name_b, b) in itertools.combinations(footprints, 2):
        overlap_x = min(a[2], b[2]) - max(a[0], b[0])
        overlap_z = min(a[3], b[3]) - max(a[1], b[1])
        gap_x = max(a[0] - b[2], b[0] - a[2])
        gap_z = max(a[1] - b[3], b[1] - a[3])
        if overlap_z >= MIN_FACING_OVERLAP_CM and JUNCTION_CM <= gap_x < MIN_AISLE_CM:
            left, right = (a, b) if a[2] <= b[0] else (b, a)
            region = (left[2], max(a[1], b[1]), right[0], min(a[3], b[3]))
            if not _region_is_blocked(region, footprints, (name_a, name_b)):
                violations.append(f"{name_a} ↔ {name_b} : allée de {gap_x:.0f} cm (axe X)")
        if overlap_x >= MIN_FACING_OVERLAP_CM and JUNCTION_CM <= gap_z < MIN_AISLE_CM:
            front, back = (a, b) if a[3] <= b[1] else (b, a)
            region = (max(a[0], b[0]), front[3], min(a[2], b[2]), back[1])
            if not _region_is_blocked(region, footprints, (name_a, name_b)):
                violations.append(f"{name_a} ↔ {name_b} : allée de {gap_z:.0f} cm (axe Z)")
    assert not violations, "\n".join(violations)


def test_entrance_zones_are_clear(scene: dict, furniture: list[dict]) -> None:
    zones = scene["store"].get("zones") or []
    for zone in zones:
        if zone["type"] not in ("entrance", "exit"):
            continue
        e0, e1 = zone["x"], zone["x"] + zone["width"]
        f0, f1 = zone["z"], zone["z"] + zone["depth"]
        for item in furniture:
            x0, z0, x1, z1 = _rotated_footprint(item)
            overlaps = x0 < e1 and e0 < x1 and z0 < f1 and f0 < z1
            assert not overlaps, f"{item['name']} bloque la zone {zone['label']}"


def test_every_cell_references_a_catalog_product(catalog: dict, planograms: list[dict]) -> None:
    eans = {product["ean"] for product in catalog["products"]}
    for planogram in planograms:
        for cell in planogram["cells"]:
            assert cell["ean"] in eans


def test_planograms_have_no_empty_slot(planograms: list[dict]) -> None:
    """Aucun emplacement de planogramme ne doit rester vide.

    Un trou dans une grille correspond à un segment de linéaire non marchand :
    chaque emplacement déclaré (``rowColCounts`` quand il est présent, sinon
    ``cols``) doit porter exactement un facing. Les rangées physiquement pleines
    en largeur sont raccourcies via ``rowColCounts`` plutôt que laissées à trou.
    """
    for planogram in planograms:
        counts = planogram.get("rowColCounts") or [planogram["cols"]] * planogram["rows"]
        assert len(counts) == planogram["rows"], planogram["name"]
        assert max(counts) == planogram["cols"], planogram["name"]
        slots = {(cell["row"], cell["col"]) for cell in planogram["cells"]}
        assert len(slots) == len(planogram["cells"]), f"{planogram['name']} : doublon de cellule"
        expected = {(row, col) for row, count in enumerate(counts) for col in range(count)}
        assert slots == expected, f"{planogram['name']} : {len(expected - slots)} emplacement(s) vide(s)"
        for row, count in enumerate(counts):
            assert count > 0, f"{planogram['name']} rangée {row} vide"


def test_planogram_faces_match_furniture_capabilities(furniture: list[dict], library: dict) -> None:
    faces_by_id = {entry["id"]: set(entry["hasFaces"]) for entry in library["furniture"]}
    for item in furniture:
        allowed = faces_by_id[item["libraryId"]]
        used = {face for face, planogram_id in (item.get("faces") or {}).items() if planogram_id}
        assert used <= allowed, f"{item['name']} utilise des faces non supportées: {used - allowed}"


def test_express_catalog_has_about_3000_skus() -> None:
    catalog = _load("carrefour_express", "catalog.json")
    assert 2_800 <= len(catalog["products"]) <= 3_200


def test_express_store_surface_is_110_m2() -> None:
    dims = _load("carrefour_express", "scene.json")["store"]["dimensions"]
    assert dims["width"] * dims["depth"] == pytest.approx(110.0 * 10_000)


# ---------------------------------------------------------------------------
# Règles d'implantation spécifiques à carrefour_express_aeroport
#
# Un planogramme représente une face marchande : elle doit être accessible au
# client. Une face tournée vers un mur (ou plaquée contre un autre meuble) n'a
# aucun sens en merchandising — le rayon n'est ni shoppable ni réassortissable.
# Les meubles muraux doivent donc être collés au mur, face produit vers
# l'intérieur du magasin.
# ---------------------------------------------------------------------------
_AEROPORT_ID = "carrefour_express_aeroport"
# Direction sortante d'une face, exprimée dans le repère local du meuble (x, z).
_FACE_NORMALS = {"front": (0.0, 1.0), "back": (0.0, -1.0), "right": (1.0, 0.0), "left": (-1.0, 0.0)}


def _face_normal(item: dict, face: str) -> tuple[float, float]:
    """Normale sortante d'une face, en repère monde (rotation Y appliquée)."""
    local_x, local_z = _FACE_NORMALS[face]
    theta = math.radians(item["rotation"][1])
    return (
        math.cos(theta) * local_x + math.sin(theta) * local_z,
        -math.sin(theta) * local_x + math.cos(theta) * local_z,
    )


def _sales_area(scene: dict) -> tuple[float, float, float, float]:
    """Surface utile (x0, z0, x1, z1) : la boîte du magasin moins l'épaisseur des murs."""
    dims = scene["store"]["dimensions"]
    thickness = max((wall["dimensions"]["depth"] for wall in scene["store"]["walls"]), default=0.0)
    return (thickness, thickness, dims["width"] - thickness, dims["depth"] - thickness)


def _clearance_in_front_of(
    item: dict,
    face: str,
    scene: dict,
    furniture: list[dict],
) -> tuple[float, str]:
    """Espace libre (cm) devant une face, et ce qui la borne (mur ou meuble)."""
    dir_x, dir_z = _face_normal(item, face)
    x0, z0, x1, z1 = _rotated_footprint(item)
    sx0, sz0, sx1, sz1 = _sales_area(scene)
    if dir_x > 0.5:
        clearance, blocker = sx1 - x1, "mur droit"
    elif dir_x < -0.5:
        clearance, blocker = x0 - sx0, "mur gauche"
    elif dir_z > 0.5:
        clearance, blocker = sz1 - z1, "mur du fond"
    else:
        clearance, blocker = z0 - sz0, "mur façade"

    for other in furniture:
        if other["id"] == item["id"]:
            continue
        a0, b0, a1, b1 = _rotated_footprint(other)
        if abs(dir_z) > 0.5:
            if min(x1, a1) - max(x0, a0) < MIN_FACING_OVERLAP_CM:
                continue
            gap = b0 - z1 if dir_z > 0.5 else z0 - b1
        else:
            if min(z1, b1) - max(z0, b0) < MIN_FACING_OVERLAP_CM:
                continue
            gap = a0 - x1 if dir_x > 0.5 else x0 - a1
        if -0.01 <= gap < clearance:
            clearance, blocker = gap, other["name"]
    return clearance, blocker


def test_aeroport_furniture_stays_inside_the_sales_area() -> None:
    """Aucun meuble ne doit empiéter sur l'épaisseur des murs."""
    scene = _load(_AEROPORT_ID, "scene.json")
    sx0, sz0, sx1, sz1 = _sales_area(scene)
    for item in scene["furniture"]:
        x0, z0, x1, z1 = _rotated_footprint(item)
        assert x0 >= sx0 - 0.01 and z0 >= sz0 - 0.01, item["name"]
        assert x1 <= sx1 + 0.01 and z1 <= sz1 + 0.01, item["name"]


def test_aeroport_no_planogram_faces_a_wall() -> None:
    """Toute face marchande doit disposer d'au moins 1 m d'allée pour être shoppable."""
    scene = _load(_AEROPORT_ID, "scene.json")
    planograms = _load(_AEROPORT_ID, "planograms.json")["planograms"]
    by_id = {item["id"]: item for item in scene["furniture"]}
    violations: list[str] = []
    for planogram in planograms:
        if planogram["face"] == "top":
            continue
        item = by_id[planogram["furnitureId"]]
        clearance, blocker = _clearance_in_front_of(
            item, planogram["face"], scene, scene["furniture"]
        )
        if clearance < MIN_AISLE_CM:
            violations.append(
                f"{item['name']} face {planogram['face']} : {clearance:.0f} cm devant ({blocker})"
            )
    assert not violations, "\n".join(violations)


def test_aeroport_double_gondola_runs_have_end_cap_planograms() -> None:
    """Chaque allée de gondoles doubles porte une tête de gondole à chaque extrémité."""
    scene = _load(_AEROPORT_ID, "scene.json")
    planograms = {p["id"]: p for p in _load(_AEROPORT_ID, "planograms.json")["planograms"]}
    doubles = [item for item in scene["furniture"] if item["type"] == "gondola_double"]
    runs: dict[float, list[dict]] = {}
    for item in doubles:
        runs.setdefault(item["position"][2], []).append(item)
    assert runs, "aucune allée de gondoles doubles"
    for modules in runs.values():
        modules.sort(key=lambda item: item["position"][0])
        for module, face in ((modules[0], "left"), (modules[-1], "right")):
            planogram_id = (module.get("faces") or {}).get(face)
            assert planogram_id, f"{module['name']} sans tête de gondole ({face})"
            planogram = planograms[planogram_id]
            assert planogram["face"] == face
            # La face latérale d'une gondole double est large comme sa profondeur.
            assert planogram["widthCm"] == module["dimensions"]["depth"]
            assert planogram["heightCm"] == module["dimensions"]["height"]
            # Une tête de gondole se réassortit vite : aucun trou de facing.
            assert len(planogram["cells"]) == planogram["rows"] * planogram["cols"]


def test_aeroport_shelf_rows_fit_the_linear_width() -> None:
    """Les facings d'une rangée ne doivent pas déborder de la largeur du linéaire.

    C'est cette contrainte qui borne le remplissage : une rangée déjà pleine en
    largeur est raccourcie (``rowColCounts``) au lieu de garder un emplacement
    vide impossible à garnir.
    """
    products = {p["ean"]: p for p in _load(_AEROPORT_ID, "catalog.json")["products"]}
    for planogram in _load(_AEROPORT_ID, "planograms.json")["planograms"]:
        widths: dict[int, float] = {}
        for cell in planogram["cells"]:
            widths[cell["row"]] = widths.get(cell["row"], 0.0) + products[cell["ean"]]["widthCm"]
        for row, width in widths.items():
            assert width <= planogram["widthCm"] + 0.01, f"{planogram['name']} rangée {row}"


def test_aeroport_planogram_cells_fit_their_grid() -> None:
    for planogram in _load(_AEROPORT_ID, "planograms.json")["planograms"]:
        for cell in planogram["cells"]:
            assert 0 <= cell["row"] < planogram["rows"], planogram["name"]
            assert 0 <= cell["col"] < planogram["cols"], planogram["name"]
