from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from math import cos, radians
from typing import Any
from uuid import uuid4


METERS_PER_LEVEL = 3.0

DEFAULT_BUILDING_HEIGHT_CM = 1000.0
DEFAULT_BUILDING_COLOR = "#9CA3AF"

KNOWN_HEIGHT_OPACITY = 0.62
MISSING_HEIGHT_OPACITY = 0.32

_HEIGHT_PATTERN = re.compile(
    r"^([0-9]+(?:\.[0-9]+)?)\s*(cm|m)?$"
)


# ============================================================
# COULEURS
# ============================================================

BUILDING_TYPE_COLORS: dict[str, str] = {

    # Habitat
    "residential": "#F4A261",
    "apartments": "#E9C46A",
    "house": "#F7B267",

    # Commerce
    "commercial": "#457B9D",
    "retail": "#2A9D8F",

    # Bureaux / industrie
    "office": "#577590",
    "industrial": "#6A994E",
    "warehouse": "#4D908E",

    # Public
    "civic": "#1D3557",
    "school": "#90BE6D",
    "hospital": "#E76F51",
    "religious": "#9B5DE5",

    # Services
    "garage": "#BC6C25",
    "pharmacy": "#43AA8B",
    "bank": "#577590",

    # Restauration
    "restaurant": "#E76F51",
    "cafe": "#B56576",
    "bar": "#6D597A",
    "fast_food": "#F4A261",

    # Transport
    "station": "#343A40",
    "transport": "#277DA1",

    # Autres
    "other": DEFAULT_BUILDING_COLOR,
}


# ============================================================
# TYPES DE BATIMENT OSM
# ============================================================

