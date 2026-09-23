import json
import re
import random
from pathlib import Path
import xml.etree.ElementTree as ET
from math import cos, radians


# ============================================================
# CONFIGURATION
# ============================================================

INPUT_XML = Path("Texte collé(20260923-131622).txt")

OUTPUT_JSON = Path(
    "Fort-de-France_bati_208_batiments_couleurs_hauteurs.json"
)

PROJECT_ID = "7ed22ae5-7800-47c9-91a4-ca7dfaa4931c"
STORE_ID = "7be1ba93-4e02-4149-bcc3-48a4616cfece"

# Hauteur utilisée si OSM indique uniquement building:levels.
# 3 m / niveau est une approximation métier, pas une donnée OSM.
METERS_PER_LEVEL = 3.0


# ============================================================
# COULEURS
# ============================================================

PALETTE = [
    "#E76F51",
    "#F4A261",
    "#E9C46A",
    "#2A9D8F",
    "#264653",
    "#457B9D",
    "#A8DADC",
    "#1D3557",
    "#6A994E",
    "#BC6C25",
    "#9B5DE5",
    "#F15BB5",
    "#00BBF9",
    "#00F5D4",
    "#FF6B6B",
    "#4D908E",
    "#577590",
    "#F8961E",
    "#90BE6D",
    "#F3722C",
]

# Seed = couleurs reproductibles à chaque exécution.
rng = random.Random(20260923)
rng.shuffle(PALETTE)


# ============================================================
# LECTURE XML
# ============================================================

print("Lecture du fichier XML...")

tree = ET.parse(INPUT_XML)
root = tree.getroot()


# ============================================================
# 1. INDEX DES NODES OSM
# ============================================================

nodes = {}

for node in root.findall("node"):

    node_id = node.attrib["id"]

    lat = float(node.attrib["lat"])
    lon = float(node.attrib["lon"])

    nodes[node_id] = {
        "lat": lat,
        "lon": lon
    }


print(f"Nodes OSM : {len(nodes)}")


# ============================================================
# 2. BOUNDS
# ============================================================

bounds = root.find("bounds")

if bounds is None:
    raise RuntimeError(
        "Impossible de trouver <bounds> dans le fichier XML."
    )

min_lat = float(bounds.attrib["minlat"])
max_lat = float(bounds.attrib["maxlat"])

min_lon = float(bounds.attrib["minlon"])
max_lon = float(bounds.attrib["maxlon"])


# ============================================================
# 3. CONVERSION LAT/LON → COORDONNÉES LOCALES
# ============================================================

# Latitude : environ 111.32 km / degré.
meters_per_degree_lat = 111320.0

# Longitude dépend de la latitude.
center_lat = (min_lat + max_lat) / 2

meters_per_degree_lon = (
    111320.0 * cos(radians(center_lat))
)


def geographic_to_local(lat, lon):
    """
    Convertit latitude/longitude en coordonnées locales.

    X = Est
    Z = Nord inversé pour avoir le Nord vers le haut.

    Retour en centimètres.
    """

    x_m = (
        (lon - min_lon)
        * meters_per_degree_lon
    )

    z_m = (
        (max_lat - lat)
        * meters_per_degree_lat
    )

    x_cm = x_m * 100
    z_cm = z_m * 100

    return x_cm, z_cm


# ============================================================
# 4. EXTRACTION DES BUILDINGS
# ============================================================

buildings = []

