from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from .schemas import Identifier, OrchestrationPlan, StoreDimensions
from .tools import BackendTools
from pydantic import TypeAdapter

_identifier = TypeAdapter(Identifier)


@dataclass(frozen=True)
class Operation:
    method: str
    path: str
    payload: dict[str, Any] | None
    description: str

    def __post_init__(self) -> None:
        # Later simulated operations must not rewrite an earlier request body.
        object.__setattr__(self, "payload", copy.deepcopy(self.payload))


def fingerprint(state: dict[str, Any]) -> str:
    normalized = copy.deepcopy(state)
    for planogram in normalized.get("planograms", []):
        if planogram.get("gondola"):
            # The backend may generate fresh IDs for derived legacy cells on
            # each read. Keep the persisted gondola and all cell semantics.
            for cell in planogram.get("cells", []):
                cell.pop("id", None)
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, allow_nan=False).encode()).hexdigest()


async def read_state(tools: BackendTools, project_id: str) -> dict[str, Any]:
    prefix = f"/api/cad/projects/{project_id}"
    scene = await tools._request("GET", prefix + "/scene")
    catalog = await tools._request("GET", prefix + "/catalog")
    summaries = (await tools._request("GET", prefix + "/planograms"))["planograms"]
    if len(scene["furniture"]) > 200 or len(summaries) > 100 or len(catalog["products"]) > 10000:
        raise ValueError("Projet trop volumineux pour une planification bornée.")
    planograms = []
    for item in summaries:
        identifier = _identifier.validate_python(item["id"])
        planograms.append(await tools._request("GET", prefix + f"/planograms/{identifier}"))
    return {"scene": scene, "catalog": catalog, "planograms": planograms}


def planner_context(state: dict[str, Any], library: dict[str, Any]) -> dict[str, Any]:
    return {
        "scene": state["scene"],
        "products": [
            {key: item.get(key) for key in ("ean", "name", "brand", "category", "widthCm", "depthCm", "heightCm", "weightG")}
            for item in state["catalog"]["products"][:500]
        ],
        "catalogTruncated": len(state["catalog"]["products"]) > 500,
        "planograms": [
            {key: item.get(key) for key in ("id", "name", "furnitureId", "face", "rows", "cols", "cells")}
            for item in state["planograms"]
        ],
        "library": list(library.values()),
    }


def validate_layout(scene: dict[str, Any]) -> None:
    store = scene["store"]
    dimensions = StoreDimensions.model_validate(store["dimensions"])
    sx, sy, sz = store.get("position", [0, 0, 0])
    bounds = []
    for item in scene["furniture"]:
        dims = StoreDimensions.model_validate(item["dimensions"])
        x, y, z = item["position"]
        rx, ry, rz = item["rotation"]
        if not all(math.isfinite(value) for value in (x, y, z, rx, ry, rz)) or rx != 0 or rz != 0:
            raise ValueError("Positions finies et rotation autour de Y uniquement requises.")
        radians = math.radians(ry)
        half_x = (abs(math.cos(radians)) * dims.width + abs(math.sin(radians)) * dims.depth) / 2
        half_z = (abs(math.sin(radians)) * dims.width + abs(math.cos(radians)) * dims.depth) / 2
        cx, cz = x + dims.width / 2, z + dims.depth / 2
        current = (cx - half_x, cx + half_x, cz - half_z, cz + half_z)
        if (min(x, current[0]) < sx - .5 or max(x + dims.width, current[1]) > sx + dimensions.width + .5
                or min(z, current[2]) < sz - .5 or max(z + dims.depth, current[3]) > sz + dimensions.depth + .5
                or y < sy or y + dims.height > sy + dimensions.height):
            raise ValueError(f"{item['name']}: mobilier hors des limites du magasin.")
        if any(current[0] < b[1] and current[1] > b[0] and current[2] < b[3] and current[3] > b[2] for b in bounds):
            raise ValueError(f"{item['name']}: collision avec un autre meuble.")
        bounds.append(current)


