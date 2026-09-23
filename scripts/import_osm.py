from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.services.osm_import import BUILDING_TYPE_COLORS, osm_xml_to_retail_layout


def _default_output_path(input_path: Path) -> Path:
    stem = input_path.stem or "osm"
    return input_path.with_name(f"{stem}_retail_layout.json")


def _default_name(input_path: Path) -> str:
    name = input_path.stem.replace("_", " ").replace("-", " ").strip()
    return name or "Import OSM"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convertit un fichier OSM XML en retail-layout ShopAI importable dans le workspace "
            "(zones building=* avec précision géométrique)."
        )
    )
    parser.add_argument("input", type=Path, help="Chemin du fichier OSM/XML source")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Chemin du JSON retail-layout de sortie (défaut: <input>_retail_layout.json)",
    )
    parser.add_argument(
        "--name",
        type=str,
        help="Nom projet/store dans le JSON (défaut: dérivé du nom de fichier)",
    )
    parser.add_argument("--project-id", type=str, default=None, help="Project ID optionnel")
    parser.add_argument("--store-id", type=str, default=None, help="Store ID optionnel")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path: Path = args.input
    output_path: Path = args.output or _default_output_path(input_path)

    if not input_path.exists() or not input_path.is_file():
        print(f"Erreur: fichier introuvable: {input_path}", file=sys.stderr)
        return 1

    try:
        xml_text = input_path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        print(f"Erreur d'encodage UTF-8: {exc}", file=sys.stderr)
        return 1

    try:
        retail_layout = osm_xml_to_retail_layout(
            xml_text=xml_text,
            project_name=(args.name or _default_name(input_path)),
            project_id=args.project_id,
            store_id=args.store_id,
        )
    except ValueError as exc:
        print(f"Erreur de conversion OSM: {exc}", file=sys.stderr)
        return 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(retail_layout, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    building_count = retail_layout.get("source", {}).get("buildingCount", 0)
    known_types = ", ".join(sorted(BUILDING_TYPE_COLORS.keys()))

    print("=" * 60)
    print("CONVERSION OSM TERMINÉE")
    print("=" * 60)
    print(f"Entrée      : {input_path}")
    print(f"Sortie      : {output_path}")
    print(f"Bâtiments   : {building_count}")
    print(f"Types/codes : {known_types}")
    print("Le JSON de sortie est directement importable via Workspace > Implantations > Import OSM.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