_BUILDING_TYPE_ALIASES: dict[str, str] = {

    # Habitat
    "detached": "house",
    "semidetached_house": "house",
    "terrace": "house",
    "bungalow": "house",

    "residential": "residential",
    "apartments": "apartments",
    "house": "house",

    # Commerce
    "commercial": "commercial",
    "retail": "retail",
    "supermarket": "retail",
    "mall": "retail",
    "department_store": "retail",

    # Bureau
    "office": "office",

    # Industrie
    "industrial": "industrial",
    "factory": "industrial",
    "warehouse": "warehouse",

    # Public
    "public": "civic",
    "government": "civic",
    "train_station": "station",
    "transportation": "transport",

    # Education
    "school": "school",
    "college": "school",
    "university": "school",
    "kindergarten": "school",

    # Santé
    "hospital": "hospital",
    "clinic": "hospital",
    "doctors": "hospital",

    # Religieux
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


# ============================================================
# AMENITY
# ============================================================

_AMENITY_TYPE_ALIASES: dict[str, str] = {

    "school": "school",
    "college": "school",
    "university": "school",
    "kindergarten": "school",

    "hospital": "hospital",
    "clinic": "hospital",
    "doctors": "hospital",
    "dentist": "hospital",

    "pharmacy": "pharmacy",

    "restaurant": "restaurant",
    "cafe": "cafe",
    "bar": "bar",
    "fast_food": "fast_food",

    "bank": "bank",

    "library": "civic",
    "townhall": "civic",
    "police": "civic",
    "fire_station": "civic",
    "post_office": "civic",
    "community_centre": "civic",
}


# ============================================================
# SHOP
# ============================================================

_SHOP_TYPE_ALIASES: dict[str, str] = {

    "supermarket": "retail",
    "convenience": "retail",
    "department_store": "retail",
    "mall": "retail",

    "clothes": "retail",
    "shoes": "retail",
    "electronics": "retail",
    "computer": "retail",
    "mobile_phone": "retail",

    "furniture": "retail",
    "hardware": "retail",
    "doityourself": "retail",

    "bakery": "retail",
    "butcher": "retail",
    "books": "retail",
    "florist": "retail",
    "beverages": "retail",
    "beauty": "retail",
    "hairdresser": "retail",
    "jewelry": "retail",
    "optician": "retail",
}


# ============================================================
# VALEURS GENERIQUES
# ============================================================

_GENERIC_BUILDING_VALUES = {
    "yes",
    "building",
    "true",
    "1",
}


# ============================================================
# TYPES QUI PEUVENT INDIQUER UN BATIMENT
# ============================================================

_BUILDING_LIKE_AMENITIES = {
    "school",
    "college",
    "university",
    "kindergarten",

    "hospital",
    "clinic",
    "doctors",
    "dentist",

    "pharmacy",
    "bank",

    "restaurant",
    "cafe",
    "bar",
    "fast_food",

    "library",
    "townhall",
    "police",
    "fire_station",
    "post_office",
    "community_centre",
}


# ============================================================
# TYPES QUI NE DOIVENT PAS ETRE CONSIDERES COMME BATIMENTS
# ============================================================

_NON_BUILDING_AMENITIES = {
    "parking",
    "parking_space",
    "fuel",
    "bench",
    "waste_basket",
    "bicycle_parking",
    "drinking_water",
    "post_box",
    "recycling",
}


# ============================================================
# TYPES OSM PERTINENTS
# ============================================================

_RELEVANT_TAGS = {

    "building",
    "building:levels",
    "height",

    "amenity",
    "shop",
    "office",
    "industrial",
    "healthcare",

    "highway",
    "landuse",
    "leisure",
    "natural",

    "waterway",
    "railway",
    "public_transport",

    "tourism",
    "man_made",
    "power",
}


# ============================================================
# OUTILS
# ============================================================

def _safe_float(value: str) -> float:
    return float(
        value.strip().replace(",", ".")
    )


def _normalize_building_type(
    raw_value: str | None,
) -> tuple[str, str]:

    raw = (
        raw_value or ""
    ).strip().lower()

    if not raw:
        return "other", "other"

    token = raw.split(";", 1)[0].strip()

    mapped = _BUILDING_TYPE_ALIASES.get(token)

    if mapped:
        return mapped, token

    if token in _GENERIC_BUILDING_VALUES:
        return "other", token

    return "other", token


# ============================================================
# CLASSIFICATION FONCTIONNELLE
# ============================================================

def _classify_osm_type(
    tags: dict[str, str],
) -> tuple[str, str, str]:
    """
    Retourne :

    semantic_type
    source_tag
    raw_value

    IMPORTANT :
    building=yes n'est pas prioritaire sur shop/amenity/etc.
    lorsqu'un tag fonctionnel plus précis existe.
    """

    # --------------------------------------------------------
    # 1. BUILDING NON GENERIQUE
    # --------------------------------------------------------

    building = (
        tags.get("building", "")
        .strip()
        .lower()
    )

    if building:

        normalized = _BUILDING_TYPE_ALIASES.get(
            building
        )

        if normalized:
            return (
                normalized,
                "building",
                building,
            )

    # --------------------------------------------------------
    # 2. SHOP
    # --------------------------------------------------------

    shop = (
        tags.get("shop", "")
        .strip()
        .lower()
    )

    if shop:

        normalized = _SHOP_TYPE_ALIASES.get(
            shop,
            "retail",
        )

        return (
            normalized,
            "shop",
            shop,
        )

    # --------------------------------------------------------
    # 3. OFFICE
    # --------------------------------------------------------

    office = (
        tags.get("office", "")
        .strip()
        .lower()
    )

    if office:
        return (
            "office",
            "office",
            office,
        )

    # --------------------------------------------------------
    # 4. INDUSTRIAL
    # --------------------------------------------------------

    industrial = (
        tags.get("industrial", "")
        .strip()
        .lower()
    )

    if industrial:
        return (
            "industrial",
            "industrial",
            industrial,
        )

    # --------------------------------------------------------
    # 5. HEALTHCARE
    # --------------------------------------------------------

    healthcare = (
        tags.get("healthcare", "")
        .strip()
        .lower()
    )

    if healthcare:
        return (
            "hospital",
            "healthcare",
            healthcare,
        )

    # --------------------------------------------------------
    # 6. AMENITY
    # --------------------------------------------------------

    amenity = (
        tags.get("amenity", "")
        .strip()
        .lower()
    )

    if amenity:

        normalized = _AMENITY_TYPE_ALIASES.get(
            amenity
        )

        if normalized:
            return (
                normalized,
                "amenity",
                amenity,
            )

    # --------------------------------------------------------
    # 7. BUILDING GENERIQUE
    # --------------------------------------------------------

    if building:
        return (
            "other",
            "building",
            building,
        )

    # --------------------------------------------------------
    # 8. AUTRES TAGS
    #
    # Ils permettent de conserver l'objet dans la scène,
    # mais ne le transforment pas automatiquement en bâtiment.
    # --------------------------------------------------------

    if "highway" in tags:
        return (
            "road",
            "highway",
            tags["highway"],
        )

    if "railway" in tags:

        railway = tags["railway"].lower()

        if railway in {
            "station",
            "halt",
        }:
            return (
                "station",
                "railway",
                railway,
            )

        return (
            "other",
            "railway",
            railway,
        )

    if "public_transport" in tags:
        return (
            "transport",
            "public_transport",
            tags["public_transport"],
        )

    if "waterway" in tags:
        return (
            "other",
            "waterway",
            tags["waterway"],
        )

    if "natural" in tags:
        return (
            "other",
            "natural",
            tags["natural"],
        )

    if "landuse" in tags:
        return (
            "other",
            "landuse",
            tags["landuse"],
        )

    if "leisure" in tags:
        return (
            "other",
            "leisure",
            tags["leisure"],
        )

    if "man_made" in tags:
        return (
            "other",
            "man_made",
            tags["man_made"],
        )

    if "power" in tags:
        return (
            "other",
            "power",
            tags["power"],
        )

    return (
        "other",
        "unknown",
        "other",
    )


# ============================================================
# ROLE GEOMETRIQUE / BATIMENT PROBABLE
# ============================================================

def _infer_geometry_role(
    tags: dict[str, str],
    closed: bool,
) -> tuple[str, bool, float]:
    """
    Retourne :

    geometry_role
    is_likely_building
    building_confidence
    """

    # --------------------------------------------------------
    # 1. BUILDING EXPLICITE
    # --------------------------------------------------------

    if "building" in tags:

        return (
            "building",
            True,
            1.0,
        )

    # --------------------------------------------------------
    # 2. SHOP
    #
    # Un shop sous forme de way fermé représente une
    # surface commerciale. Ce n'est pas une certitude
    # absolue sur la structure physique.
    # --------------------------------------------------------

    shop = (
        tags.get("shop", "")
        .strip()
        .lower()
    )

    if shop and closed:

        return (
            "commercial_area",
            True,
            0.72,
        )

    # --------------------------------------------------------
    # 3. OFFICE
    # --------------------------------------------------------

    office = (
        tags.get("office", "")
        .strip()
        .lower()
    )

    if office and closed:

        return (
            "building",
            True,
            0.80,
        )

    # --------------------------------------------------------
    # 4. INDUSTRIAL
    # --------------------------------------------------------

    industrial = (
        tags.get("industrial", "")
        .strip()
        .lower()
    )

    if industrial and closed:

        return (
            "industrial_area",
            True,
            0.78,
        )

    # --------------------------------------------------------
    # 5. HEALTHCARE
    # --------------------------------------------------------

    healthcare = (
        tags.get("healthcare", "")
        .strip()
        .lower()
    )

    if healthcare and closed:

        return (
            "facility",
            True,
            0.75,
        )

    # --------------------------------------------------------
    # 6. AMENITY
    # --------------------------------------------------------

    amenity = (
        tags.get("amenity", "")
        .strip()
        .lower()
    )

    if amenity:

        # Objets/surfaces qui ne sont pas des bâtiments.
        if amenity in _NON_BUILDING_AMENITIES:

            return (
                "surface",
                False,
                1.0,
            )

        # Services pouvant correspondre à un bâtiment.
        if (
            amenity in _BUILDING_LIKE_AMENITIES
            and closed
        ):

            return (
                "facility",
                True,
                0.70,
            )

    # --------------------------------------------------------
    # 7. HIGHWAY
    # --------------------------------------------------------

    if "highway" in tags:

        return (
            "line",
            False,
            1.0,
        )

    # --------------------------------------------------------
    # 8. RAILWAY
    # --------------------------------------------------------

    if "railway" in tags:

        railway = (
            tags["railway"]
            .strip()
            .lower()
        )

        if railway in {
            "station",
            "halt",
        } and closed:

            return (
                "facility",
                False,
                0.85,
            )

        return (
            "line",
            False,
            1.0,
        )

    # --------------------------------------------------------
    # 9. WATERWAY
    # --------------------------------------------------------

    if "waterway" in tags:

        return (
            "line",
            False,
            1.0,
        )

    # --------------------------------------------------------
    # 10. SURFACES
    # --------------------------------------------------------

    if "natural" in tags:

        return (
            "surface",
            False,
            1.0,
        )

    if "landuse" in tags:

        return (
            "surface",
            False,
            1.0,
        )

    if "leisure" in tags:

        return (
            "surface",
            False,
            1.0,
        )

    # --------------------------------------------------------
    # 11. TRANSPORT PUBLIC
    # --------------------------------------------------------

    if "public_transport" in tags:

        if closed:

            return (
                "facility",
                False,
                0.75,
            )

        return (
            "poi",
            False,
            0.90,
        )

    # --------------------------------------------------------
    # 12. MAN MADE
    # --------------------------------------------------------

    if "man_made" in tags:

        man_made = (
            tags["man_made"]
            .strip()
            .lower()
        )

        if man_made in {
            "tower",
            "water_tower",
            "silo",
            "chimney",
        }:

            return (
                "structure",
                False,
                0.95,
            )

        return (
            "surface" if closed else "line",
            False,
            0.50,
        )

    # --------------------------------------------------------
    # 13. POWER
    # --------------------------------------------------------

    if "power" in tags:

        return (
            "structure",
            False,
            0.90,
        )

    # --------------------------------------------------------
    # 14. FALLBACK
    # --------------------------------------------------------

    if closed:

        return (
            "surface",
            False,
            0.40,
        )

    return (
        "line",
        False,
        0.40,
    )


# ============================================================
# HAUTEUR
# ============================================================

def _parse_height_cm(
    tags: dict[str, str],
) -> tuple[float, str | None]:

    # --------------------------------------------------------
    # 1. HEIGHT
    # --------------------------------------------------------

    raw_height = tags.get("height")

    if raw_height:

        candidate = (
            raw_height
            .strip()
            .lower()
            .replace(",", ".")
        )

        match = _HEIGHT_PATTERN.match(
            candidate
        )

        if match:

            number = float(
                match.group(1)
            )

            unit = match.group(2)

            if unit == "cm":

                return (
                    number,
                    "OSM height",
                )

            return (
                number * 100,
                "OSM height",
            )

    # --------------------------------------------------------
    # 2. BUILDING LEVELS
    # --------------------------------------------------------

    raw_levels = tags.get(
        "building:levels"
    )

    if raw_levels:

        try:
            levels = _safe_float(
                raw_levels
            )
        except ValueError:
            levels = 0.0

        if levels > 0:

            return (
                levels
                * METERS_PER_LEVEL
                * 100,
                "OSM building:levels × 3m",
            )

    return (
        0.0,
        None,
    )


# ============================================================
# CONVERSION
# ============================================================

def osm_xml_to_retail_layout(
    xml_text: str,
    project_name: str,
    project_id: str | None = None,
    store_id: str | None = None,
    exported_at: str | None = None,
) -> dict[str, Any]:

    try:

        root = ET.fromstring(
            xml_text
        )

    except ET.ParseError as exc:

        raise ValueError(
            str(exc)
        ) from exc

    # ========================================================
    # NODES
    # ========================================================

    nodes: dict[
        str,
        dict[str, float]
    ] = {}

    for node in root.findall("node"):

        node_id = node.attrib.get(
            "id"
        )

        lat = node.attrib.get(
            "lat"
        )

        lon = node.attrib.get(
            "lon"
        )

        if (
            not node_id
            or lat is None
            or lon is None
        ):
            continue

        try:

            nodes[node_id] = {
                "lat": float(lat),
                "lon": float(lon),
            }

        except ValueError:

            continue

    ways = list(
        root.findall("way")
    )

    # ========================================================
    # RECHERCHE DES OBJETS PERTINENTS
    # ========================================================
    #
    # AVANT :
    #
    #     if "building" not in tags:
    #         continue
    #
    # MAINTENANT :
    #
    # On conserve les ways qui peuvent représenter :
    #
    # - bâtiment
    # - commerce
    # - bureau
    # - industrie
    # - équipement
    #
    # mais aussi les autres éléments utiles à la scène.
    #
    # Les routes/parcs/etc. ne seront simplement pas
    # considérés comme des bâtiments grâce à
    # _infer_geometry_role().
    # ========================================================

    relevant_ways: list[
        tuple[Any, dict[str, str]]
    ] = []

    for way in ways:

        tags: dict[str, str] = {}

        for tag in way.findall("tag"):

            key = tag.attrib.get("k")
            value = tag.attrib.get("v")

            if (
                key is not None
                and value is not None
            ):

                tags[key] = value

        if not any(
            key in tags
            for key in _RELEVANT_TAGS
        ):
            continue

        relevant_ways.append(
            (way, tags)
        )

    # ========================================================
    # COORDONNEES DE REFERENCE
    # ========================================================

    relevant_node_coords: list[
        dict[str, float]
    ] = []

    for way, tags in relevant_ways:

        for nd in way.findall("nd"):

            node_ref = nd.attrib.get(
                "ref"
            )

            if not node_ref:
                continue

            node_data = nodes.get(
                node_ref
            )

            if node_data:

                relevant_node_coords.append(
                    node_data
                )

    if not relevant_node_coords:

        raise ValueError(
            "Aucun objet géométrique trouvé dans le fichier OSM."
        )

    # ========================================================
    # BOUNDS
    # ========================================================

    bounds = root.find(
        "bounds"
    )

    if bounds is not None:

        try:

            min_lat = float(
                bounds.attrib["minlat"]
            )

            max_lat = float(
                bounds.attrib["maxlat"]
            )

            min_lon = float(
                bounds.attrib["minlon"]
            )

        except (
            KeyError,
            ValueError,
        ) as exc:

            raise ValueError(
                "Invalid OSM <bounds> attributes."
            ) from exc

    else:

        min_lat = min(
            node["lat"]
            for node in relevant_node_coords
        )

        max_lat = max(
            node["lat"]
            for node in relevant_node_coords
        )

        min_lon = min(
            node["lon"]
            for node in relevant_node_coords
        )

    center_lat = (
        min_lat + max_lat
    ) / 2.0

    meters_per_degree_lat = 111320.0

    meters_per_degree_lon = (
        111320.0
        * cos(
            radians(center_lat)
        )
    )

    # ========================================================
    # PROJECTION
    # ========================================================

    def geographic_to_local(
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
            x_m * 100,
            z_m * 100,
        )

    # ========================================================
    # OBJETS
    # ========================================================

    buildings: list[
        dict[str, Any]
    ] = []

    for way, tags in relevant_ways:

        osm_way_id = way.attrib.get(
            "id",
            f"way-{len(buildings) + 1}",
        )

        # ----------------------------------------------------
        # NODES
        # ----------------------------------------------------

        node_refs = [
            nd.attrib.get("ref")
            for nd in way.findall("nd")
        ]

        points: list[
            dict[str, Any]
        ] = []

        projected_node_refs: list[str] = []

        for node_ref in node_refs:

            if not node_ref:
                continue

            node_data = nodes.get(
                node_ref
            )

            if not node_data:
                continue

            x, z = geographic_to_local(
                node_data["lat"],
                node_data["lon"],
            )

            points.append(
                {
                    "x": round(x, 3),
                    "z": round(z, 3),
                    "corner": None,
                }
            )

            projected_node_refs.append(
                node_ref
            )

        if len(points) < 2:
            continue

        # ----------------------------------------------------
        # POLYGONE FERME
        # ----------------------------------------------------

        closed = (
            len(projected_node_refs) >= 2
            and projected_node_refs[0]
            == projected_node_refs[-1]
        )

        if closed:

            points.pop()

        # Un way ouvert peut être une route, chemin,
        # ligne ferroviaire, etc.
        #
        # Il faut au minimum 2 points.
        if len(points) < 2:
            continue

        # ----------------------------------------------------
        # CLASSIFICATION
        # ----------------------------------------------------

        (
            semantic_type,
            semantic_source,
            semantic_raw_value,
        ) = _classify_osm_type(
            tags
        )

        (
            geometry_role,
            is_likely_building,
            building_confidence,
        ) = _infer_geometry_role(
            tags,
            closed,
        )

        # ----------------------------------------------------
        # HAUTEUR
        # ----------------------------------------------------

        height_cm, height_source = (
            _parse_height_cm(tags)
        )

        missing_height = (
            height_source is None
        )

        # Une hauteur par défaut uniquement pour les objets
        # considérés comme bâtiments.
        if missing_height:

            if is_likely_building:

                height_cm = (
                    DEFAULT_BUILDING_HEIGHT_CM
                )

            else:

                height_cm = 0.0

        # ----------------------------------------------------
        # BOUNDING BOX
        # ----------------------------------------------------

        min_x = min(
            point["x"]
            for point in points
        )

        max_x = max(
            point["x"]
            for point in points
        )

        min_z = min(
            point["z"]
            for point in points
        )

        max_z = max(
            point["z"]
            for point in points
        )

        # ----------------------------------------------------
        # COULEUR
        # ----------------------------------------------------
        #
        # Pour un bâtiment explicite :
        #
        # building=yes + shop=supermarket
        #
        # => retail
        #
        # et non "other".
        # ----------------------------------------------------

        building_type = semantic_type

        raw_building_type = (
            semantic_raw_value
        )

        color = BUILDING_TYPE_COLORS.get(
            building_type,
            DEFAULT_BUILDING_COLOR,
        )

        # ----------------------------------------------------
        # OPACITE
        # ----------------------------------------------------

        if is_likely_building:

            opacity = (
                KNOWN_HEIGHT_OPACITY
                if not missing_height
                else MISSING_HEIGHT_OPACITY
            )

        else:

            # Les surfaces/lines restent discrètes.
            opacity = 0.35

        # ----------------------------------------------------
        # LABEL
        # ----------------------------------------------------

        label = tags.get(
            "name"
        )

        if not label:

            if is_likely_building:

                label = (
                    f"Bâtiment "
                    f"{len(buildings) + 1:03d}"
                )

            else:

                label = (
                    f"{semantic_type} "
                    f"{len(buildings) + 1:03d}"
                )

        # ----------------------------------------------------
        # TYPE DE SHAPE
        # ----------------------------------------------------

        shape = (
            "polygon"
            if closed
            else "line"
        )

        # ----------------------------------------------------
        # ZONE
        # ----------------------------------------------------

        zone: dict[str, Any] = {

            "id": (
                f"osm-{osm_way_id}"
            ),

            "type": "forbidden",

            "label": label,

            "x": round(
                min_x,
                3,
            ),

            "z": round(
                min_z,
                3,
            ),

            "width": round(
                max_x - min_x,
                3,
            ),

            "depth": round(
                max_z - min_z,
                3,
            ),

            "rotationDeg": 0,

            "rows": None,

            "cols": None,

            "shape": shape,

            "color": color,

            "points": points,

            "pathMode": "linear",

            "mounted": True,

            "opacity": opacity,

            "heightCm": round(
                height_cm,
                2,
            ),

            # =================================================
            # NOUVELLES INFORMATIONS
            # =================================================

            "semanticType": semantic_type,

            "semanticSourceTag": (
                semantic_source
            ),

            "semanticRawValue": (
                semantic_raw_value
            ),

            "geometryRole": (
                geometry_role
            ),

            "isLikelyBuilding": (
                is_likely_building
            ),

            "buildingConfidence": (
                building_confidence
            ),

            # =================================================
            # SOURCE OSM
            # =================================================

            "_source": {

                "osmWayId": (
                    osm_way_id
                ),

                "building": (
                    tags.get("building")
                ),

                "buildingType": (
                    building_type
                ),

                "buildingTypeRaw": (
                    raw_building_type
                ),

                "semanticSourceTag": (
                    semantic_source
                ),

                "semanticRawValue": (
                    semantic_raw_value
                ),

                "geometryRole": (
                    geometry_role
                ),

                "isLikelyBuilding": (
                    is_likely_building
                ),

                "buildingConfidence": (
                    building_confidence
                ),

                "heightSource": (
                    height_source
                ),

                "defaultHeightApplied": (
                    missing_height
                    and is_likely_building
                ),

                # Tous les tags OSM sont conservés.
                "tags": tags,
            },
        }

        # ----------------------------------------------------
        # HAUTEUR SOURCE
        # ----------------------------------------------------

        if tags.get("height") is not None:

            zone["_source"]["height"] = (
                tags["height"]
            )

        if tags.get(
            "building:levels"
        ) is not None:

            zone["_source"][
                "building:levels"
            ] = tags[
                "building:levels"
            ]

        # ----------------------------------------------------
        # AJOUT
        # ----------------------------------------------------

        buildings.append(
            zone
        )

    # ========================================================
    # VERIFICATION
    # ========================================================

    if not buildings:

        raise ValueError(
            "Aucun objet pertinent trouvé dans le fichier OSM."
        )

    # ========================================================
    # BOUNDS GLOBAUX
    # ========================================================

    global_min_x = min(
        building["x"]
        for building in buildings
    )

    global_min_z = min(
        building["z"]
        for building in buildings
    )

    global_max_x = max(
        building["x"]
        + building["width"]
        for building in buildings
    )

    global_max_z = max(
        building["z"]
        + building["depth"]
        for building in buildings
    )

    # ========================================================
    # RECENTRAGE
    # ========================================================

    if (
        global_min_x != 0
        or global_min_z != 0
    ):

        for building in buildings:

            building["x"] = round(
                building["x"]
                - global_min_x,
                3,
            )

            building["z"] = round(
                building["z"]
                - global_min_z,
                3,
            )

            if isinstance(
                building.get("points"),
                list,
            ):

                for point in building[
                    "points"
                ]:

                    if not isinstance(
                        point,
                        dict,
                    ):
                        continue

                    point["x"] = round(
                        float(
                            point.get(
                                "x",
                                0.0,
                            )
                        )
                        - global_min_x,
                        3,
                    )

                    point["z"] = round(
                        float(
                            point.get(
                                "z",
                                0.0,
                            )
                        )
                        - global_min_z,
                        3,
                    )

    # ========================================================
    # DIMENSIONS
    # ========================================================

    global_width = (
        global_max_x
        - global_min_x
    )

    global_depth = (
        global_max_z
        - global_min_z
    )

    # ========================================================
    # IDS
    # ========================================================

    generated_project_id = (
        project_id
        or str(uuid4())
    )

    generated_store_id = (
        store_id
        or str(uuid4())
    )

    timestamp = (
        exported_at
        or datetime.now(
            timezone.utc
        ).isoformat()
    )

    # ========================================================
    # STATISTIQUES
    # ========================================================

    building_count = sum(
        1
        for building in buildings
        if building[
            "isLikelyBuilding"
        ]
    )

    # ========================================================
    # RESULTAT FINAL
    # ========================================================

    return {

        "version": "1.0",

        "projectId": (
            generated_project_id
        ),

        "projectName": project_name,

        "exportedAt": timestamp,

        "unit": "cm",

        "source": {

            "format": (
                "OpenStreetMap XML"
            ),

            "geometry": (
                "OSM ways with semantic "
                "tags"
            ),

            "buildingCount": (
                building_count
            ),

            "objectCount": (
                len(buildings)
            ),

            "geometryPolicy": (
                "OSM footprint node geometry "
                "preserved; no simplification, "
                "rotation, or non-uniform scaling"
            ),

            "colorPolicy": (
                "deterministic color map by "
                "semantic OSM function; "
                "functional tags take precedence "
                "over generic building=yes"
            ),

            "buildingInferencePolicy": (
                "explicit building=* is treated "
                "as a building; selected closed "
                "shop, office, industrial, "
                "healthcare and amenity ways "
                "may be inferred as buildings "
                "with an explicit confidence"
            ),

            "buildingTypeColors": (
                BUILDING_TYPE_COLORS
            ),

            "heightPolicy": (
                "explicit OSM height when available; "
                "otherwise building:levels × 3m; "
                "default 10m when no source height "
                "information is available for a "
                "building-like object"
            ),
        },

        "store": {

            "id": generated_store_id,

            "name": project_name,

            "dimensions": {

                "width": round(
                    global_width,
                    3,
                ),

                "depth": round(
                    global_depth,
                    3,
                ),

                "height": 2500.0,
            },

            "zones": buildings,
        },

        "furniture": [],
    }
