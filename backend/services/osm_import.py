from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from datetime import datetime, timezone
from math import cos, radians
from typing import Any
from uuid import uuid4


# ============================================================
# CONFIGURATION
# ============================================================

METERS_PER_LEVEL = 3.0
DEFAULT_BUILDING_HEIGHT_CM = 1000.0  # 10 m

DEFAULT_BUILDING_COLOR = "#9CA3AF"

KNOWN_HEIGHT_OPACITY = 0.62
MISSING_HEIGHT_OPACITY = 0.32


_HEIGHT_PATTERN = re.compile(
    r"^([0-9]+(?:\.[0-9]+)?)\s*(cm|m)?$",
    re.IGNORECASE,
)


# ============================================================
# COULEURS PAR TYPE DE BÂTIMENT
# ============================================================

BUILDING_TYPE_COLORS = {
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

    "other": "#9CA3AF",
}


# ============================================================
# NORMALISATION DES TYPES
# ============================================================

_BUILDING_TYPE_ALIASES = {
    # Residential
    "residential": "residential",
    "apartments": "apartments",
    "apartment": "apartments",

    "detached": "house",
    "semidetached_house": "house",
    "semi-detached": "house",
    "terrace": "house",
    "terraced": "house",
    "bungalow": "house",
    "house": "house",

    # Commercial / retail
    "commercial": "commercial",
    "retail": "retail",
    "supermarket": "retail",
    "mall": "retail",

    # Office
    "office": "office",

    # Industrial
    "industrial": "industrial",
    "factory": "industrial",
    "warehouse": "warehouse",

    # Civic / public
    "public": "civic",
    "government": "civic",
    "civic": "civic",
    "train_station": "civic",
    "transportation": "civic",

    # Education
    "school": "school",
    "college": "school",
    "university": "school",
    "kindergarten": "school",

    # Healthcare
    "hospital": "hospital",
    "clinic": "hospital",
    "doctors": "hospital",

    # Religious
    "church": "religious",
    "cathedral": "religious",
    "mosque": "religious",
    "synagogue": "religious",
    "temple": "religious",
    "chapel": "religious",

    # Garage
    "garage": "garage",
    "garages": "garage",
    "carport": "garage",
    "shed": "garage",
}


_GENERIC_BUILDING_VALUES = {
    "yes",
    "building",
    "true",
    "1",
}


# ============================================================
# TYPES OSM NON-BÂTIMENTS
# ============================================================

_NON_BUILDING_SEMANTIC_TYPES = {
    "road",
    "path",
    "cycleway",
    "footway",
    "pedestrian",
    "parking",
    "park",
    "garden",
    "water",
    "railway",
    "station",
    "sports",
    "recreation",
    "landuse",
    "natural",
}


# ============================================================
# OUTILS
# ============================================================

def _safe_float(value: str | None) -> float | None:
    if value is None:
        return None

    try:
        return float(value.strip())
    except (ValueError, AttributeError):
        return None


def _normalize_building_type(value: str | None) -> str:
    if not value:
        return "other"

    value = value.strip().lower()

    return _BUILDING_TYPE_ALIASES.get(
        value,
        "other",
    )


def _parse_height_cm(value: str | None) -> float | None:
    """
    Convertit :
        10       -> 1000 cm
        10m      -> 1000 cm
        10 m     -> 1000 cm
        1000cm   -> 1000 cm
        1000 cm  -> 1000 cm
    """

    if not value:
        return None

    value = value.strip().lower()

    match = _HEIGHT_PATTERN.match(value)

    if not match:
        return None

    number = float(match.group(1))
    unit = match.group(2)

    if unit == "cm":
        return number

    # OSM utilise généralement des mètres pour height.
    # Sans unité explicite, on considère également des mètres.
    return number * 100.0


def _first_tag(tags: dict[str, str], *names: str) -> tuple[str | None, str | None]:
    """
    Retourne (nom_du_tag, valeur) pour le premier tag présent.
    """

    for name in names:
        value = tags.get(name)

        if value:
            return name, value.strip().lower()

    return None, None


# ============================================================
# CLASSIFICATION SÉMANTIQUE OSM
# ============================================================