def compile_operations(
    tools: BackendTools, plan: OrchestrationPlan, original: dict[str, Any], library: dict[str, Any],
) -> tuple[bool, list[Operation]]:
    """Resolve all defaults, IDs and catalogue data before asking for confirmation."""
    create = plan.intent in {"layout-create", "build_complete_store"}
    layout = create or plan.intent == "layout-modify"
    assortment = plan.intent in {"build_complete_store", "assortment-full", "assortment-modify"}
    if not layout and (plan.store or plan.furniture):
        raise ValueError("Une demande d'assortiment ne peut pas modifier l'implantation.")
    if not assortment and (plan.products or plan.planograms):
        raise ValueError("Une demande d'implantation ne peut pas modifier l'assortiment.")
    state = copy.deepcopy(original)
    operations: list[Operation] = []
    if create:
        plan = plan.model_copy(update={"store": plan.store or StoreDimensions(width=3000, depth=2000, height=400)})
        state = {
            "scene": {"store": {"dimensions": plan.store.model_dump(), "position": [0, 0, 0]}, "furniture": []},
            "catalog": {"products": []}, "planograms": [],
        }
        if plan.intent == "layout-create":
            operations.append(Operation(
                "POST",
                "/catalog/import",
                {"products": [], "merge": False},
                "Vider le catalogue initial du nouveau projet: implantation sans produits.",
            ))
    scene = state["scene"]
    if layout and plan.store:
        scene["store"]["dimensions"] = plan.store.model_dump()
        validate_layout(scene)
        body = {"dimensions": plan.store.model_dump()}
        if create:
            body["name"] = plan.project_name
        operations.append(Operation("PUT", "/scene/store", body, f"Dimensions magasin: {plan.store.model_dump()}"))

    changes = plan.furniture
    if create and not changes:
        for item in tools.plan_layout(library, plan):
            scene["furniture"].append(item)
            operations.append(Operation("POST", "/scene/furniture", item, f"Ajouter {item['name']} à {item['position']}"))
        validate_layout(scene)
    for change in changes:
        values = change.model_dump(exclude_none=True, mode="json")
        action = values.pop("action")
        identifier = values.pop("id", None)
        existing = next((item for item in scene["furniture"] if item["id"] == identifier), None)
        if action == "add":
            if existing or not change.libraryId or change.libraryId not in library or change.position is None:
                raise ValueError("Ajout mobilier: ID unique, bibliothèque connue et position obligatoires.")
            definition = library[change.libraryId]
            item = {
                "id": identifier or str(uuid4()), "name": definition["name"], "type": definition["type"],
                "libraryId": definition["id"], "dimensions": dict(definition["defaultDimensions"]),
                "rotation": [0, 0, 0], "materialId": definition.get("defaultMaterial"), **values,
            }
            scene["furniture"].append(item)
            operations.append(Operation("POST", "/scene/furniture", item, f"Ajouter {item['name']}: {values}"))
        else:
            if not existing:
                raise ValueError("La modification doit cibler un ID de mobilier existant.")
            if action == "delete":
                if values:
                    raise ValueError("La suppression de mobilier accepte uniquement son ID.")
                scene["furniture"].remove(existing)
                removed = [p for p in state["planograms"] if p["furnitureId"] == identifier]
                state["planograms"] = [p for p in state["planograms"] if p not in removed]
                operations.append(Operation("DELETE", f"/scene/furniture/{identifier}", None,
                                            f"Supprimer {existing['name']} et ses {len(removed)} planogrammes."))
            else:
                if not values or change.libraryId is not None:
                    raise ValueError("Modification mobilier vide ou changement de bibliothèque non pris en charge.")
                existing.update(values)
                operations.append(Operation("PUT", f"/scene/furniture/{identifier}", values,
                                            f"Modifier {existing['name']} ({identifier}): {values}"))
        # Validate each intermediate state as the audited endpoints execute sequentially.
        validate_layout(scene)

    products = [item.model_dump(exclude_unset=True) for item in plan.products]
    full = plan.intent in {"build_complete_store", "assortment-full"}
    if full and not products:
        existing_products = state["catalog"]["products"]
        if len(existing_products) > plan.max_products:
            raise ValueError(
                f"Le catalogue contient {len(existing_products)} produits, au-delà de la limite "
                f"du plan ({plan.max_products}). Aucun produit n'a été sélectionné implicitement. "
                "Demande une sélection explicite de 500 produits maximum ou des modifications ciblées."
            )
        products = existing_products or tools.load_products(plan.max_products)
    if len({item["ean"] for item in products}) != len(products):
        raise ValueError("Les EAN de produits doivent être uniques.")
    catalog = {item["ean"]: item for item in state["catalog"]["products"]}
    if products:
        merged_products = [{**catalog.get(item["ean"], {}), **item} for item in products]
        catalog.update({item["ean"]: item for item in merged_products})
        description = (
            f"Initialiser le catalogue du nouveau projet avec exactement {len(products)} produits."
            if create else
            f"Fusionner {len(products)} produits par EAN; conserver les autres produits."
        )
        operations.append(Operation(
            "POST",
            "/catalog/import",
            {"products": merged_products, "merge": not create},
            description,
        ))

    planned = [item.model_dump(exclude_none=True) for item in plan.planograms]
    if full and not planned:
        planned = tools.build_planograms(scene["furniture"], products)
        if not planned:
            raise ValueError("Aucune face de mobilier compatible; crée une implantation avant l'assortiment.")
        used = {cell["ean"] for item in planned for cell in item["cells"]}
        if any(item["ean"] not in used for item in products):
            raise ValueError("Capacité insuffisante pour tous les produits; ajoute du mobilier ou précise les grilles.")
    furniture = {item["id"]: item for item in scene["furniture"]}
    by_id = {item["id"]: item for item in state["planograms"]}
    by_face = {(item["furnitureId"], item["face"]): item for item in state["planograms"]}
    seen_faces = set()
    for raw in planned:
        raw = copy.deepcopy(raw)
        fid, face = raw["furnitureId"], raw["face"]
        if fid not in furniture or (fid, face) in seen_faces:
            raise ValueError("Planogramme: mobilier inconnu ou face demandée plusieurs fois.")
        seen_faces.add((fid, face))
        existing = by_id.get(raw.get("id")) if raw.get("id") else by_face.get((fid, face))
        if raw.get("id") and not existing:
            raise ValueError("ID de planogramme inconnu.")
        if existing and (existing["furnitureId"], existing["face"]) != (fid, face):
            raise ValueError("Déplacer un planogramme entre faces n'est pas pris en charge.")
        dims = furniture[fid]["dimensions"]
        width = dims["depth"] if face in {"left", "right"} else dims["width"]
        height = dims["depth"] if face in {"top", "bottom"} else dims["height"]
        raw.update({"id": existing["id"] if existing else str(uuid4()), "widthCm": width, "heightCm": height})
        raw["cells"] = [{**cell, "id": str(uuid4())} for cell in raw["cells"]]
        positions = {(cell["row"], cell["col"]) for cell in raw["cells"]}
        if len(positions) != len(raw["cells"]) or any(
            cell["ean"] not in catalog or not 0 <= cell["row"] < raw["rows"] or not 0 <= cell["col"] < raw["cols"]
            for cell in raw["cells"]
        ):
            raise ValueError("Cellules invalides: EAN inconnu, coordonnées dupliquées ou hors grille.")
        if existing:
            raw.update({key: None for key in (
                "gondola", "colWidthsCm", "rowHeightsCm", "cellWidthOverrides", "cellHeightOverrides", "rowColCounts", "mergedSpans",
            )})
        by_id[raw["id"]] = raw
        method, path = ("PUT", f"/planograms/{raw['id']}") if existing else ("POST", "/planograms")
        operations.append(Operation(method, path, raw,
                                    f"{'Remplacer' if existing else 'Créer'} grille {raw['name']} ({fid}, {face}): "
                                    f"{raw['rows']}×{raw['cols']}, {len(raw['cells'])} cellules."))
    # A resize must not leave untouched planograms larger than their furniture.
    for item in by_id.values():
        dims = furniture[item["furnitureId"]]["dimensions"]
        width = dims["depth"] if item["face"] in {"left", "right"} else dims["width"]
        height = dims["depth"] if item["face"] in {"top", "bottom"} else dims["height"]
        if item["widthCm"] > width + .5 or item["heightCm"] > height + .5:
            raise ValueError("Le redimensionnement rendrait un planogramme existant invalide.")
    if not operations:
        raise ValueError("Aucune opération explicite applicable dans le plan.")
    if len(operations) > 200:
        raise ValueError("Le plan dépasse la limite de 200 écritures.")
    if sum(len(json.dumps(operation.payload, allow_nan=False)) for operation in operations) > 500_000:
        raise ValueError("Le plan dépasse la limite de données autorisée.")
    return create, operations
