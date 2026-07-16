from __future__ import annotations

from collections.abc import Iterator
from itertools import cycle
from uuid import uuid4

from models.project import Catalog, Face, FurnitureInstance, Material, Planogram, PlanogramCell, SceneData, Store, Wall


_CATEGORY_COUNTS = {
    "Épicerie": 34,
    "Boissons": 34,
    "Frais": 33,
    "Hygiène": 33,
    "Bébé": 33,
    "Promotion": 33,
}

_CATEGORY_SPECS = {
    "Épicerie": {
        "brands": ["Nestlé", "Barilla", "Lustucru", "Maille", "Bonne Maman", "Tipiak", "Knorr", "Puget"],
        "items": ["Pâtes penne", "Riz basmati", "Sauce tomate", "Céréales croustillantes", "Confiture fraise", "Purée mousseline", "Semoule fine", "Soupe légumes", "Farine fluide", "Muesli croustillant"],
        "variants": ["classique", "bio", "aux légumes", "tradition", "sans gluten"],
        "sizes": [("250g", 250, {"width": 9, "depth": 5, "height": 18}), ("500g", 500, {"width": 11, "depth": 6, "height": 22}), ("750g", 750, {"width": 13, "depth": 7, "height": 24}), ("1kg", 1000, {"width": 14, "depth": 8, "height": 26})],
    },
    "Boissons": {
        "brands": ["Evian", "Perrier", "Orangina", "Tropicana", "Coca-Cola", "Volvic", "Lipton", "Joker"],
        "items": ["Eau minérale", "Eau pétillante", "Jus d'orange", "Thé glacé", "Soda citron", "Boisson tropicale", "Cola zéro", "Limonade"],
        "variants": ["nature", "citron", "multi-fruits", "sans sucre", "fines bulles"],
        "sizes": [("33cl", 330, {"width": 6, "depth": 6, "height": 15}), ("50cl", 500, {"width": 7, "depth": 7, "height": 20}), ("1L", 1000, {"width": 8, "depth": 8, "height": 28}), ("1.5L", 1500, {"width": 9, "depth": 9, "height": 32})],
    },
    "Frais": {
        "brands": ["Danone", "Yoplait", "Président", "Fleury Michon", "Herta", "Andros", "St Môret", "Elle & Vire"],
        "items": ["Yaourt nature", "Yaourt vanille", "Fromage râpé", "Jambon blanc", "Beurre doux", "Dessert chocolat", "Compote pomme", "Crème liquide"],
        "variants": ["x4", "x6", "allégé", "fermier", "sans lactose"],
        "sizes": [("125g", 125, {"width": 7, "depth": 7, "height": 6}), ("200g", 200, {"width": 9, "depth": 6, "height": 7}), ("400g", 400, {"width": 12, "depth": 7, "height": 9}), ("1kg", 1000, {"width": 14, "depth": 8, "height": 12})],
    },
    "Hygiène": {
        "brands": ["L'Oréal", "Dove", "Nivea", "Le Petit Marseillais", "Signal", "Head & Shoulders", "Colgate", "Mixa"],
        "items": ["Shampooing", "Gel douche", "Dentifrice", "Savon liquide", "Déodorant", "Crème hydratante", "Brosse à dents", "Après-shampooing"],
        "variants": ["fraîcheur", "peaux sensibles", "nutrition", "coco", "menthe"],
        "sizes": [("75ml", 75, {"width": 4, "depth": 3, "height": 16}), ("150ml", 150, {"width": 5, "depth": 4, "height": 18}), ("250ml", 250, {"width": 6, "depth": 5, "height": 20}), ("400ml", 400, {"width": 7, "depth": 5, "height": 22})],
    },
    "Bébé": {
        "brands": ["Mustela", "Blédina", "Gallia", "Pampers", "Babybio", "Love & Green", "Mixa Bébé", "Physiolac"],
        "items": ["Petits pots carotte", "Lait infantile", "Couches", "Lingettes", "Crème change", "Céréales bébé", "Compote bébé", "Gel lavant"],
        "variants": ["dès 6 mois", "bio", "peaux sensibles", "maxi pack", "sans parfum"],
        "sizes": [("2x130g", 260, {"width": 10, "depth": 6, "height": 8}), ("400g", 400, {"width": 13, "depth": 8, "height": 18}), ("800g", 800, {"width": 15, "depth": 9, "height": 22}), ("x48", 1400, {"width": 28, "depth": 12, "height": 22})],
    },
    "Promotion": {
        "brands": ["Carrefour", "Monoprix", "Auchan", "Casino", "Nestlé", "Danone", "Coca-Cola", "Ferrero"],
        "items": ["Pack découverte", "Lot familial", "Offre duo", "Sélection été", "Panier malin", "Pack week-end", "Lot économique", "Édition limitée"],
        "variants": ["-30%", "2+1 offert", "prix rouge", "grand format", "série spéciale"],
        "sizes": [("format S", 350, {"width": 14, "depth": 8, "height": 18}), ("format M", 700, {"width": 18, "depth": 10, "height": 22}), ("format L", 1200, {"width": 22, "depth": 12, "height": 26}), ("format XL", 1800, {"width": 26, "depth": 14, "height": 30})],
    },
}