def _classify_osm_type(
    tags: dict[str, str],
) -> tuple[str, str | None, str | None]:
    """
    Retourne :

        semantic_type
        source_tag
        raw_value

    Exemple :

        building=yes + shop=supermarket

    =>

        retail
        shop
        supermarket

    Alors que :

        building=school

    =>

        school
        building
        school
    """

    building = tags.get("building", "").strip().lower()

    # --------------------------------------------------------
    # 1. TYPE BUILDING EXPLICITE ET SPÉCIFIQUE
    # --------------------------------------------------------

    if building and building not in _GENERIC_BUILDING_VALUES:

        normalized = _normalize_building_type(building)

        if normalized != "other":
            return normalized, "building", building

    # --------------------------------------------------------
    # 2. SHOP
    # --------------------------------------------------------

    shop = tags.get("shop", "").strip().lower()

    if shop:

        retail_values = {
            "supermarket",
            "hypermarket",
            "convenience",
            "department_store",
            "mall",
            "clothes",
            "shoes",
            "bakery",
            "butcher",
            "beverages",
            "electronics",
            "furniture",
            "hardware",
            "doityourself",
            "mobile_phone",
            "books",
            "beauty",
            "jewelry",
            "sports",
            "car",
            "car_repair",
            "fuel",
        }

        if shop in retail_values:
            return "retail", "shop", shop

        return "commercial", "shop", shop

    # --------------------------------------------------------
    # 3. OFFICE
    # --------------------------------------------------------

    office = tags.get("office", "").strip().lower()

    if office:
        return "office", "office", office

    # --------------------------------------------------------
    # 4. INDUSTRIAL
    # --------------------------------------------------------

    industrial = tags.get("industrial", "").strip().lower()

    if industrial:
        if industrial in {
            "warehouse",
            "storage",
            "distribution",
        }:
            return "warehouse", "industrial", industrial

        return "industrial", "industrial", industrial

    # --------------------------------------------------------
    # 5. HEALTHCARE
    # --------------------------------------------------------

    healthcare = tags.get("healthcare", "").strip().lower()

    if healthcare:
        return "hospital", "healthcare", healthcare

    # --------------------------------------------------------
    # 6. AMENITY
    # --------------------------------------------------------

    amenity = tags.get("amenity", "").strip().lower()

    amenity_mapping = {
        "school": "school",
        "college": "school",
        "university": "school",
        "kindergarten": "school",

        "hospital": "hospital",
        "clinic": "hospital",

        "place_of_worship": "religious",

        "townhall": "civic",
        "courthouse": "civic",
        "community_centre": "civic",
        "library": "civic",
        "fire_station": "civic",
        "police": "civic",
    }

    if amenity in amenity_mapping:
        return amenity_mapping[amenity], "amenity", amenity

    # --------------------------------------------------------
    # 7. BÂTIMENT GÉNÉRIQUE
    # --------------------------------------------------------

    if building:
        return "other", "building", building

    # --------------------------------------------------------
    # 8. HIGHWAY
    # --------------------------------------------------------

    highway = tags.get("highway", "").strip().lower()

    if highway:

        if highway in {"footway", "path"}:
            return "path", "highway", highway

        if highway == "cycleway":
            return "cycleway", "highway", highway

        if highway == "pedestrian":
            return "pedestrian", "highway", highway

        return "road", "highway", highway

    # --------------------------------------------------------
    # 9. PARKING
    # --------------------------------------------------------

    parking = tags.get("parking", "").strip().lower()

    if parking:
        return "parking", "parking", parking

    # --------------------------------------------------------
    # 10. LEISURE / PARK
    # --------------------------------------------------------

    leisure = tags.get("leisure", "").strip().lower()

    if leisure:

        if leisure in {
            "park",
            "garden",
            "nature_reserve",
        }:
            return "park", "leisure", leisure

        if leisure in {
            "sports_centre",
            "stadium",
            "pitch",
            "sports_hall",
            "swimming_pool",
            "fitness_centre",
        }:
            return "sports", "leisure", leisure

        return "recreation", "leisure", leisure

    # --------------------------------------------------------
    # 11. NATURAL
    # --------------------------------------------------------

    natural = tags.get("natural", "").strip().lower()

    if natural:

        if natural in {
            "water",
            "bay",
            "coastline",
        }:
            return "water", "natural", natural

        return "natural", "natural", natural

    # --------------------------------------------------------
    # 12. LANDUSE
    # --------------------------------------------------------

    landuse = tags.get("landuse", "").strip().lower()

    if landuse:
        return "landuse", "landuse", landuse

    # --------------------------------------------------------
    # 13. RAILWAY
    # --------------------------------------------------------

    railway = tags.get("railway", "").strip().lower()

    if railway:

        if railway in {
            "station",
            "halt",
            "tram_stop",
            "subway_entrance",
        }:
            return "station", "railway", railway

        return "railway", "railway", railway

    # --------------------------------------------------------
    # 14. PUBLIC TRANSPORT
    # --------------------------------------------------------

    public_transport = tags.get("public_transport", "").strip().lower()

    if public_transport:
        return "station", "public_transport", public_transport

    # --------------------------------------------------------
    # 15. MAN MADE
    # --------------------------------------------------------

    man_made = tags.get("man_made", "").strip().lower()

    if man_made:

        if man_made in {
            "tower",
            "water_tower",
            "communications_tower",
            "mast",
        }:
            return "other", "man_made", man_made

        return "other", "man_made", man_made

    # --------------------------------------------------------
    # 16. POWER
    # --------------------------------------------------------

    power = tags.get("power", "").strip().lower()

    if power:
        return "other", "power", power

    return "other", None, None


