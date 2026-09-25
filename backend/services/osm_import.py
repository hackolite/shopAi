from __future__ import annotations

import re
import time
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

# ------------------------------------------------------------
# AJOUT — Paramètres de réduction de charge pour le moteur
# de simulation / navigation.
# ------------------------------------------------------------

# Tolérance de simplification des contours (Douglas-Peucker),
# en mètres. 0.5 m est un bon point de départ pour des piétons :
# invisible à l'œil, mais réduit fortement le nombre de sommets
# sur des bâtiments OSM détaillés (arrondis, décrochés).
DEFAULT_SIMPLIFY_TOLERANCE_M = 0.5
AGGRESSIVE_SIMPLIFY_TOLERANCE_M = 3.0
AGGRESSIVE_ENVELOPE_BUFFER_M = 8.0
AGGRESSIVE_ENVELOPE_SIMPLIFY_M = 4.0

# Aire minimale (m²) en dessous de laquelle un objet qui N'EST
# PAS un bâtiment (parking, landuse, bout de trottoir fermé...)
# est ignoré. Mis à 0.0 pour désactiver ce filtre.
# Les bâtiments réels (is_likely_building=True) ne sont jamais
# filtrés par ce seuil, quelle que soit leur taille.
DEFAULT_MIN_SURFACE_AREA_M2 = 1.0

# ------------------------------------------------------------
# AJOUT — ENVELOPPES ULTRA-AGRESSIVES (mode test)
#
# Les bâtiments sont fusionnés en "îlots" via une fermeture
# morphologique : buffer(+d) -> union -> buffer(-d). Tout
# interstice plus étroit que 2*d est comblé, donc des rues
# ÉTROITES DEVIENNENT IMPRATICABLES. C'est voulu pour un test
# de charge, pas pour une simulation réaliste.
# ------------------------------------------------------------
DEFAULT_ENVELOPE_ENABLED = False
# "replace" : les îlots REMPLACENT les bâtiments (rien n'est ajouté).
# "overlay" : anciens bâtiments gardés + calque rouge de debug.
DEFAULT_ENVELOPE_MODE = "replace"
DEFAULT_ENVELOPE_BUFFER_M = 3.0      # comble les passages < 6 m
DEFAULT_ENVELOPE_SIMPLIFY_M = 2.0    # tolérance Douglas-Peucker
DEFAULT_ENVELOPE_CONVEX = False      # True = enveloppe convexe par îlot
DEFAULT_ENVELOPE_MIN_AREA_M2 = 25.0  # îlots plus petits ignorés

_HEIGHT_PATTERN = re.compile(
    r"^([0-9]+(?:\.[0-9]+)?)\s*(cm|m)?$",
    re.IGNORECASE,
)


# ============================================================
# COULEURS
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
# ALIAS BUILDING
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

    # Commercial
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

    # Civic
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
# OUTILS
# ============================================================

def _safe_float(
    value: str | None,
) -> float | None:

    if value is None:
        return None

    try:
        return float(value.strip())

    except (
        ValueError,
        AttributeError,
    ):
        return None


def _normalize_building_type(
    value: str | None,
) -> str:

    if not value:
        return "other"

    value = value.strip().lower()

    return _BUILDING_TYPE_ALIASES.get(
        value,
        "other",
    )


def _parse_height_cm(
    value: str | None,
) -> float | None:

    if not value:
        return None

    value = value.strip().lower()

    match = _HEIGHT_PATTERN.match(value)

    if not match:
        return None

    number = float(
        match.group(1)
    )

    unit = match.group(2)

    if unit == "cm":
        return number

    # OSM height est généralement
    # exprimé en mètres.
    return number * 100.0


# ============================================================
# AJOUT — SIMPLIFICATION DE CONTOURS (DOUGLAS-PEUCKER)
# ============================================================
#
# Réduit le nombre de sommets d'un contour fermé tout en
# préservant sa forme visuelle, à une tolérance près (en mètres).
#
# Pourquoi ici et pas côté frontend : la géométrie envoyée au
# moteur de navigation/simulation doit déjà être allégée à
# l'import. Simplifier plus tard (frontend) ne réduit pas le
# coût de triangulation ni de pathfinding côté backend.
#
# Implémentation pure Python, sans dépendance externe.
# ============================================================

def _perpendicular_distance(
    point: tuple[float, float],
    line_start: tuple[float, float],
    line_end: tuple[float, float],
) -> float:

    x0, y0 = point
    x1, y1 = line_start
    x2, y2 = line_end

    dx = x2 - x1
    dy = y2 - y1

    if dx == 0.0 and dy == 0.0:
        # Segment dégénéré : distance au point unique.
        return ((x0 - x1) ** 2 + (y0 - y1) ** 2) ** 0.5

    # Distance point-segment (projection sur la droite,
    # sans borner à [0, 1] : suffisant pour Douglas-Peucker
    # qui travaille sur la droite porteuse du segment).
    numerator = abs(
        dy * x0 - dx * y0 + x2 * y1 - y2 * x1
    )
    denominator = (dx ** 2 + dy ** 2) ** 0.5

    return numerator / denominator