def _default_faces() -> dict[str, str | None]:
    return {face.value: None for face in Face}


def _make_ean(index: int) -> str:
    return f"370{index:010d}"


def _build_catalog() -> list[dict]:
    products: list[dict] = []
    ean_index = 1
    for category, count in _CATEGORY_COUNTS.items():
        spec = _CATEGORY_SPECS[category]
        generated = 0
        combo_index = 0
        while generated < count:
            item = spec["items"][combo_index % len(spec["items"])]
            variant = spec["variants"][(combo_index // len(spec["items"])) % len(spec["variants"])]
            size_label, weight_g, dims = spec["sizes"][(combo_index // (len(spec["items"]) * len(spec["variants"]))) % len(spec["sizes"])]
            brand = spec["brands"][combo_index % len(spec["brands"])]
            products.append({
                "ean": _make_ean(ean_index),
                "name": f"{item} {variant} {size_label}",
                "brand": brand,
                "category": category,
                "widthCm": float(dims["width"]),
                "depthCm": float(dims["depth"]),
                "heightCm": float(dims["height"]),
                "weightG": float(weight_g),
                "imageUrl": None,
            })
            ean_index += 1
            generated += 1
            combo_index += 1
    return Catalog(products=products).model_dump(mode="json")["products"]


def _make_planogram(name: str, furniture_id: str, face: Face, rows: int, cols: int, width_cm: float, height_cm: float, product_iter: Iterator[dict]) -> dict:
    cells = []
    for row in range(rows):
        for col in range(cols):
            product = next(product_iter)
            cells.append(PlanogramCell(
                id=str(uuid4()),
                ean=product["ean"],
                row=row,
                col=col,
                rotation=[0, 90, 180, 270][(row + col) % 4],
            ))
    return Planogram(
        id=str(uuid4()),
        name=name,
        furnitureId=furniture_id,
        face=face,
        rows=rows,
        cols=cols,
        widthCm=width_cm,
        heightCm=height_cm,
        cells=cells,
    ).model_dump(mode="json")


def generate_retail_cad_demo() -> dict:
    products = _build_catalog()
    product_iter = cycle(products)

    materials = [
        Material(id="wood_dark", name="Bois foncé", type="wood", color="#5C4033", roughness=0.7, metalness=0.0),
        Material(id="metal_gray", name="Métal gris", type="metal", color="#8A8F98", roughness=0.35, metalness=0.9),
        Material(id="metal_white", name="Métal blanc", type="metal", color="#E7E9EC", roughness=0.25, metalness=0.85),
        Material(id="glass_clear", name="Verre clair", type="glass", color="#D9F3FF", roughness=0.05, metalness=0.0),
        Material(id="plastic_black", name="Plastique noir", type="plastic", color="#1E1E1E", roughness=0.6, metalness=0.0),
        Material(id="plastic_white", name="Plastique blanc", type="plastic", color="#F7F7F7", roughness=0.45, metalness=0.0),
        Material(id="solid_red", name="Rouge promo", type="solid_color", color="#D7263D", roughness=0.5, metalness=0.0),
        Material(id="solid_blue", name="Bleu signalétique", type="solid_color", color="#1B4D9B", roughness=0.5, metalness=0.0),
    ]

    store = Store(
        id=str(uuid4()),
        name="Retail CAD Demo",
        position=[0.0, 0.0, 0.0],
        rotation=[0.0, 0.0, 0.0],
        dimensions={"width": 5000.0, "depth": 3000.0, "height": 400.0},
        walls=[
            Wall(
                id=str(uuid4()),
                name="Mur arrière",
                position=[2500.0, 150.0, 2990.0],
                rotation=[0.0, 0.0, 0.0],
                dimensions={"width": 5000.0, "depth": 20.0, "height": 300.0},
                materialId="solid_blue",
            ),
            Wall(
                id=str(uuid4()),
                name="Mur latéral",
                position=[10.0, 150.0, 1500.0],
                rotation=[0.0, 90.0, 0.0],
                dimensions={"width": 3000.0, "depth": 20.0, "height": 300.0},
                materialId="solid_red",
            ),
        ],
    )

    furniture: list[dict] = []
    planograms: list[dict] = []

    start_x = 1200.0
    start_z = 1200.0
    center_spacing_x = 320.0
    center_spacing_z = 260.0

    for index, label in enumerate("ABCDEFGHIJ"):
        row = index // 5
        col = index % 5
        furniture_id = str(uuid4())
        gondola = FurnitureInstance(
            id=furniture_id,
            name=f"Gondole {label}",
            type="gondola_single",
            libraryId="gondola_single",
            position=[start_x + (col * center_spacing_x), 0.0, start_z + (row * center_spacing_z)],
            rotation=[0.0, 0.0 if row == 0 else 180.0, 0.0],
            dimensions={"width": 120.0, "depth": 60.0, "height": 200.0},
            materialId="metal_white",
            visible=True,
            locked=False,
            parentId=None,
            childIds=[],
            faces=_default_faces(),
        )
        front_planogram = _make_planogram(f"Gondole {label} - Face avant", furniture_id, Face.front, 5, 8, 120.0, 200.0, product_iter)
        back_planogram  = _make_planogram(f"Gondole {label} - Face arrière", furniture_id, Face.back,  5, 8, 120.0, 200.0, product_iter)
        left_planogram  = _make_planogram(f"Gondole {label} - Face gauche",  furniture_id, Face.left,  5, 4,  60.0, 200.0, product_iter)
        right_planogram = _make_planogram(f"Gondole {label} - Face droite",  furniture_id, Face.right, 5, 4,  60.0, 200.0, product_iter)
        gondola.faces["front"] = front_planogram["id"]
        gondola.faces["back"]  = back_planogram["id"]
        gondola.faces["left"]  = left_planogram["id"]
        gondola.faces["right"] = right_planogram["id"]
        furniture.append(gondola.model_dump(mode="json"))
        planograms.extend([front_planogram, back_planogram, left_planogram, right_planogram])

    # End gondolas (tête de gondole) at each end of the main aisle
    end_gondola_specs = [
        # (position, rotation_y, name)
        ([1100.0, 0.0, 1200.0], 270.0, "Tête de gondole 1"),
        ([2600.0, 0.0, 1200.0],  90.0, "Tête de gondole 2"),
    ]
    for eg_index, (eg_position, eg_rot_y, eg_name) in enumerate(end_gondola_specs, start=1):
        furniture_id = str(uuid4())
        end_gondola = FurnitureInstance(
            id=furniture_id,
            name=eg_name,
            type="end_gondola",
            libraryId="end_gondola",
            position=eg_position,
            rotation=[0.0, eg_rot_y, 0.0],
            dimensions={"width": 80.0, "depth": 60.0, "height": 180.0},
            materialId="solid_red",
            visible=True,
            locked=False,
            parentId=None,
            childIds=[],
            faces=_default_faces(),
        )
        front_planogram = _make_planogram(
            f"{eg_name} - Face avant",
            furniture_id,
            Face.front,
            rows=4,
            cols=2,
            width_cm=80.0,
            height_cm=180.0,
            product_iter=product_iter,
        )
        back_planogram = _make_planogram(
            f"{eg_name} - Face arrière",
            furniture_id,
            Face.back,
            rows=4,
            cols=2,
            width_cm=80.0,
            height_cm=180.0,
            product_iter=product_iter,
        )
        left_planogram = _make_planogram(
            f"{eg_name} - Face gauche",
            furniture_id,
            Face.left,
            rows=4,
            cols=2,
            width_cm=60.0,
            height_cm=180.0,
            product_iter=product_iter,
        )
        right_planogram = _make_planogram(
            f"{eg_name} - Face droite",
            furniture_id,
            Face.right,
            rows=4,
            cols=2,
            width_cm=60.0,
            height_cm=180.0,
            product_iter=product_iter,
        )
        end_gondola.faces["front"] = front_planogram["id"]
        end_gondola.faces["back"]  = back_planogram["id"]
        end_gondola.faces["left"]  = left_planogram["id"]
        end_gondola.faces["right"] = right_planogram["id"]
        furniture.append(end_gondola.model_dump(mode="json"))
        planograms.extend([front_planogram, back_planogram, left_planogram, right_planogram])

    fridge_positions = ([1600.0, 0.0, 2550.0], [2900.0, 0.0, 2550.0])
    for index, position in enumerate(fridge_positions, start=1):
        furniture_id = str(uuid4())
        fridge = FurnitureInstance(
            id=furniture_id,
            name=f"Frigo {index}",
            type="fridge",
            libraryId="fridge",
            position=list(position),
            rotation=[0.0, 180.0, 0.0],
            dimensions={"width": 100.0, "depth": 80.0, "height": 210.0},
            materialId="glass_clear",
            visible=True,
            locked=False,
            parentId=None,
            childIds=[],
            faces=_default_faces(),
        )
        front_planogram = _make_planogram(f"Frigo {index} - Face avant", furniture_id, Face.front, 6, 5, 100.0, 210.0, product_iter)
        fridge.faces["front"] = front_planogram["id"]
        furniture.append(fridge.model_dump(mode="json"))
        planograms.append(front_planogram)

    register = FurnitureInstance(
        id=str(uuid4()),
        name="Caisse principale",
        type="register",
        libraryId="register",
        position=[4200.0, 0.0, 350.0],
        rotation=[0.0, 180.0, 0.0],
        dimensions={"width": 80.0, "depth": 60.0, "height": 90.0},
        materialId="plastic_black",
        visible=True,
        locked=False,
        parentId=None,
        childIds=[],
        faces=_default_faces(),
    )
    furniture.append(register.model_dump(mode="json"))

    scene = SceneData(store=store, furniture=[FurnitureInstance.model_validate(item) for item in furniture]).model_dump(mode="json")
    return {
        "scene": scene,
        "catalog": {"products": products},
        "planograms": {"planograms": planograms},
        "materials": {"materials": [material.model_dump(mode="json") for material in materials]},
    }