# ============================================================
# DÉTERMINATION : EST-CE PROBABLEMENT UN BÂTIMENT ?
# ============================================================

def _infer_building_status(
    tags: dict[str, str],
    semantic_type: str,
    semantic_source_tag: str | None,
    closed: bool,
) -> tuple[bool, float, str]:
    """
    Retourne :

        isLikelyBuilding
        confidence
        geometryRole
    """

    building = tags.get("building", "").strip().lower()

    # --------------------------------------------------------
    # BUILDING EXPLICITE
    # --------------------------------------------------------

    if building:

        return True, 1.0, "building"

    # --------------------------------------------------------
    # SHOP
    # --------------------------------------------------------

    if tags.get("shop"):
        if closed:
            return True, 0.72, "commercial_area"

        return False, 0.25, "poi"

    # --------------------------------------------------------
    # OFFICE
    # --------------------------------------------------------

    if tags.get("office"):
        if closed:
            return True, 0.80, "building"

        return False, 0.25, "poi"

    # --------------------------------------------------------
    # INDUSTRIAL
    # --------------------------------------------------------

    if tags.get("industrial"):
        if closed:
            return True, 0.78, "industrial_area"

        return False, 0.25, "poi"

    # --------------------------------------------------------
    # HEALTHCARE
    # --------------------------------------------------------

    if tags.get("healthcare"):
        if closed:
            return True, 0.75, "facility"

        return False, 0.30, "poi"

    # --------------------------------------------------------
    # AMENITIES QUI SONT TYPiquement DES BÂTIMENTS
    # --------------------------------------------------------

    amenity = tags.get("amenity", "").strip().lower()

    building_like_amenities = {
        "school",
        "college",
        "university",
        "kindergarten",
        "hospital",
        "clinic",
        "townhall",
        "courthouse",
        "community_centre",
        "library",
        "fire_station",
        "police",
        "place_of_worship",
    }

    if amenity in building_like_amenities:

        if closed:
            return True, 0.70, "facility"

        return False, 0.25, "poi"

    # --------------------------------------------------------
    # PARKING / PARK / WATER / ROUTES
    # --------------------------------------------------------

    if semantic_type in {
        "road",
        "path",
        "cycleway",
        "footway",
        "pedestrian",
        "parking",
        "park",
        "garden",
        "water",
        "railway",
        "station",
        "sports",
        "recreation",
        "landuse",
        "natural",
    }:
        return False, 0.0, "surface"

    # --------------------------------------------------------
    # AUTRES OBJETS FERMÉS
    # --------------------------------------------------------

    if closed:
        return False, 0.20, "surface"

    return False, 0.0, "poi"


# ============================================================
# CONVERSION OSM XML -> RETAIL LAYOUT
# ============================================================

