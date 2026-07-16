from __future__ import annotations

SCALE = 0.01  # 1 unit = 1 metre  (product cm × 0.01 → metres)


def cm_to_units(cm: float) -> float:
    return round(cm * SCALE, 4)


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

    Scale: 1 unit = 1 metre (positions and sizes in metres).
    Product dimensions come from products.json (dimensions_cm × 0.01).

    Each voxel represents one facing of one instance:
      {
        instance_id, facing_index, ean, category, color,
        position: [x, y, z],          # world units (metres)
        size:     [depth_x, height_y, width_z]
      }

    Facings are stacked along the Z axis (along the gondola face).
    size[0] = depth_x  : product depth going into the shelf (X direction)
    size[1] = height_y : product height (Y direction, up)
    size[2] = width_z  : product width / facing width (Z direction, along gondola)
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

        # Always derive sizes from real product dimensions (cm → metres)
        width_z  = cm_to_units(dims.get("width",  10))   # along gondola (Z)
        depth_x  = cm_to_units(dims.get("depth",  10))   # into shelf (X)
        height_y = cm_to_units(dims.get("height", 20))   # vertical (Y)

        loc = inst["location"]
        base_x = loc["x"]
        base_y = loc["y"]
        base_z = loc["z"]
        facings = inst.get("facings", 1)

        # Facings are placed side-by-side along the Z axis (gondola length)
        for f in range(facings):
            voxels.append({
                "instance_id":  inst["instance_id"],
                "facing_index": f,
                "ean":          ean,
                "category":     category,
                "color":        color,
                "position": [base_x, base_y, round(base_z + f * width_z, 4)],
                "size":     [depth_x, height_y, width_z],
            })

    return voxels
