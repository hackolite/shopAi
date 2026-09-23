from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from math import cos, radians
from typing import Any
from uuid import uuid4

METERS_PER_LEVEL = 3.0
DEFAULT_BUILDING_COLOR = "#9CA3AF"
_HEIGHT_PATTERN = re.compile(r"^([0-9]+(?:\.[0-9]+)?)\s*(cm|m)?$")

BUILDING_TYPE_COLORS: dict[str, str] = {
    "residential": "#F4A261",
    "apartments": "#E9C46A",
    "house": "#F7B267",
    "commercial": "#457B9D",
    "retail": "#2A9D8F",
    "office": "#577590",
    "industrial": "#6A994E",
    "warehouse": "#4D908E",
    "civic": "#1D3557",
    "school": "#90BE6D",
    "hospital": "#E76F51",
    "religious": "#9B5DE5",
    "garage": "#BC6C25",
    "other": DEFAULT_BUILDING_COLOR,
}

_BUILDING_TYPE_ALIASES: dict[str, str] = {
    "detached": "house",
    "semidetached_house": "house",
    "terrace": "house",
    "bungalow": "house",
    "residential": "residential",
    "apartments": "apartments",
    "house": "house",
    "commercial": "commercial",
    "retail": "retail",
    "supermarket": "retail",
    "mall": "retail",
    "office": "office",
    "industrial": "industrial",
    "factory": "industrial",
    "warehouse": "warehouse",
    "public": "civic",
    "government": "civic",
    "train_station": "civic",
    "transportation": "civic",
    "school": "school",
    "college": "school",
    "university": "school",
    "kindergarten": "school",
    "hospital": "hospital",
    "clinic": "hospital",
    "doctors": "hospital",
    "church": "religious",
    "cathedral": "religious",
    "mosque": "religious",
    "synagogue": "religious",
    "temple": "religious",
    "chapel": "religious",
    "garage": "garage",
    "garages": "garage",
    "carport": "garage",
    "shed": "garage",
}

_GENERIC_BUILDING_VALUES = {"yes", "building", "true", "1"}


def _safe_float(value: str) -> float:
    return float(value.strip().replace(",", "."))


def _normalize_building_type(raw_value: str | None) -> tuple[str, str]:
    raw = (raw_value or "").strip().lower()
    if not raw:
        return "other", "other"
    token = raw.split(";", 1)[0].strip()
    mapped = _BUILDING_TYPE_ALIASES.get(token)
    if mapped:
        return mapped, token
    if token in _GENERIC_BUILDING_VALUES:
        return "other", token
    return "other", token


def _parse_height_cm(tags: dict[str, str]) -> tuple[float, str | None]:
    raw_height = tags.get("height")
    if raw_height:
        candidate = raw_height.strip().lower().replace(",", ".")
        match = _HEIGHT_PATTERN.match(candidate)
        if match:
            number = float(match.group(1))
            unit = match.group(2)
            if unit == "cm":
                return number, "OSM height"
            return number * 100, "OSM height"

    raw_levels = tags.get("building:levels")
    if raw_levels:
        try:
            levels = _safe_float(raw_levels)
        except ValueError:
            levels = 0.0
        if levels > 0:
            return levels * METERS_PER_LEVEL * 100, "OSM building:levels × 3m"

    return 0.0, None


def _compute_bounds(root: ET.Element, nodes: dict[str, dict[str, float]]) -> tuple[float, float, float, float]:
    bounds = root.find("bounds")
    if bounds is not None:
        return (
            float(bounds.attrib["minlat"]),
            float(bounds.attrib["maxlat"]),
            float(bounds.attrib["minlon"]),
            float(bounds.attrib["maxlon"]),
        )

    if not nodes:
        raise ValueError("Impossible de déterminer les bounds OSM (no <bounds> and no nodes).")

    latitudes = [node["lat"] for node in nodes.values()]
    longitudes = [node["lon"] for node in nodes.values()]
    return min(latitudes), max(latitudes), min(longitudes), max(longitudes)