def osm_xml_to_retail_layout(
    osm_xml: str,
    project_name: str = "OSM Import",
) -> dict[str, Any]:

    root = ET.fromstring(osm_xml)

    # ========================================================
    # NODES
    # ========================================================

    nodes: dict[str, tuple[float, float]] = {}

    for node in root.findall("node"):

        node_id = node.attrib.get("id")
        lat = _safe_float(node.attrib.get("lat"))
        lon = _safe_float(node.attrib.get("lon"))

        if (
            node_id is not None
            and lat is not None
            and lon is not None
        ):
            nodes[node_id] = (lat, lon)

    # ========================================================
    # BOUNDS OSM
    # ========================================================

    bounds_element = root.find("bounds")

    min_lat = None
    max_lat = None
    min_lon = None
    max_lon = None

    if bounds_element is not None:

        min_lat = _safe_float(
            bounds_element.attrib.get("minlat")
        )

        max_lat = _safe_float(
            bounds_element.attrib.get("maxlat")
        )

        min_lon = _safe_float(
            bounds_element.attrib.get("minlon")
        )

        max_lon = _safe_float(
            bounds_element.attrib.get("maxlon")
        )

    # ========================================================
    # WAYS
    # ========================================================

    ways: list[dict[str, Any]] = []

    for way in root.findall("way"):

        way_id = way.attrib.get("id")

        if way_id is None:
            continue

        # ----------------------------------------------------
        # TAGS
        # ----------------------------------------------------

        tags: dict[str, str] = {}

        for tag in way.findall("tag"):

            key = tag.attrib.get("k")
            value = tag.attrib.get("v")

            if key and value is not None:
                tags[key] = value

        # ----------------------------------------------------
        # NODES DU WAY
        # ----------------------------------------------------

        node_refs: list[str] = []

        for nd in way.findall("nd"):

            ref = nd.attrib.get("ref")

            if ref:
                node_refs.append(ref)

        coords: list[tuple[float, float]] = []

        for ref in node_refs:

            if ref in nodes:
                coords.append(nodes[ref])

        if len(coords) < 2:
            continue

        # ----------------------------------------------------
        # WAY FERMÉ
        # ----------------------------------------------------

        closed = (
            len(node_refs) >= 4
            and node_refs[0] == node_refs[-1]
        )

        # ====================================================
        # CLASSIFICATION
        # ====================================================

        semantic_type, semantic_source_tag, semantic_raw_value = (
            _classify_osm_type(tags)
        )

        (
            is_likely_building,
            building_confidence,
            geometry_role,
        ) = _infer_building_status(
            tags=tags,
            semantic_type=semantic_type,
            semantic_source_tag=semantic_source_tag,
            closed=closed,
        )

        # ====================================================
        # IMPORTANT :
        # LE MODÈLE SceneData N'ACCEPTE PAS shape="line"
        #
        # Les ways ouverts sont donc ignorés pour store.zones.
        #
        # On pourra plus tard créer un store.osmLines séparé
        # si le modèle Pydantic est étendu.
        # ====================================================

        if not closed:
            continue

        # ====================================================
        # COORDONNÉES DU WAY
        # ====================================================

        polygon_coords = list(coords)

        # Retirer le dernier point s'il répète le premier.
        if len(polygon_coords) >= 2:

            if polygon_coords[0] == polygon_coords[-1]:
                polygon_coords.pop()

        if len(polygon_coords) < 3:
            continue

        # ====================================================
        # EXTENT GLOBAL
        # ====================================================

        if polygon_coords:

            way_lats = [
                point[0]
                for point in polygon_coords
            ]

            way_lons = [
                point[1]
                for point in polygon_coords
            ]

            if min_lat is None:
                min_lat = min(way_lats)

            if max_lat is None:
                max_lat = max(way_lats)

            if min_lon is None:
                min_lon = min(way_lons)

            if max_lon is None:
                max_lon = max(way_lons)

    # ========================================================
    # FALLBACK SI PAS DE BOUNDS OSM
    # ========================================================

    if not nodes:
        raise ValueError(
            "Aucun node OSM exploitable trouvé."
        )

    if min_lat is None:
        min_lat = min(
            lat
            for lat, _ in nodes.values()
        )

    if max_lat is None:
        max_lat = max(
            lat
            for lat, _ in nodes.values()
        )

    if min_lon is None:
        min_lon = min(
            lon
            for _, lon in nodes.values()
        )

    if max_lon is None:
        max_lon = max(
            lon
            for _, lon in nodes.values()
        )

    # ========================================================
    # PROJECTION LOCALE
    # ========================================================

    center_lat = (
        min_lat + max_lat
    ) / 2.0

    meters_per_degree_lat = 111_320.0

    meters_per_degree_lon = (
        111_320.0
        * cos(radians(center_lat))
    )

    def project(
        lat: float,
        lon: float,
    ) -> tuple[float, float]:

        x_m = (
            lon - min_lon
        ) * meters_per_degree_lon

        z_m = (
            max_lat - lat
        ) * meters_per_degree_lat

        return (
            x_m * 100.0,
            z_m * 100.0,
        )

    # ========================================================
    # ZONES
    # ========================================================

    zones: list[dict[str, Any]] = []

    building_count = 0

    # Reboucle sur les ways maintenant que la projection existe.
    for way in root.findall("way"):

        way_id = way.attrib.get("id")

        if way_id is None:
            continue

        # ----------------------------------------------------
        # TAGS
        # ----------------------------------------------------

        tags: dict[str, str] = {}

        for tag in way.findall("tag"):

            key = tag.attrib.get("k")
            value = tag.attrib.get("v")

            if key and value is not None:
                tags[key] = value

        # ----------------------------------------------------
        # NODES
        # ----------------------------------------------------

        node_refs = []

        for nd in way.findall("nd"):

            ref = nd.attrib.get("ref")

            if ref:
                node_refs.append(ref)

        if len(node_refs) < 3:
            continue

        closed = (
            len(node_refs) >= 4
            and node_refs[0] == node_refs[-1]
        )

        # ----------------------------------------------------
        # PAS DE LIGNES DANS store.zones
        # ----------------------------------------------------

        if not closed:
            continue

        coords = []

        for ref in node_refs:

            if ref in nodes:
                coords.append(nodes[ref])

        if len(coords) < 3:
            continue

        # Retire fermeture
        if coords[0] == coords[-1]:
            coords.pop()

        if len(coords) < 3:
            continue

        # ====================================================
        # CLASSIFICATION
        # ====================================================

        (
            semantic_type,
            semantic_source_tag,
            semantic_raw_value,
        ) = _classify_osm_type(tags)

        (
            is_likely_building,
            building_confidence,
            geometry_role,
        ) = _infer_building_status(
            tags=tags,
            semantic_type=semantic_type,
            semantic_source_tag=semantic_source_tag,
            closed=closed,
        )

        # ====================================================
        # PROJECTION DU POLYGONE
        # ====================================================

        points = []

        for lat, lon in coords:

            x_cm, z_cm = project(
                lat,
                lon,
            )

            points.append([
                round(x_cm, 2),
                round(z_cm, 2),
            ])

        if len(points) < 3:
            continue

        # ====================================================
        # BOUNDING BOX
        # ====================================================

        xs = [
            point[0]
            for point in points
        ]

        zs = [
            point[1]
            for point in points
        ]

        min_x = min(xs)
        max_x = max(xs)

        min_z = min(zs)
        max_z = max(zs)

        x = (
            min_x + max_x
        ) / 2.0

        z = (
            min_z + max_z
        ) / 2.0

        width = max(
            max_x - min_x,
            1.0,
        )

        depth = max(
            max_z - min_z,
            1.0,
        )

        # ====================================================
        # HAUTEUR
        # ====================================================

        height_cm = None
        height_source = None
        default_height_applied = False

        # ----------------------------------------------------
        # 1. height
        # ----------------------------------------------------

        raw_height = tags.get("height")

        if raw_height:

            parsed_height = _parse_height_cm(
                raw_height
            )

            if parsed_height is not None:

                height_cm = parsed_height
                height_source = "height"

        # ----------------------------------------------------
        # 2. building:levels
        # ----------------------------------------------------

        if (
            height_cm is None
            and is_likely_building
        ):

            raw_levels = tags.get(
                "building:levels"
            )

            levels = _safe_float(
                raw_levels
            )

            if levels is not None and levels > 0:

                height_cm = (
                    levels
                    * METERS_PER_LEVEL
                    * 100.0
                )

                height_source = (
                    "building:levels"
                )

        # ----------------------------------------------------
        # 3. DEFAULT
        # ----------------------------------------------------

        if (
            height_cm is None
            and is_likely_building
        ):

            height_cm = (
                DEFAULT_BUILDING_HEIGHT_CM
            )

            height_source = "default"

            default_height_applied = True

        # ----------------------------------------------------
        # NON-BÂTIMENT
        # ----------------------------------------------------

        if not is_likely_building:

            height_cm = 0.0
            height_source = "not_a_building"

        # ====================================================
        # COULEUR
        # ====================================================

        color = BUILDING_TYPE_COLORS.get(
            semantic_type,
            DEFAULT_BUILDING_COLOR,
        )

        # ====================================================
        # OPACITÉ
        # ====================================================

        if is_likely_building:

            if height_source in {
                "height",
                "building:levels",
            }:
                opacity = KNOWN_HEIGHT_OPACITY

            else:
                opacity = MISSING_HEIGHT_OPACITY

        else:
            opacity = 0.20

        # ====================================================
        # LABEL
        # ====================================================

        name = (
            tags.get("name")
            or tags.get("official_name")
            or tags.get("alt_name")
        )

        if not name:

            if semantic_type != "other":
                name = semantic_type
            else:
                name = f"OSM {way_id}"

        # ====================================================
        # SOURCE OSM
        # ====================================================

        source_data: dict[str, Any] = {
            "osmWayId": way_id,

            # Classification originale
            "building": tags.get("building"),

            # Classification sémantique
            "buildingType": semantic_type,
            "buildingTypeRaw": tags.get("building"),

            "semanticType": semantic_type,
            "semanticSourceTag": semantic_source_tag,
            "semanticRawValue": semantic_raw_value,

            # Géométrie / inférence
            "geometryRole": geometry_role,
            "isLikelyBuilding": is_likely_building,
            "buildingConfidence": building_confidence,

            # Hauteur
            "heightSource": height_source,
            "defaultHeightApplied": default_height_applied,

            # Tous les tags OSM
            "tags": tags,
        }

        if raw_height:
            source_data["height"] = raw_height

        raw_levels = tags.get(
            "building:levels"
        )

        if raw_levels:
            source_data["building:levels"] = raw_levels

        if "name" in tags:
            source_data["name"] = tags["name"]

        # ====================================================
        # ZONE
        # ====================================================

        zone = {
            "id": f"building-{way_id}",

            "type": "forbidden",

            "label": name,

            "x": round(x, 2),
            "z": round(z, 2),

            "width": round(width, 2),
            "depth": round(depth, 2),

            "rotationDeg": 0,

            "rows": None,
            "cols": None,

            # IMPORTANT :
            # SceneData accepte uniquement :
            # rectangle / circle / diamond / polygon
            "shape": "polygon",

            "color": color,

            "points": points,

            "pathMode": "linear",

            "mounted": True,

            "opacity": opacity,

            "heightCm": round(
                height_cm,
                2,
            ),

            "_source": source_data,
        }

        zones.append(zone)

        if is_likely_building:
            building_count += 1

    # ========================================================
    # DIMENSIONS GLOBALES
    # ========================================================

    all_x = []
    all_z = []

    for zone in zones:

        for point in zone["points"]:

            all_x.append(point[0])
            all_z.append(point[1])

    if all_x:

        scene_width = (
            max(all_x)
            - min(all_x)
        )

        scene_depth = (
            max(all_z)
            - min(all_z)
        )

    else:

        scene_width = 0.0
        scene_depth = 0.0

    # Hauteur globale :
    # on prend la hauteur maximale réellement rencontrée.

    scene_height = 0.0

    for zone in zones:

        scene_height = max(
            scene_height,
            float(
                zone.get(
                    "heightCm",
                    0.0,
                )
            ),
        )

    # ========================================================
    # PAYLOAD FINAL
    # ========================================================

    payload = {
        "version": "1.0",

        "projectId": str(
            uuid4()
        ),

        "projectName": project_name,

        "exportedAt": datetime.now(
            timezone.utc
        ).isoformat(),

        "unit": "cm",

        # ====================================================
        # SOURCE
        # ====================================================

        "source": {
            "format": "OpenStreetMap XML",

            "geometry": (
                "closed OSM ways with "
                "semantic tags"
            ),

            "buildingCount": building_count,

            "objectCount": len(zones),

            "geometryPolicy": (
                "Closed ways are exported as "
                "polygon zones. Open ways are "
                "skipped because SceneData does "
                "not support line zones."
            ),

            "colorPolicy": (
                "Colors are derived from semantic "
                "OSM building/function tags."
            ),

            "buildingTypeColors": (
                BUILDING_TYPE_COLORS
            ),

            "heightPolicy": {
                "height": (
                    "OSM height tag has priority."
                ),
                "building:levels": (
                    "3 meters per level."
                ),
                "default": (
                    "10 meters when a building "
                    "has no height information."
                ),
                "nonBuilding": (
                    "0 cm."
                ),
            },
        },

        # ====================================================
        # STORE
        # ====================================================

        "store": {
            "id": str(
                uuid4()
            ),

            "name": project_name,

            "width": round(
                scene_width,
                2,
            ),

            "depth": round(
                scene_depth,
                2,
            ),

            "height": round(
                scene_height,
                2,
            ),

            "zones": zones,
        },

        # ====================================================
        # FURNITURE
        # ====================================================

        "furniture": [],
    }

    return payload