def _douglas_peucker(
    points: list[tuple[float, float]],
    tolerance: float,
) -> list[tuple[float, float]]:
    """
    Simplifie une ligne ouverte (pas de rebouclage) selon
    Douglas-Peucker. `tolerance` est dans la même unité que
    les coordonnées de `points`.
    """

    if len(points) < 3 or tolerance <= 0.0:
        return list(points)

    # ----------------------------------------------------
    # Version itérative (évite tout risque de récursion
    # profonde sur des ways OSM à très nombreux sommets).
    # ----------------------------------------------------

    keep = [False] * len(points)
    keep[0] = True
    keep[-1] = True

    stack: list[tuple[int, int]] = [(0, len(points) - 1)]

    while stack:

        start_idx, end_idx = stack.pop()

        if end_idx <= start_idx + 1:
            continue

        start_point = points[start_idx]
        end_point = points[end_idx]

        max_distance = -1.0
        max_index = -1

        for i in range(start_idx + 1, end_idx):

            distance = _perpendicular_distance(
                points[i],
                start_point,
                end_point,
            )

            if distance > max_distance:
                max_distance = distance
                max_index = i

        if max_distance > tolerance:
            keep[max_index] = True
            stack.append((start_idx, max_index))
            stack.append((max_index, end_idx))

    return [
        point
        for point, keep_flag in zip(points, keep)
        if keep_flag
    ]


def _simplify_closed_ring(
    coords: list[tuple[float, float]],
    tolerance_m: float,
) -> list[tuple[float, float]]:
    """
    Simplifie un anneau FERMÉ (le premier point n'est pas
    répété en fin de liste, comme c'est le cas dans ce module
    après le `coords.pop()` sur la fermeture OSM).

    On simplifie sur [0..n-1] + retour au point 0, en gardant
    toujours au moins 3 sommets et en ne dégénérant jamais le
    polygone.
    """

    if len(coords) < 4 or tolerance_m <= 0.0:
        return list(coords)

    # On referme temporairement l'anneau pour que Douglas-Peucker
    # voie le segment retour (dernier point -> premier point).
    ring = list(coords) + [coords[0]]

    simplified = _douglas_peucker(
        ring,
        tolerance_m,
    )

    # Retire le point de fermeture dupliqué.
    if len(simplified) >= 2 and simplified[0] == simplified[-1]:
        simplified = simplified[:-1]

    if len(simplified) < 3:
        # Simplification dégénérée : on garde l'original plutôt
        # que de produire un polygone invalide.
        return list(coords)

    return simplified


def _polygon_area_m2(
    points_cm: list[dict[str, float]],
) -> float:
    """
    Aire d'un polygone (formule du lacet / shoelace), à partir
    de points déjà en centimètres. Retourne l'aire en m².
    """

    n = len(points_cm)

    if n < 3:
        return 0.0

    area_cm2 = 0.0

    for i in range(n):

        x1 = points_cm[i]["x"]
        z1 = points_cm[i]["z"]

        x2 = points_cm[(i + 1) % n]["x"]
        z2 = points_cm[(i + 1) % n]["z"]

        area_cm2 += x1 * z2 - x2 * z1

    area_cm2 = abs(area_cm2) / 2.0

    return area_cm2 / 10_000.0  # cm² -> m²


# ============================================================
# CLASSIFICATION OSM
# ============================================================