for way in root.findall("way"):

    # --------------------------------------------------------
    # Tags OSM du way
    # --------------------------------------------------------

    tags = {}

    for tag in way.findall("tag"):

        key = tag.attrib.get("k")
        value = tag.attrib.get("v")

        tags[key] = value


    # --------------------------------------------------------
    # On garde UNIQUEMENT les objets avec building=...
    # --------------------------------------------------------

    if "building" not in tags:
        continue


    osm_way_id = way.attrib["id"]


    # --------------------------------------------------------
    # Récupération de la géométrie
    # --------------------------------------------------------

    node_refs = [
        nd.attrib["ref"]
        for nd in way.findall("nd")
    ]


    points = []

    for node_ref in node_refs:

        if node_ref not in nodes:
            continue

        lat = nodes[node_ref]["lat"]
        lon = nodes[node_ref]["lon"]

        x, z = geographic_to_local(
            lat,
            lon
        )

        points.append({
            "x": round(x, 3),
            "z": round(z, 3),
            "corner": None
        })


    # Il faut au minimum 3 points pour un polygone.
    if len(points) < 3:
        continue


    # --------------------------------------------------------
    # Suppression du dernier point s'il répète le premier.
    #
    # OSM ferme souvent les ways ainsi :
    #
    # A → B → C → D → A
    #
    # Notre format polygonal n'a pas besoin du dernier A.
    # --------------------------------------------------------

    if points[-1] == points[0]:
        points.pop()


    if len(points) < 3:
        continue


    # ========================================================
    # 5. HAUTEUR
    # ========================================================

    height_cm = 0
    height_source = None


    # --------------------------------------------------------
    # Cas 1 : OSM possède "height"
    #
    # Exemples :
    #
    # height=12
    # height=12m
    # height=1200cm
    # --------------------------------------------------------

    raw_height = tags.get("height")

    if raw_height:

        value = raw_height.strip().lower()

        # Virgule française → point
        value = value.replace(",", ".")

        match = re.match(
            r"^([0-9]+(?:\.[0-9]+)?)\s*(cm|m)?$",
            value
        )

        if match:

            number = float(match.group(1))
            unit = match.group(2)

            if unit == "cm":

                height_cm = number

            else:

                # Par défaut, OSM height est interprété en mètres.
                height_cm = number * 100


            height_source = "OSM height"


    # --------------------------------------------------------
    # Cas 2 : building:levels
    #
    # Exemple :
    #
    # building:levels=4
    #
    # On estime :
    #
    # 4 × 3m = 12m
    # --------------------------------------------------------

    if height_cm == 0:

        raw_levels = tags.get("building:levels")

        if raw_levels:

            try:

                levels = float(
                    raw_levels.replace(",", ".")
                )

                if levels > 0:

                    height_cm = (
                        levels
                        * METERS_PER_LEVEL
                        * 100
                    )

                    height_source = (
                        "OSM building:levels × 3m"
                    )

            except ValueError:
                pass


    # ========================================================
    # 6. COULEUR
    # ========================================================

    color = PALETTE[
        len(buildings) % len(PALETTE)
    ]


    # ========================================================
    # 7. BOUNDING BOX DU BÂTIMENT
    # ========================================================

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


    width = max_x - min_x
    depth = max_z - min_z


    # ========================================================
    # 8. ZONE JSON
    # ========================================================

    zone = {

        "id": f"building-{osm_way_id}",

        "type": "forbidden",

        "label": tags.get(
            "name",
            f"Bâtiment {len(buildings) + 1:03d}"
        ),

        "x": round(min_x, 3),

        "z": round(min_z, 3),

        "width": round(width, 3),

        "depth": round(depth, 3),

        "rotationDeg": 0,

        "rows": None,

        "cols": None,

        "shape": "polygon",

        "color": color,

        "opacity": 1,

        "points": points,

        "pathMode": "linear",

        "mounted": False,

        "heightCm": round(
            height_cm,
            2
        ),
    }


    # ========================================================
    # INFORMATIONS SOURCE
    # ========================================================

    zone["_source"] = {

        "osmWayId": osm_way_id,

        "building": tags.get(
            "building"
        ),

        "heightSource": height_source
    }


    if raw_height is not None:

        zone["_source"]["height"] = (
            raw_height
        )


    if tags.get("building:levels") is not None:

        zone["_source"]["building:levels"] = (
            tags["building:levels"]
        )


    buildings.append(zone)


# ============================================================
# 9. DIMENSIONS GLOBALES
# ============================================================

if not buildings:
    raise RuntimeError(
        "Aucun bâtiment trouvé."
    )


global_width = max(
    building["x"] + building["width"]
    for building in buildings
)

global_depth = max(
    building["z"] + building["depth"]
    for building in buildings
)


# ============================================================
# 10. JSON FINAL
# ============================================================

output = {

    "version": "1.0",

    "projectId": PROJECT_ID,

    "projectName":
        "Plan de Masse - Fort-de-France Centre - Bâti",

    "exportedAt":
        "2026-09-23T15:36:00.000000+00:00",

    "unit": "cm",


    # --------------------------------------------------------
    # Métadonnées
    # --------------------------------------------------------

    "source": {

        "format":
            "OpenStreetMap XML",

        "geometry":
            "building ways",

        "buildingCount":
            len(buildings),

        "geometryPolicy":
            "OSM footprint node geometry preserved; "
            "no simplification, rotation, "
            "or non-uniform scaling",

        "colorPolicy":
            "deterministic random palette per building",

        "heightPolicy":
            "explicit OSM height when available; "
            "otherwise building:levels × 3m; "
            "0 when no source height information "
            "is available"
    },


    # --------------------------------------------------------
    # Store
    # --------------------------------------------------------

    "store": {

        "id": STORE_ID,

        "name":
            "Bâti - Fort-de-France Centre",

        "dimensions": {

            "width":
                round(global_width, 3),

            "depth":
                round(global_depth, 3),

            "height":
                2500.0
        },

        "zones":
            buildings
    },


    # --------------------------------------------------------
    # Pas de mobilier
    # --------------------------------------------------------

    "furniture": []
}


# ============================================================
# 11. ÉCRITURE
# ============================================================

with open(
    OUTPUT_JSON,
    "w",
    encoding="utf-8"
) as f:

    json.dump(
        output,
        f,
        ensure_ascii=False,
        indent=2
    )


# ============================================================
# RAPPORT
# ============================================================

buildings_with_height = sum(
    1
    for building in buildings
    if building["heightCm"] > 0
)


print()
print("=" * 60)
print("CONVERSION TERMINÉE")
print("=" * 60)

print(
    f"Bâtiments : {len(buildings)}"
)

print(
    f"Avec hauteur connue/estimée : "
    f"{buildings_with_height}"
)

print(
    f"Largeur : "
    f"{global_width / 100:.2f} m"
)

print(
    f"Profondeur : "
    f"{global_depth / 100:.2f} m"
)

print()
print(
    f"Fichier : {OUTPUT_JSON}"
)
