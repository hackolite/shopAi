from __future__ import annotations

SCALE = 0.1  # 1 unit = 10 cm


def cm_to_units(cm: float) -> float:
    return round(cm * SCALE, 3)


CATEGORY_COLORS: dict[str, str] = {
    "epicerie":  "#F5C518",   # amber
    "boisson":   "#2196F3",   # blue
    "frais":     "#4CAF50",   # green
    "hygiene":   "#9C27B0",   # purple
    "promotion": "#F44336",   # red
    "default":   "#90A4AE",   # blue-grey
}


def category_color(category: str) -> str:
    return CATEGORY_COLORS.get(category, CATEGORY_COLORS["default"])


def generate_voxels(planogram: dict, products: list[dict]) -> list[dict]:
    """
    Convert planogram instances into a flat list of voxel descriptors.

    Each voxel represents one facing of one instance:
      {
        instance_id, ean, category, color,
        position: [x, y, z],          # world units (1 unit = 10 cm)
        size:     [width, depth, height]
      }
    """
    product_map = {p["ean"]: p for p in products}
    voxels: list[dict] = []

    for inst in planogram.get("instances", []):
        ean = inst["ean"]
        product = product_map.get(ean)
        if not product:
            continue

        category = product.get("category", "default")
        color = category_color(category)
        dims = product.get("dimensions_cm", {"width": 10, "depth": 10, "height": 20})

        w = cm_to_units(dims.get("width", 10))
        d = cm_to_units(dims.get("depth", 10))
        h = cm_to_units(dims.get("height", 20))

        # Use pre-computed units if present (from planogram generator)
        if "dimensions_units" in inst:
            du = inst["dimensions_units"]
            w = du.get("width", w)
            d = du.get("depth", d)
            h = du.get("height", h)

        loc = inst["location"]
        base_x = loc["x"]
        base_y = loc["y"]
        base_z = loc["z"]
        facings = inst.get("facings", 1)

        for f in range(facings):
            voxels.append({
                "instance_id": inst["instance_id"],
                "facing_index": f,
                "ean": ean,
                "category": category,
                "color": color,
                "position": [round(base_x + f * w, 3), base_y, base_z],
                "size": [w, h, d],
            })

    return voxels