def _classify_osm_type(
    tags: dict[str, str],
) -> tuple[
    str,
    str | None,
    str | None,
]:

    building = tags.get(
        "building",
        "",
    ).strip().lower()

    # --------------------------------------------------------
    # BUILDING SPÉCIFIQUE
    # --------------------------------------------------------

    if (
        building
        and building not in _GENERIC_BUILDING_VALUES
    ):

        normalized = _normalize_building_type(
            building
        )

        if normalized != "other":

            return (
                normalized,
                "building",
                building,
            )

    # --------------------------------------------------------
    # SHOP
    # --------------------------------------------------------

    shop = tags.get(
        "shop",
        "",
    ).strip().lower()

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

            return (
                "retail",
                "shop",
                shop,
            )

        return (
            "commercial",
            "shop",
            shop,
        )

    # --------------------------------------------------------
    # OFFICE
    # --------------------------------------------------------

    office = tags.get(
        "office",
        "",
    ).strip().lower()

    if office:

        return (
            "office",
            "office",
            office,
        )

    # --------------------------------------------------------
    # INDUSTRIAL
    # --------------------------------------------------------

    industrial = tags.get(
        "industrial",
        "",
    ).strip().lower()

    if industrial:

        if industrial in {
            "warehouse",
            "storage",
            "distribution",
        }:

            return (
                "warehouse",
                "industrial",
                industrial,
            )

        return (
            "industrial",
            "industrial",
            industrial,
        )

    # --------------------------------------------------------
    # HEALTHCARE
    # --------------------------------------------------------

    healthcare = tags.get(
        "healthcare",
        "",
    ).strip().lower()

    if healthcare:

        return (
            "hospital",
            "healthcare",
            healthcare,
        )

    # --------------------------------------------------------
    # AMENITY
    # --------------------------------------------------------

    amenity = tags.get(
        "amenity",
        "",
    ).strip().lower()

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

        return (
            amenity_mapping[amenity],
            "amenity",
            amenity,
        )

    # --------------------------------------------------------
    # BUILDING GÉNÉRIQUE
    # --------------------------------------------------------

    if building:

        return (
            "other",
            "building",
            building,
        )

    # --------------------------------------------------------
    # HIGHWAY
    # --------------------------------------------------------

    highway = tags.get(
        "highway",
        "",
    ).strip().lower()

    if highway:

        if highway in {
            "footway",
            "path",
        }:

            return (
                "path",
                "highway",
                highway,
            )

        if highway == "cycleway":

            return (
                "cycleway",
                "highway",
                highway,
            )

        if highway == "pedestrian":

            return (
                "pedestrian",
                "highway",
                highway,
            )

        return (
            "road",
            "highway",
            highway,
        )

    # --------------------------------------------------------
    # PARKING
    # --------------------------------------------------------

    parking = tags.get(
        "parking",
        "",
    ).strip().lower()

    if parking:

        return (
            "parking",
            "parking",
            parking,
        )

    # --------------------------------------------------------
    # LEISURE
    # --------------------------------------------------------

    leisure = tags.get(
        "leisure",
        "",
    ).strip().lower()

    if leisure:

        if leisure in {
            "park",
            "garden",
            "nature_reserve",
        }:

            return (
                "park",
                "leisure",
                leisure,
            )

        if leisure in {
            "sports_centre",
            "stadium",
            "pitch",
            "sports_hall",
            "swimming_pool",
            "fitness_centre",
        }:

            return (
                "sports",
                "leisure",
                leisure,
            )

        return (
            "recreation",
            "leisure",
            leisure,
        )

    # --------------------------------------------------------
    # NATURAL
    # --------------------------------------------------------

    natural = tags.get(
        "natural",
        "",
    ).strip().lower()

    if natural:

        if natural in {
            "water",
            "bay",
            "coastline",
        }:

            return (
                "water",
                "natural",
                natural,
            )

        return (
            "natural",
            "natural",
            natural,
        )

    # --------------------------------------------------------
    # LANDUSE
    # --------------------------------------------------------

    landuse = tags.get(
        "landuse",
        "",
    ).strip().lower()

    if landuse:

        return (
            "landuse",
            "landuse",
            landuse,
        )

    # --------------------------------------------------------
    # RAILWAY
    # --------------------------------------------------------

    railway = tags.get(
        "railway",
        "",
    ).strip().lower()

    if railway:

        if railway in {
            "station",
            "halt",
            "tram_stop",
            "subway_entrance",
        }:

            return (
                "station",
                "railway",
                railway,
            )

        return (
            "railway",
            "railway",
            railway,
        )

    # --------------------------------------------------------
    # PUBLIC TRANSPORT
    # --------------------------------------------------------

    public_transport = tags.get(
        "public_transport",
        "",
    ).strip().lower()

    if public_transport:

        return (
            "station",
            "public_transport",
            public_transport,
        )

    # --------------------------------------------------------
    # MAN MADE
    # --------------------------------------------------------

    man_made = tags.get(
        "man_made",
        "",
    ).strip().lower()

    if man_made:

        return (
            "other",
            "man_made",
            man_made,
        )

    # --------------------------------------------------------
    # POWER
    # --------------------------------------------------------

    power = tags.get(
        "power",
        "",
    ).strip().lower()

    if power:

        return (
            "other",
            "power",
            power,
        )

    return (
        "other",
        None,
        None,
    )


# ============================================================
# INFÉRENCE BÂTIMENT
# ============================================================

def _infer_building_status(
    tags: dict[str, str],
    semantic_type: str,
    semantic_source_tag: str | None,
    closed: bool,
) -> tuple[
    bool,
    float,
    str,
]:

    building = tags.get(
        "building",
        "",
    ).strip().lower()

    # --------------------------------------------------------
    # BUILDING EXPLICITE
    # --------------------------------------------------------

    if building:

        return (
            True,
            1.0,
            "building",
        )

    # --------------------------------------------------------
    # SHOP
    # --------------------------------------------------------

    if tags.get("shop"):

        if closed:

            return (
                True,
                0.72,
                "commercial_area",
            )

        return (
            False,
            0.25,
            "poi",
        )

    # --------------------------------------------------------
    # OFFICE
    # --------------------------------------------------------

    if tags.get("office"):

        if closed:

            return (
                True,
                0.80,
                "building",
            )

        return (
            False,
            0.25,
            "poi",
        )

    # --------------------------------------------------------
    # INDUSTRIAL
    # --------------------------------------------------------

    if tags.get("industrial"):

        if closed:

            return (
                True,
                0.78,
                "industrial_area",
            )

        return (
            False,
            0.25,
            "poi",
        )

    # --------------------------------------------------------
    # HEALTHCARE
    # --------------------------------------------------------

    if tags.get("healthcare"):

        if closed:

            return (
                True,
                0.75,
                "facility",
            )

        return (
            False,
            0.30,
            "poi",
        )

    # --------------------------------------------------------
    # AMENITY
    # --------------------------------------------------------

    amenity = tags.get(
        "amenity",
        "",
    ).strip().lower()

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

            return (
                True,
                0.70,
                "facility",
            )

        return (
            False,
            0.25,
            "poi",
        )

    # --------------------------------------------------------
    # OBJETS DE SURFACE
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

        return (
            False,
            0.0,
            "surface",
        )

    # --------------------------------------------------------
    # AUTRE POLYGONE
    # --------------------------------------------------------

    if closed:

        return (
            False,
            0.20,
            "surface",
        )

    return (
        False,
        0.0,
        "poi",
    )


# ============================================================
# CONVERSION OSM XML -> RETAIL LAYOUT
# ============================================================

