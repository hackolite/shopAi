"""Deterministic studio commands backed by audited, shipped models, not an LLM."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from models.project import Catalog, Material, Planogram, PlanogramCell, ProjectSettings, SceneData
from services import platform_service, project_manager
from services.layout_audit import audit_project_layout, furniture_rotated_bounds
from services.reference_templates import load_reference_template

_FILES = ("scene", "catalog", "planograms", "materials", "settings", "textures")
# Pin canonicalized distributed content, independently of runtime tenant storage.
_REFERENCE_DIGESTS = {
    "carrefour_city": "b583fa0c6cbc163b7253adb43366a8b05414928448fbd4a0b31cc8fa7341093a",
    "carrefour_express": "a1291f1da31982ff3c12ac963f6e3e2ecac96dc401c1370af92326b0b2639768",
    "carrefour_express_aeroport": "f2397720db91005a35d966fbc1f7cb29f1b8f061e6877ba9a1d8aea04056d0d8",
}
_TEMPLATES = {
    "city": ("carrefour_city", "Carrefour City"),
    "express": ("carrefour_express", "Carrefour Express"),
    "express aeroport": ("carrefour_express_aeroport", "Carrefour Express aéroport"),
}
_LABEL = "Assistant intégré à modèles prédéfinis (sans LLM). "
_GENERATE = re.compile(
    r"(?:(?:cree|creer|genere|generer) (?:une |l['’])?)?"
    r"implantation(?: (?P<mode>complete|seule))?"
    r"(?: (?:pour |de )?(?:carrefour )?(?P<template>city|express(?: aeroport)?))?"
    r"(?P<empty> sans produits)?"
)
_AUDIT_COMMANDS = {
    "audit",
    "verifie",
    "verifie le projet",
    "verifie ce projet",
    "verifie l'implantation",
    "verifie cette implantation",
    "verifie cette scene",
}
_SAVE_COMMANDS = {
    "enregistre",
    "enregistre le projet",
    "sauvegarde",
    "sauvegarde le projet",
}
_RECOMMENDATION_COMMANDS = {
    "recommandation d'implantation",
    "recommandation d implantation",
    "recommande l'implantation",
    "recommande l implantation",
    "recommandation implantation",
    "implante le catalogue",
    "implemente le catalogue",
}


def load_reference_snapshot(template_id: str) -> dict[str, Any]:
    """Load only an allowlisted, unmodified distributed reference; never runtime storage."""
    if template_id not in _REFERENCE_DIGESTS:
        raise ValueError("Unsupported reference template")
    snapshot = load_reference_template(template_id)
    content = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if digest != _REFERENCE_DIGESTS[template_id]:
        raise ValueError("Reference template has changed")
    return snapshot


def _reply(
    message: str,
    *,
    changed: bool = False,
    confirmation: bool = False,
    project_id: str | None = None,
    steps: list[str] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "message": _LABEL + message,
        "requiresConfirmation": confirmation,
        "changed": changed,
        "steps": steps or [],
    }
    if project_id is not None:
        result["projectId"] = project_id
    return result


def _normalize(prompt: str) -> str:
    text = "".join(
        char
        for char in unicodedata.normalize("NFKD", prompt.casefold())
        if not unicodedata.combining(char)
    )
    return " ".join(text.split()).replace("’", "'").rstrip(".!? ")


def _load_persisted(project_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    metadata = project_manager.get_project_metadata(project_id)
    snapshot = {
        name: project_manager.load_project_file(project_id, f"{name}.json")
        for name in _FILES
    }
    if any(snapshot[name] is None for name in _FILES):
        raise ValueError("Incomplete persisted project")
    snapshot["scene"] = project_manager.load_validated_scene(
        project_id,
        project_name=metadata.get("name", project_id),
    ).model_dump(mode="json")
    snapshot["planograms"] = snapshot["planograms"]["planograms"]
    _validate_snapshot(snapshot)
    return metadata, snapshot


def _validate_snapshot(snapshot: dict[str, Any]) -> None:
    SceneData.model_validate(snapshot["scene"])
    Catalog.model_validate(snapshot["catalog"])
    for item in snapshot["planograms"]:
        Planogram.model_validate(item)
    for item in snapshot["materials"]["materials"]:
        Material.model_validate(item)
    ProjectSettings.model_validate(snapshot["settings"])


def _audit(metadata: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    scene = SceneData.model_validate(snapshot["scene"])
    catalog = Catalog.model_validate(snapshot["catalog"])
    planograms = [Planogram.model_validate(item) for item in snapshot["planograms"]]
    audit = audit_project_layout(metadata, scene, catalog, planograms)
    # The legacy audit uses unrotated bounds, which incorrectly rejects wall shelving.
    issues: list[str] = []
    sx, _, sz = scene.store.position
    sw, sd = (float(scene.store.dimensions[key]) for key in ("width", "depth"))
    for item in scene.furniture:
        x0, x1, z0, z1 = furniture_rotated_bounds(item)
        if x0 < sx - 0.5 or x1 > sx + sw + 0.5 or z0 < sz - 0.5 or z1 > sz + sd + 0.5:
            issues.append(f"{item.name}: emprise tournée hors du magasin")
    audit["checks"]["furnitureBounds"] = {"ok": not issues, "issues": issues}
    # The legacy validator skips unknown EANs when the catalog is empty.
    if not catalog.products and any(item.cells for item in planograms):
        audit["checks"]["planograms"]["issues"].append("Planogrammes remplis sans catalogue")
        audit["checks"]["planograms"]["ok"] = False
    audit["issueCount"] = sum(len(check["issues"]) for check in audit["checks"].values())
    audit["ok"] = audit["issueCount"] == 0
    return audit


def _prepare_snapshot(snapshot: dict[str, Any], *, layout_only: bool) -> list[str]:
    steps: list[str] = []
    if layout_only:
        snapshot["catalog"] = {"products": []}
        snapshot["planograms"] = []
        for item in snapshot["scene"]["furniture"]:
            item["faces"] = {}
        steps.append("Implantation seule : catalogue vide, sans planogrammes ni liens produit.")
    else:
        # Some shipped City planograms extend beyond their refrigerator face.
        # Fit their grid extents before auditing; do not alter the shared reference.
        furniture = {item["id"]: item for item in snapshot["scene"]["furniture"]}
        adjusted = 0
        for item in snapshot["planograms"]:
            dimensions = furniture[item["furnitureId"]]["dimensions"]
            face = item["face"]
            width = dimensions["depth" if face in {"left", "right"} else "width"]
            height = dimensions["depth" if face in {"top", "bottom"} else "height"]
            if item["widthCm"] > width or item["heightCm"] > height:
                item["widthCm"] = min(item["widthCm"], width)
                item["heightCm"] = min(item["heightCm"], height)
                adjusted += 1
        if adjusted:
            steps.append(f"{adjusted} grilles de planogrammes ajustées aux dimensions des faces.")
    _validate_snapshot(snapshot)
    return steps


def _recommend_placements(
    catalog: Catalog,
    planograms: list[Planogram],
) -> list[dict[str, Any]]:
    """Greedily match unplaced catalog articles to free planogram cells.

    Articles already present in a planogram cell are skipped. Remaining
    articles are assigned one at a time, in catalog order, to the next free
    (row, col) slot of a planogram whose ``category``-tagged name matches the
    article's category when possible, otherwise to the first planogram with
    free capacity. Returns an ordered list of actions (one per article).
    """
    placed_eans = {cell.ean for planogram in planograms for cell in planogram.cells}
    pending = [product for product in catalog.products if product.ean not in placed_eans]

    free_slots: dict[str, list[tuple[int, int]]] = {}
    for planogram in planograms:
        occupied = {(cell.row, cell.col) for cell in planogram.cells}
        slots = [
            (row, col)
            for row in range(planogram.rows)
            for col in range(planogram.cols)
            if (row, col) not in occupied
        ]
        if slots:
            free_slots[planogram.id] = slots

    def _best_planogram_id(product: Any) -> str | None:
        category = (product.category or "").strip().casefold()
        if category:
            for planogram in planograms:
                if planogram.id in free_slots and category in planogram.name.casefold():
                    return planogram.id
        for planogram in planograms:
            if planogram.id in free_slots:
                return planogram.id
        return None

    planogram_by_id = {planogram.id: planogram for planogram in planograms}
    actions: list[dict[str, Any]] = []
    for product in pending:
        planogram_id = _best_planogram_id(product)
        if planogram_id is None:
            break
        row, col = free_slots[planogram_id].pop(0)
        if not free_slots[planogram_id]:
            del free_slots[planogram_id]
        planogram = planogram_by_id[planogram_id]
        actions.append({
            "ean": product.ean,
            "name": product.name,
            "planogramId": planogram_id,
            "furnitureId": planogram.furnitureId,
            "row": row,
            "col": col,
        })
    return actions


def _apply_placements(snapshot: dict[str, Any], actions: list[dict[str, Any]]) -> None:
    """Mutate ``snapshot['planograms']`` in place, adding one cell per action."""
    by_id = {item["id"]: item for item in snapshot["planograms"]}
    for action in actions:
        planogram = by_id[action["planogramId"]]
        planogram["cells"].append(
            PlanogramCell(
                id=str(uuid4()),
                ean=action["ean"],
                row=action["row"],
                col=action["col"],
            ).model_dump(mode="json")
        )


def audit_persisted_project(project_id: str) -> dict[str, Any]:
    """Re-read a project's saved files and audit them.

    Public wrapper around the internal snapshot loader/auditor, used by the
    external LLM assistant proxy to enforce a mandatory post-write check on
    any project an external agent claims to have modified. Raises the same
    exceptions as the internal audit path (``ValueError``, ``KeyError``,
    ``TypeError``, ``OSError``, ``ValidationError``) when the persisted state
    is missing or invalid.
    """
    metadata, snapshot = _load_persisted(project_id)
    return _audit(metadata, snapshot)


def run_studio_assistant(
    project_id: str,
    prompt: str,
    *,
    confirm: bool = False,
) -> dict[str, Any]:
    platform_service.require_current_user()
    platform_service.require_current_user_project_access(project_id)
    project_manager.ensure_project_exists(project_id)
    command = _normalize(prompt)

    if command in _AUDIT_COMMANDS | _SAVE_COMMANDS:
        try:
            metadata, snapshot = _load_persisted(project_id)
        except (ValueError, KeyError, TypeError, OSError, ValidationError):
            return _reply(
                "État persistant incomplet ou illisible : "
                "aucune sauvegarde ni vérification confirmée."
            )
        if command in _SAVE_COMMANDS:
            return _reply(
                f"État déjà enregistré relu sur disque : « {metadata['name']} », "
                f"{len(snapshot['scene']['furniture'])} meubles, "
                f"{len(snapshot['catalog']['products'])} produits, "
                f"{len(snapshot['planograms'])} planogrammes. "
                f"Dernière écriture : {metadata.get('updatedAt', 'inconnue')}. "
                "Les modifications locales non transmises au serveur ne sont pas enregistrées ici.",
                project_id=project_id,
            )
        audit = _audit(metadata, snapshot)
        issues = [
            issue
            for check in audit["checks"].values()
            for issue in check["issues"]
        ]
        return _reply(
            f"Audit de l'état enregistré : {audit['issueCount']} anomalie(s). "
            "Contrôles : dimensions, emprises tournées, références produit et positions des cases ; "
            "pas une certification réglementaire.",
            project_id=project_id,
            steps=issues[:30],
        )

    if command in _RECOMMENDATION_COMMANDS:
        try:
            metadata, snapshot = _load_persisted(project_id)
        except (ValueError, KeyError, TypeError, OSError, ValidationError):
            return _reply(
                "État persistant incomplet ou illisible : "
                "impossible de générer une recommandation d'implantation."
            )
        catalog = Catalog.model_validate(snapshot["catalog"])
        planograms = [Planogram.model_validate(item) for item in snapshot["planograms"]]
        if not planograms:
            return _reply(
                "Aucun planogramme dans ce projet : sélectionnez d'abord un Store Layout "
                "avec du mobilier équipé de planogrammes.",
                project_id=project_id,
            )
        actions = _recommend_placements(catalog, planograms)
        if not actions:
            return _reply(
                "Aucune recommandation : tous les articles du catalogue sont déjà implantés, "
                "ou il n'y a plus de case libre dans les planogrammes.",
                project_id=project_id,
            )
        steps = [
            f"{index + 1}/{len(actions)} — {action['name']} (EAN {action['ean']}) "
            f"→ planogramme {action['planogramId']}, case (ligne {action['row']}, colonne {action['col']})"
            for index, action in enumerate(actions)
        ]
        if not confirm:
            return _reply(
                f"Aperçu de la recommandation d'implantation : {len(actions)} article(s) à placer, "
                "un article après l'autre. Confirmez pour exécuter ces actions sur ce projet.",
                confirmation=True,
                project_id=project_id,
                steps=steps,
            )
        _apply_placements(snapshot, actions)
        _validate_snapshot(snapshot)
        project_manager.save_project_file(
            project_id, "planograms.json", {"planograms": snapshot["planograms"]}
        )
        return _reply(
            f"Recommandation exécutée : {len(actions)}/{len(actions)} article(s) implanté(s), "
            "un par un, dans les planogrammes existants.",
            changed=True,
            project_id=project_id,
            steps=steps,
        )

    match = _GENERATE.fullmatch(command)
    if match is None or (match["mode"] == "complete" and match["empty"]):
        return _reply(
            "Demande non prise en charge : aucune modification. Commandes disponibles : "
            "« Crée une implantation complète Carrefour City », "
            "« Crée une implantation complète Carrefour Express », "
            "« Crée une implantation complète Carrefour Express aéroport », "
            "« implantation seule [Carrefour …] », « recommandation d'implantation », "
            "« vérifie », « enregistre ». "
            "Les consignes libres et personnalisations ne sont pas exécutées."
        )
    template_id, name = _TEMPLATES[match["template"] or "express aeroport"]
    layout_only = match["mode"] == "seule" or bool(match["empty"])
    try:
        snapshot = load_reference_snapshot(template_id)
        steps = _prepare_snapshot(snapshot, layout_only=layout_only)
        audit = _audit({"id": template_id, "name": name}, snapshot)
    except (ValueError, KeyError, TypeError, OSError, ValidationError):
        return _reply("Modèle de référence indisponible, modifié ou invalide. Aucun projet créé.")
    if not audit["ok"]:
        return _reply(
            f"Modèle refusé par l'audit : {audit['issueCount']} anomalie(s). Aucun projet créé."
        )

    steps.extend(
        [
            f"Magasin {name} : {len(snapshot['scene']['furniture'])} meubles.",
            f"{len(snapshot['catalog']['products'])} produits et "
            f"{len(snapshot['planograms'])} planogrammes.",
            "Matériaux, textures et paramètres du modèle conservés.",
            "Audit des dimensions, emprises, références produit et positions des cases : "
            "aucune anomalie.",
        ]
    )
    if not confirm:
        return _reply(
            f"Aperçu : création d'un nouveau projet {name}"
            f"{' — implantation seule' if layout_only else ' — implantation complète'}. "
            "Votre projet actuel restera intact. Confirmez pour créer et enregistrer ce modèle prédéfini.",
            confirmation=True,
            steps=steps,
        )
    mode = "implantation seule" if layout_only else "implantation complète"
    metadata = project_manager.import_project(snapshot, f"{name} — {mode}")
    new_id = metadata["id"]
    try:
        project_manager.save_project_file(new_id, "textures.json", snapshot["textures"])
        _load_persisted(new_id)
        platform_service.assign_project_to_current_user(new_id)
        platform_service.require_current_user_project_access(new_id)
    except Exception:
        project_manager.delete_project(new_id)
        raise
    return _reply(
        f"Nouveau projet {name} créé et relu sur disque. Le projet d'origine n'a pas été modifié.",
        changed=True,
        project_id=new_id,
        steps=steps,
    )