def osm_xml_to_retail_layout(
    xml_text: str,
    project_name: str,
    project_id: str | None = None,
    store_id: str | None = None,
    exported_at: str | None = None,
) -> dict[str, Any]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid OSM XML file: {exc}") from exc

    nodes: dict[str, dict[str, float]] = {}
    for node in root.findall("node"):
        node_id = node.attrib.get("id")
        lat = node.attrib.get("lat")
        lon = node.attrib.get("lon")
        if not node_id or lat is None or lon is None:
            continue
        try:
            nodes[node_id] = {"lat": float(lat), "lon": float(lon)}
        except ValueError:
            continue

    min_lat, max_lat, min_lon, max_lon = _compute_bounds(root, nodes)
    center_lat = (min_lat + max_lat) / 2.0
    meters_per_degree_lat = 111320.0
    meters_per_degree_lon = 111320.0 * cos(radians(center_lat))

    def geographic_to_local(lat: float, lon: float) -> tuple[float, float]:
        x_m = (lon - min_lon) * meters_per_degree_lon
        z_m = (max_lat - lat) * meters_per_degree_lat
        return x_m * 100, z_m * 100

    buildings: list[dict[str, Any]] = []
    for way in root.findall("way"):
        tags: dict[str, str] = {}
        for tag in way.findall("tag"):
            key = tag.attrib.get("k")
            value = tag.attrib.get("v")
            if key is not None and value is not None:
                tags[key] = value
        if "building" not in tags:
            continue

        osm_way_id = way.attrib.get("id", f"way-{len(buildings) + 1}")
        node_refs = [nd.attrib.get("ref") for nd in way.findall("nd")]
        points: list[dict[str, Any]] = []
        for node_ref in node_refs:
            if not node_ref:
                continue
            node_data = nodes.get(node_ref)
            if not node_data:
                continue
            x, z = geographic_to_local(node_data["lat"], node_data["lon"])
            points.append({"x": round(x, 3), "z": round(z, 3), "corner": None})

        if len(points) < 3:
            continue
        if points[-1] == points[0]:
            points.pop()
        if len(points) < 3:
            continue

        height_cm, height_source = _parse_height_cm(tags)
        min_x = min(point["x"] for point in points)
        max_x = max(point["x"] for point in points)
        min_z = min(point["z"] for point in points)
        max_z = max(point["z"] for point in points)

        building_type, raw_building_type = _normalize_building_type(tags.get("building"))
        color = BUILDING_TYPE_COLORS.get(building_type, DEFAULT_BUILDING_COLOR)

        zone: dict[str, Any] = {
            "id": f"building-{osm_way_id}",
            "type": "forbidden",
            "label": tags.get("name", f"Bâtiment {len(buildings) + 1:03d}"),
            "x": round(min_x, 3),
            "z": round(min_z, 3),
            "width": round(max_x - min_x, 3),
            "depth": round(max_z - min_z, 3),
            "rotationDeg": 0,
            "rows": None,
            "cols": None,
            "shape": "polygon",
            "color": color,
            "opacity": 1,
            "points": points,
            "pathMode": "linear",
            "mounted": False,
            "heightCm": round(height_cm, 2),
            "_source": {
                "osmWayId": osm_way_id,
                "building": tags.get("building"),
                "buildingType": building_type,
                "buildingTypeRaw": raw_building_type,
                "heightSource": height_source,
            },
        }
        if tags.get("height") is not None:
            zone["_source"]["height"] = tags["height"]
        if tags.get("building:levels") is not None:
            zone["_source"]["building:levels"] = tags["building:levels"]
        buildings.append(zone)

    if not buildings:
        raise ValueError("Aucun bâtiment trouvé dans le fichier OSM.")

    global_width = max(building["x"] + building["width"] for building in buildings)
    global_depth = max(building["z"] + building["depth"] for building in buildings)
    generated_project_id = project_id or str(uuid4())
    generated_store_id = store_id or str(uuid4())
    timestamp = exported_at or datetime.now(timezone.utc).isoformat()

    return {
        "version": "1.0",
        "projectId": generated_project_id,
        "projectName": project_name,
        "exportedAt": timestamp,
        "unit": "cm",
        "source": {
            "format": "OpenStreetMap XML",
            "geometry": "building ways",
            "buildingCount": len(buildings),
            "geometryPolicy": (
                "OSM footprint node geometry preserved; no simplification, "
                "rotation, or non-uniform scaling"
            ),
            "colorPolicy": "deterministic color map by OSM building type, with fallback for other types",
            "buildingTypeColors": BUILDING_TYPE_COLORS,
            "heightPolicy": (
                "explicit OSM height when available; otherwise building:levels × 3m; "
                "0 when no source height information is available"
            ),
        },
        "store": {
            "id": generated_store_id,
            "name": project_name,
            "dimensions": {
                "width": round(global_width, 3),
                "depth": round(global_depth, 3),
                "height": 2500.0,
            },
            "zones": buildings,
        },
        "furniture": [],
    }