def osm_xml_to_retail_layout(
    xml_text: str,
    project_name: str = "OSM Import",
    # ----------------------------------------------------
    # AJOUT — Paramètres de réduction de charge, exposés
    # pour pouvoir les ajuster (ou les désactiver à 0.0)
    # sans toucher au code.
    # ----------------------------------------------------
    simplify_tolerance_m: float = DEFAULT_SIMPLIFY_TOLERANCE_M,
    min_surface_area_m2: float = DEFAULT_MIN_SURFACE_AREA_M2,
    envelope_enabled: bool = DEFAULT_ENVELOPE_ENABLED,
    envelope_mode: str = DEFAULT_ENVELOPE_MODE,
    envelope_buffer_m: float = DEFAULT_ENVELOPE_BUFFER_M,
    envelope_simplify_m: float = DEFAULT_ENVELOPE_SIMPLIFY_M,
    envelope_convex: bool = DEFAULT_ENVELOPE_CONVEX,
    envelope_min_area_m2: float = DEFAULT_ENVELOPE_MIN_AREA_M2,
    # Conserve uniquement les vrais bâtiments par défaut pour
    # limiter la charge 3D dans le workflow Workspace.
    include_non_building_zones: bool = False,
    aggressive_reduction: bool = False,
) -> dict[str, Any]:

    import_started_at = time.perf_counter()  # AJOUT — mesure
    effective_simplify_tolerance_m = (
        AGGRESSIVE_SIMPLIFY_TOLERANCE_M
        if aggressive_reduction
        else simplify_tolerance_m
    )
    effective_envelope_enabled = (
        True if aggressive_reduction else envelope_enabled
    )
    effective_envelope_mode = (
        "replace" if aggressive_reduction else envelope_mode
    )
    effective_envelope_buffer_m = (
        max(envelope_buffer_m, AGGRESSIVE_ENVELOPE_BUFFER_M)
        if aggressive_reduction
        else envelope_buffer_m
    )
    effective_envelope_simplify_m = (
        max(envelope_simplify_m, AGGRESSIVE_ENVELOPE_SIMPLIFY_M)
        if aggressive_reduction
        else envelope_simplify_m
    )

    # ========================================================
    # PARSING
    # ========================================================

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
        tuple[float, float],
    ] = {}

    for node in root.findall("node"):

        node_id = node.attrib.get(
            "id"
        )

        lat = _safe_float(
            node.attrib.get("lat")
        )

        lon = _safe_float(
            node.attrib.get("lon")
        )

        if (
            node_id is not None
            and lat is not None
            and lon is not None
        ):

            nodes[node_id] = (
                lat,
                lon,
            )

    if not nodes:

        raise ValueError(
            "Aucun node OSM exploitable trouvé."
        )

    # ========================================================
    # BOUNDS
    # ========================================================

    bounds_element = root.find(
        "bounds"
    )

    min_lat = None
    max_lat = None
    min_lon = None
    max_lon = None

    if bounds_element is not None:

        min_lat = _safe_float(
            bounds_element.attrib.get(
                "minlat"
            )
        )

        max_lat = _safe_float(
            bounds_element.attrib.get(
                "maxlat"
            )
        )

        min_lon = _safe_float(
            bounds_element.attrib.get(
                "minlon"
            )
        )

        max_lon = _safe_float(
            bounds_element.attrib.get(
                "maxlon"
            )
        )

    # ========================================================
    # FALLBACK BOUNDS
    # ========================================================

    if min_lat is None:

        min_lat = min(
            lat
            for lat, lon
            in nodes.values()
        )

    if max_lat is None:

        max_lat = max(
            lat
            for lat, lon
            in nodes.values()
        )

    if min_lon is None:

        min_lon = min(
            lon
            for lat, lon
            in nodes.values()
        )

    if max_lon is None:

        max_lon = max(
            lon
            for lat, lon
            in nodes.values()
        )

    # ========================================================
    # PROJECTION LOCALE EN CM
    # ========================================================

    center_lat = (
        min_lat + max_lat
    ) / 2.0

    meters_per_degree_lat = (
        111_320.0
    )

    meters_per_degree_lon = (
        111_320.0
        * cos(
            radians(center_lat)
        )
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

    zones: list[
        dict[str, Any]
    ] = []

    building_count = 0

    # ----------------------------------------------------
    # AJOUT — compteurs pour l'instrumentation de mesure
    # ----------------------------------------------------
    stats_ways_seen = 0
    stats_ways_open_skipped = 0
    stats_vertices_before_simplify = 0
    stats_vertices_after_simplify = 0
    stats_surfaces_dropped_by_area = 0
    stats_non_building_zone_count = 0
    stats_non_building_zones_skipped = 0

    # ========================================================
    # WAYS
    # ========================================================

    for way in root.findall(
        "way"
    ):

        stats_ways_seen += 1  # AJOUT

        way_id = way.attrib.get(
            "id"
        )

        if way_id is None:
            continue

        # ----------------------------------------------------
        # TAGS
        # ----------------------------------------------------

        tags: dict[str, str] = {}

        for tag in way.findall(
            "tag"
        ):

            key = tag.attrib.get(
                "k"
            )

            value = tag.attrib.get(
                "v"
            )

            if (
                key
                and value is not None
            ):

                tags[key] = value

        # ----------------------------------------------------
        # NODE REFERENCES
        # ----------------------------------------------------

        node_refs: list[str] = []

        for nd in way.findall(
            "nd"
        ):

            ref = nd.attrib.get(
                "ref"
            )

            if ref:
                node_refs.append(
                    ref
                )

        if len(node_refs) < 3:
            continue

        # ----------------------------------------------------
        # FERMETURE DU WAY
        # ----------------------------------------------------

        closed = (
            len(node_refs) >= 4
            and node_refs[0]
            == node_refs[-1]
        )

        # ----------------------------------------------------
        # IMPORTANT :
        # LES WAYS OUVERTS NE VONT PAS
        # DANS store.zones.
        #
        # SceneData n'accepte pas shape="line".
        # ----------------------------------------------------

        if not closed:
            stats_ways_open_skipped += 1  # AJOUT
            continue

        # ----------------------------------------------------
        # COORDONNÉES
        # ----------------------------------------------------

        coords: list[
            tuple[float, float]
        ] = []

        for ref in node_refs:

            if ref in nodes:

                coords.append(
                    nodes[ref]
                )

        if len(coords) < 3:
            continue

        # ----------------------------------------------------
        # RETIRE LE DERNIER POINT
        # ----------------------------------------------------

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
        ) = _classify_osm_type(
            tags
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
        # AJOUT — SIMPLIFICATION DES CONTOURS
        #
        # On simplifie en coordonnées MÉTRIQUES projetées
        # (pas en lat/lon), pour que la tolérance en mètres
        # ait un sens physique constant sur toute la carte.
        #
        # On simplifie systématiquement (bâtiments ET
        # surfaces) : un parking simplifié coûte aussi moins
        # cher à triangulariser / afficher.
        # ====================================================

        stats_vertices_before_simplify += len(coords)  # AJOUT

        projected_coords_m: list[tuple[float, float]] = []

        for lat, lon in coords:

            x_cm, z_cm = project(lat, lon)

            projected_coords_m.append(
                (x_cm / 100.0, z_cm / 100.0)
            )

        simplified_coords_m = _simplify_closed_ring(
            projected_coords_m,
            effective_simplify_tolerance_m,
        )

        stats_vertices_after_simplify += len(simplified_coords_m)  # AJOUT

        # ====================================================
        # PROJECTION DU POLYGONE (déjà en mètres -> cm)
        #
        # FloorZonePoint attend :
        #
        # {
        #     "x": ...,
        #     "z": ...
        # }
        # ====================================================

        points: list[
            dict[str, float]
        ] = []

        for x_m, z_m in simplified_coords_m:

            points.append({
                "x": round(
                    x_m * 100.0,
                    2,
                ),
                "z": round(
                    z_m * 100.0,
                    2,
                ),
            })

        if len(points) < 3:
            continue

        # ====================================================
        # AJOUT — FILTRE DES MICRO-SURFACES NON-BÂTIMENT
        #
        # Un bout de trottoir fermé, une micro-parcelle de
        # landuse, etc. n'apportent rien à la simulation mais
        # ajoutent un obstacle/contour de plus à traiter.
        # Les vrais bâtiments ne sont JAMAIS filtrés ici, quelle
        # que soit leur taille.
        # ====================================================

        if (
            not is_likely_building
            and min_surface_area_m2 > 0.0
        ):

            area_m2 = _polygon_area_m2(points)

            if area_m2 < min_surface_area_m2:
                stats_surfaces_dropped_by_area += 1  # AJOUT
                continue

        if (
            not is_likely_building
            and not include_non_building_zones
        ):
            stats_non_building_zones_skipped += 1
            continue

        # ====================================================
        # BOUNDING BOX
        # ====================================================

        xs = [
            point["x"]
            for point in points
        ]

        zs = [
            point["z"]
            for point in points
        ]

        min_x = min(xs)
        max_x = max(xs)

        min_z = min(zs)
        max_z = max(zs)

        x = min_x

        z = min_z

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

        raw_height = tags.get(
            "height"
        )

        raw_levels = tags.get(
            "building:levels"
        )

        height_cm = None

        height_source = None

        default_height_applied = False

        # ----------------------------------------------------
        # 1. HEIGHT
        # ----------------------------------------------------

        if raw_height:

            parsed_height = (
                _parse_height_cm(
                    raw_height
                )
            )

            if parsed_height is not None:

                height_cm = (
                    parsed_height
                )

                height_source = (
                    "height"
                )

        # ----------------------------------------------------
        # 2. BUILDING LEVELS
        # ----------------------------------------------------

        if (
            height_cm is None
            and is_likely_building
            and raw_levels
        ):

            levels = _safe_float(
                raw_levels
            )

            if (
                levels is not None
                and levels > 0
            ):

                height_cm = (
                    levels
                    * METERS_PER_LEVEL
                    * 100.0
                )

                height_source = (
                    "building:levels"
                )

        # ----------------------------------------------------
        # 3. DEFAULT 10M
        # ----------------------------------------------------

        if (
            height_cm is None
            and is_likely_building
        ):

            height_cm = (
                DEFAULT_BUILDING_HEIGHT_CM
            )

            height_source = (
                "default"
            )

            default_height_applied = True

        # ----------------------------------------------------
        # NON-BÂTIMENT
        # ----------------------------------------------------

        if not is_likely_building:

            height_cm = 0.0

            height_source = (
                "not_a_building"
            )

        # ====================================================
        # COULEUR
        # ====================================================

        color = (
            BUILDING_TYPE_COLORS.get(
                semantic_type,
                DEFAULT_BUILDING_COLOR,
            )
        )

        # ====================================================
        # OPACITÉ
        # ====================================================

        if is_likely_building:

            if height_source in {
                "height",
                "building:levels",
            }:

                opacity = (
                    KNOWN_HEIGHT_OPACITY
                )

            else:

                opacity = (
                    MISSING_HEIGHT_OPACITY
                )

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

                name = (
                    f"OSM {way_id}"
                )

        # ====================================================
        # SOURCE
        # ====================================================

        source_data: dict[
            str,
            Any,
        ] = {

            "osmWayId": way_id,

            "building": tags.get(
                "building"
            ),

            "buildingType": (
                semantic_type
            ),

            "buildingTypeRaw": (
                tags.get("building")
            ),

            "semanticType": (
                semantic_type
            ),

            "semanticSourceTag": (
                semantic_source_tag
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
                default_height_applied
            ),

            # AJOUT — traçabilité de la simplification,
            # utile pour l'afficher dans l'Inspector plus tard.
            "vertexCountRaw": len(coords),
            "vertexCountSimplified": len(points),

            # Tous les tags OSM
            "tags": tags,
        }

        if raw_height:

            source_data["height"] = (
                raw_height
            )

        if raw_levels:

            source_data[
                "building:levels"
            ] = raw_levels

        if "name" in tags:

            source_data["name"] = (
                tags["name"]
            )

        # ====================================================
        # ZONE
        # ====================================================
        #
        # MODIFIÉ — CORRECTION MAJEURE, revue après lecture de
        # models/project.py :
        #
        # ZoneTypeEnum n'accepte QUE {entrance, exit, supply,
        # forbidden}. Il n'existe pas de type neutre du genre
        # "walkable" — une valeur hors de cette liste fait
        # échouer la validation Pydantic (ZoneTypeEnum(...)
        # lève ValueError). "type" encode un RÔLE FONCTIONNEL
        # pour la simulation (entrance/exit/supply sont des
        # points spéciaux ; forbidden est la seule valeur
        # générique pour "une forme quelconque").
        #
        # Le champ prévu pour dire si une zone bloque ou non
        # les piétons est `pedestrianObstacle: bool | None`,
        # séparé de `type`. C'est lui qu'on pilote ici :
        #
        # - type reste "forbidden" pour toute zone fermée
        #   (aucune de ces zones OSM n'est une entrée/sortie/
        #   zone de réappro : ce sont des formes géométriques
        #   génériques) ;
        # - pedestrianObstacle=True uniquement pour les
        #   bâtiments réels (is_likely_building) ;
        # - pedestrianObstacle=False pour tout le reste
        #   (parkings, parcs, landuse, routes fermées...),
        #   pour qu'ils ne bloquent plus la navigation.
        #
        # IMPORTANT : je n'ai pas vu le moteur de navigation
        # qui construit les obstacles à partir de store.zones.
        # Cette proposition suppose qu'il lit pedestrianObstacle
        # (avec une valeur explicite True/False plutôt que None,
        # justement pour ne pas dépendre d'une éventuelle
        # logique de déduction par défaut). Si le moteur ignore
        # ce champ et ne regarde que `type == forbidden`, il
        # faudra soit l'adapter pour qu'il lise
        # pedestrianObstacle, soit changer d'approche (ex. ne
        # pas ajouter du tout les non-bâtiments à store.zones,
        # ou les mettre dans une collection séparée pour
        # l'affichage seul).
        # ====================================================

        if not is_likely_building:
            stats_non_building_zone_count += 1  # AJOUT

        zone = {

            "id": (
                f"building-{way_id}"
            ),

            "type": "forbidden",  # Seule valeur générique valide du schéma.

            "pedestrianObstacle": is_likely_building,  # AJOUT — le vrai levier

            "label": name,

            "x": round(
                x,
                2,
            ),

            "z": round(
                z,
                2,
            ),

            "width": round(
                width,
                2,
            ),

            "depth": round(
                depth,
                2,
            ),

            "rotationDeg": 0,

            "rows": None,

            "cols": None,

            # Valeur compatible avec SceneData.
            "shape": "polygon",

            "color": color,

            # FloorZonePoint :
            # {"x": ..., "z": ...}
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

        zones.append(
            zone
        )

        if is_likely_building:

            building_count += 1

    # ========================================================
    # AJOUT — ENVELOPPES DE NAVIGATION (îlots de bâtiments)
    #
    # Les bâtiments d'origine restent dans store.zones pour
    # l'affichage et la sélection, mais ne sont plus des
    # obstacles (pedestrianObstacle=False). Les îlots fusionnés
    # deviennent les seuls obstacles de navigation.
    #
    # Limites connues : FloorZone.points n'a qu'un contour
    # extérieur, donc les cours intérieures sont comblées.
    # ========================================================

    envelope_count = 0
    envelope_vertices = 0
    envelope_source_buildings = 0

    if effective_envelope_enabled and building_count > 0:

        try:
            from shapely.geometry import Polygon
            from shapely.ops import unary_union
        except ImportError as exc:
            raise RuntimeError(
                "envelope_enabled=True nécessite shapely "
                "(pip install shapely)."
            ) from exc

        buffer_cm = max(effective_envelope_buffer_m, 0.0) * 100.0
        simplify_cm = max(effective_envelope_simplify_m, 0.0) * 100.0
        min_area_cm2 = max(envelope_min_area_m2, 0.0) * 10_000.0

        building_polys = []
        building_way_ids = []
        building_attrs = []  # (hauteur, couleur, opacité) de chaque bâtiment
        building_sources = []

        for zone in zones:

            if not zone["_source"].get("isLikelyBuilding"):
                continue

            polygon = Polygon(
                [(p["x"], p["z"]) for p in zone["points"]]
            )

            if not polygon.is_valid:
                polygon = polygon.buffer(0)

            if polygon.is_empty:
                continue

            building_polys.append(polygon)
            building_way_ids.append(zone["_source"].get("osmWayId"))
            building_attrs.append(
                (zone["heightCm"], zone["color"], zone["opacity"])
            )
            building_sources.append(dict(zone["_source"]))

            # Mode overlay : le bâtiment d'origine ne bloque plus.
            if effective_envelope_mode != "replace":
                zone["pedestrianObstacle"] = False

        envelope_source_buildings = len(building_polys)

        if building_polys:

            # Fermeture morphologique : +d, union, -d.
            grown = [poly.buffer(buffer_cm) for poly in building_polys]
            merged = unary_union(grown).buffer(-buffer_cm)

            islands = (
                list(merged.geoms)
                if hasattr(merged, "geoms")
                else [merged]
            )

            for index, island in enumerate(islands):

                if island.is_empty or island.area < min_area_cm2:
                    continue

                # Contour extérieur uniquement (les trous sont comblés).
                island = Polygon(island.exterior)

                if envelope_convex:
                    island = island.convex_hull

                if simplify_cm > 0.0:
                    island = island.simplify(
                        simplify_cm,
                        preserve_topology=True,
                    )

                if island.is_empty or island.geom_type != "Polygon":
                    continue

                coords_xy = list(island.exterior.coords)[:-1]

                if len(coords_xy) < 3:
                    continue

                env_points = [
                    {"x": round(px, 2), "z": round(pz, 2)}
                    for px, pz in coords_xy
                ]

                env_xs = [p["x"] for p in env_points]
                env_zs = [p["z"] for p in env_points]

                members = [
                    (way_id, attrs, source)
                    for way_id, poly, attrs, source in zip(
                        building_way_ids,
                        building_polys,
                        building_attrs,
                        building_sources,
                    )
                    if poly.intersects(island)
                ]
                member_ids = [m[0] for m in members if m[0] is not None]
                unique_member_ids = sorted({member_id for member_id in member_ids})
 
                if effective_envelope_mode == "replace" and members:
                    # L'îlot reprend l'aspect de ses bâtiments :
                    # hauteur max, couleur du premier, opacité max.
                    env_height = max(m[1][0] for m in members)
                    env_color = members[0][1][1]
                    env_opacity = max(m[1][2] for m in members)
                    env_label = f"Îlot {index}"
                    representative_source = dict(members[0][2])
                    if len(unique_member_ids) != 1:
                        for key in (
                            "osmWayId",
                            "building",
                            "buildingType",
                            "buildingTypeRaw",
                            "semanticType",
                            "semanticSourceTag",
                            "semanticRawValue",
                            "geometryRole",
                            "buildingConfidence",
                            "heightSource",
                            "defaultHeightApplied",
                            "height",
                            "building:levels",
                            "name",
                            "tags",
                        ):
                            representative_source.pop(key, None)
                else:
                    env_height, env_color, env_opacity = 0.0, "#EF4444", 0.25
                    env_label = f"Enveloppe {index}"
                    representative_source = {}

                zones.append({
                    "id": f"envelope-{index}",
                    "type": "forbidden",
                    "pedestrianObstacle": True,
                    "label": env_label,
                    "x": round(min(env_xs), 2),
                    "z": round(min(env_zs), 2),
                    "width": round(max(max(env_xs) - min(env_xs), 1.0), 2),
                    "depth": round(max(max(env_zs) - min(env_zs), 1.0), 2),
                    "rotationDeg": 0,
                    "rows": None,
                    "cols": None,
                    "shape": "polygon",
                    "color": env_color,
                    "points": env_points,
                    "pathMode": "linear",
                    "mounted": True,
                    "opacity": env_opacity,
                    "heightCm": env_height,
                    "_source": {
                        **representative_source,
                        "isEnvelope": True,
                        "isLikelyBuilding": effective_envelope_mode == "replace" and bool(members),
                        "memberOsmWayIds": unique_member_ids,
                        "vertexCountSimplified": len(env_points),
                    },
                })

                envelope_count += 1
                envelope_vertices += len(env_points)

            if effective_envelope_mode == "replace":
                # Les bâtiments d'origine disparaissent : seuls
                # les îlots restent.
                zones[:] = [
                    z for z in zones
                    if z["_source"].get("isEnvelope")
                    or not z["_source"].get("isLikelyBuilding")
                ]
                building_count = envelope_count

    # ========================================================
    # DIMENSIONS GLOBALES
    # ========================================================

    all_x: list[float] = []
    all_z: list[float] = []

    for zone in zones:

        for point in zone["points"]:

            all_x.append(
                point["x"]
            )

            all_z.append(
                point["z"]
            )

    projected_bounds_width = max(
        0.0,
        (
            max_lon - min_lon
        ) * meters_per_degree_lon * 100.0,
    )

    projected_bounds_depth = max(
        0.0,
        (
            max_lat - min_lat
        ) * meters_per_degree_lat * 100.0,
    )

    if all_x:

        min_scene_x = min(all_x)
        max_scene_x = max(all_x)
        min_scene_z = min(all_z)
        max_scene_z = max(all_z)

        # Rebase all imported geometries to the store origin so the generated
        # grid always starts at (0, 0) and covers the whole implantation.
        if min_scene_x != 0.0 or min_scene_z != 0.0:

            offset_x = -min_scene_x
            offset_z = -min_scene_z

            for zone in zones:

                zone["x"] = round(
                    float(zone["x"]) + offset_x,
                    2,
                )

                zone["z"] = round(
                    float(zone["z"]) + offset_z,
                    2,
                )

                shifted_points: list[dict[str, float]] = []

                for point in zone["points"]:

                    shifted_points.append({
                        "x": round(
                            float(point["x"]) + offset_x,
                            2,
                        ),
                        "z": round(
                            float(point["z"]) + offset_z,
                            2,
                        ),
                    })

                zone["points"] = shifted_points

        geometry_bounds_width = max(
            1.0,
            max_scene_x - min_scene_x,
        )

        geometry_bounds_depth = max(
            1.0,
            max_scene_z - min_scene_z,
        )

        scene_width = max(
            projected_bounds_width,
            geometry_bounds_width,
        )

        scene_depth = max(
            projected_bounds_depth,
            geometry_bounds_depth,
        )

    else:

        scene_width = projected_bounds_width
        scene_depth = projected_bounds_depth

    # ========================================================
    # HAUTEUR GLOBALE
    # ========================================================

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
    # AJOUT — INSTRUMENTATION DE MESURE
    #
    # Objectif : pouvoir chiffrer, à chaque import, l'effet du
    # correctif forbidden/walkable et de la simplification,
    # sans avoir à instrumenter le moteur de simulation.
    # ========================================================

    import_duration_s = time.perf_counter() - import_started_at

    non_building_count = len(zones) - building_count

    vertices_before = stats_vertices_before_simplify
    vertices_after = stats_vertices_after_simplify

    reduction_pct = (
        round(
            100.0 * (1.0 - vertices_after / vertices_before),
            1,
        )
        if vertices_before > 0
        else 0.0
    )

    import_stats = {
        "importDurationSeconds": round(import_duration_s, 3),
        "waysSeen": stats_ways_seen,
        "waysOpenSkipped": stats_ways_open_skipped,
        "zonesTotal": len(zones),
        "buildingZones": building_count,
        "nonBuildingZones": non_building_count,
        "nonBuildingZonesNotAnObstacle": stats_non_building_zone_count,
        "nonBuildingZonesSkipped": stats_non_building_zones_skipped,
        "surfacesDroppedByAreaFilter": stats_surfaces_dropped_by_area,
        "vertexCountBeforeSimplify": vertices_before,
        "vertexCountAfterSimplify": vertices_after,
        "vertexReductionPercent": reduction_pct,
        "simplifyToleranceM": effective_simplify_tolerance_m,
        "aggressiveReduction": aggressive_reduction,
        "minSurfaceAreaM2Filter": min_surface_area_m2,
        "envelopeEnabled": effective_envelope_enabled,
        "envelopeMode": effective_envelope_mode,
        "envelopeCount": envelope_count,
        "envelopeVertices": envelope_vertices,
        "envelopeSourceBuildings": envelope_source_buildings,
        "envelopeBufferM": effective_envelope_buffer_m,
        "envelopeSimplifyM": effective_envelope_simplify_m,
        "envelopeConvex": envelope_convex,
        "includeNonBuildingZones": include_non_building_zones,
    }

    # Log direct, pour voir l'effet immédiatement sans avoir
    # à aller chercher le payload. À remplacer par un vrai
    # logger applicatif si le projet en a un.
    print(f"[osm_import] {import_stats}")

    # ========================================================
    # PAYLOAD FINAL
    # ========================================================

    geometry_complexity_policy = (
        "Dense OSM polygons increase import cost, triangulation cost, "
        "navigation obstacle compilation, and live simulation updates. "
    )
    if aggressive_reduction:
        geometry_complexity_policy += (
            "Aggressive reduction raises contour simplification from "
            f"{DEFAULT_SIMPLIFY_TOLERANCE_M:g} m to "
            f"{AGGRESSIVE_SIMPLIFY_TOLERANCE_M:g} m to lower vertex count "
            f"and enables envelope fusion (buffer {effective_envelope_buffer_m:g} m, "
            f"simplify {effective_envelope_simplify_m:g} m) to merge nearby buildings "
            "when visual fidelity is less important than runtime speed."
        )
    else:
        geometry_complexity_policy += (
            "Standard import keeps a "
            f"{effective_simplify_tolerance_m:g} m contour simplification "
            "tolerance for a closer match to the source geometry."
        )

    payload = {

        "version": "1.0",

        "projectId": str(
            uuid4()
        ),

        "projectName": (
            project_name
        ),

        "exportedAt": (
            datetime.now(
                timezone.utc
            ).isoformat()
        ),

        "unit": "cm",

        # ====================================================
        # SOURCE
        # ====================================================

        "source": {

            "format": (
                "OpenStreetMap XML"
            ),

            "geometry": (
                "closed OSM ways with "
                "semantic tags"
            ),

            "buildingCount": (
                building_count
            ),

            "objectCount": len(
                zones
            ),

            "geometryPolicy": (
                "Closed OSM ways are "
                "exported as polygon "
                "zones. Open ways are "
                "ignored because "
                "SceneData does not "
                "support line zones. "
                "Only real buildings "
                "are marked as "
                "navigation obstacles "
                "(type=forbidden); "
                "other closed surfaces "
                "are walkable."
            ),

            "colorPolicy": (
                "Colors are derived "
                "from semantic OSM "
                "building and "
                "functional tags."
            ),

            "buildingTypeColors": (
                BUILDING_TYPE_COLORS
            ),

            "heightPolicy": {

                "height": (
                    "OSM height tag "
                    "has priority."
                ),

                "building:levels": (
                    "3 meters per level."
                ),

                "default": (
                    "10 meters when "
                    "a building has "
                    "no height "
                    "information."
                ),

                "nonBuilding": (
                    "0 cm."
                ),
            },

            # AJOUT — visible dans le payload pour debug/tuning
            # sans avoir à relire les logs serveur.
            "importStats": import_stats,
            "geometryComplexityPolicy": geometry_complexity_policy,
        },

        # ====================================================
        # STORE
        # ====================================================

        "store": {

            "id": str(
                uuid4()
            ),

            "name": (
                project_name
            ),

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
