"""Carrefour Express 110 m² — zone touristique (configuration statique de référence).

Génère un projet complet « à la manière » du modèle ``carrefour_city`` :

* une scène de 110 m² (11 m × 10 m) construite uniquement avec les meubles de la
  bibliothèque existante (``furniture_library.json``) : gondoles simples murales,
  gondoles doubles centrales, frigos verticaux, frigos horizontaux, caisses,
  présentoirs et palettes promo ;
* un assortiment fictif d'environ 3 000 SKU suivant la hiérarchie
  Catégorie → Sous-catégorie → Marque → Gamme → Produit, avec prix d'achat,
  prix de vente, marge brute et taux de marge **fictifs** (données de simulation,
  en aucun cas des prix Carrefour réels) ;
* des planogrammes conformes au merchandising : chaque face de meuble est dédiée
  à une seule sous-catégorie, les marques restent regroupées, et les proximités
  de cross-merchandising sont exprimées par l'adjacence spatiale des meubles
  (pâtes ↔ sauces, bières ↔ chips via l'allée droite, sandwichs ↔ boissons
  fraîches dans les frigos voisins, confiserie de caisse près des caisses).

Plan d'implantation (cm, origine au coin avant-gauche, x → droite, z → fond) :

    z=1000  ┌──────────────── mur arrière ────────────────┐
            │ F1 F2 F3 F4 F5 F6   [G-fond ×3 : pain/monde/animalerie]
    z≈700   │   [Surgelés FH1]  [Surgelés FH2]            │
    z≈500   │   [Rangée B ×5 : bières-vins / boissons]    │
    z≈290   │   [Rangée A ×5 : épicerie salée / sucrée]   │
    mur G   │ hygiène, entretien, bébé   snacks, terroir  │ mur D
    z≈100   │ [Caisses ×2] [Présentoirs ×3] [Palettes ×2] │
    z=0     └───── sortie ─────────────── entrée ─────────┘
            x=0                                        x=1100

Orientations (front local = +Z à rotation 0, pivot au centre de l'emprise) :
    rotation   0 → face avant vers +Z (fond)     — rangées centrales
    rotation  90 → face avant vers +X            — mur gauche
    rotation 180 → face avant vers −Z (entrée)   — mur arrière (frigos, fond)
    rotation 270 → face avant vers −X            — mur droit
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator
from uuid import uuid4

from models.project import (
    Catalog,
    Face,
    FloorZone,
    FurnitureInstance,
    Material,
    Planogram,
    PlanogramCell,
    SceneData,
    Store,
    Wall,
    ZoneTypeEnum,
)

PROJECT_ID = "carrefour_express"
PROJECT_NAME = "Carrefour Express 110 m² – Zone touristique"

STORE_WIDTH_CM = 1100.0
STORE_DEPTH_CM = 1000.0
STORE_HEIGHT_CM = 400.0

_EAN_PREFIX = "376"


# ---------------------------------------------------------------------------
# Assortiment — hiérarchie Catégorie → Sous-catégorie → Marque → Gamme → Produit
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SubcategorySpec:
    """Spécification d'une sous-catégorie de l'assortiment.

    ``brands`` associe chaque marque (fictive ou générique) à ses gammes.
    ``products`` liste les intitulés produits déclinés par gamme et format.
    ``formats`` : (libellé, poids en g, dimensions en cm).
    ``sell_base_eur`` : prix de vente de base du premier format.
    ``format_multipliers`` : coefficient prix appliqué par format.
    ``margin_pct`` : taux de marge brute fictif (sur prix de vente).
    """

    category: str
    subcategory: str
    brands: list[tuple[str, list[str]]]
    products: list[str]
    formats: list[tuple[str, float, dict[str, float]]]
    sell_base_eur: float
    format_multipliers: list[float]
    margin_pct: float


_SMALL = {"width": 6.0, "depth": 4.0, "height": 12.0}
_MEDIUM = {"width": 9.0, "depth": 6.0, "height": 20.0}
_LARGE = {"width": 12.0, "depth": 8.0, "height": 28.0}
_FLAT = {"width": 14.0, "depth": 5.0, "height": 20.0}
_POT = {"width": 8.0, "depth": 8.0, "height": 10.0}
_BOTTLE = {"width": 8.0, "depth": 8.0, "height": 30.0}
_CAN = {"width": 6.5, "depth": 6.5, "height": 12.0}


def _fmt(label: str, weight: float, dims: dict[str, float]) -> tuple[str, float, dict[str, float]]:
    return (label, weight, dims)


_SUBCATEGORIES: dict[str, SubcategorySpec] = {
    # ---------------- Épicerie salée (rangée A, faces avant) ----------------
    "pates_riz": SubcategorySpec(
        category="Épicerie salée",
        subcategory="Pâtes & riz",
        brands=[
            ("Barilla", ["Classique", "Collezione"]),
            ("Panzani", ["Tradition", "Qualité Or"]),
            ("Lustucru", ["Sélection"]),
            ("Taureau Ailé", ["Riz du monde"]),
        ],
        products=["Spaghetti", "Penne", "Fusilli", "Coquillettes", "Riz basmati", "Riz long grain", "Tagliatelles"],
        formats=[_fmt("250g", 250, _SMALL), _fmt("500g", 500, _MEDIUM), _fmt("1kg", 1000, _LARGE)],
        sell_base_eur=1.15,
        format_multipliers=[1.0, 1.6, 2.7],
        margin_pct=24.0,
    ),
    "sauces_condiments": SubcategorySpec(
        category="Épicerie salée",
        subcategory="Sauces & condiments",
        brands=[
            ("Panzani", ["Sauces tomates"]),
            ("Barilla", ["Pesti & sughi"]),
            ("Maille", ["Moutardes", "Vinaigrettes"]),
            ("Amora", ["Classiques"]),
            ("Heinz", ["Tomato"]),
        ],
        products=["Sauce tomate basilic", "Sauce bolognaise", "Pesto verde", "Moutarde de Dijon", "Ketchup", "Mayonnaise", "Sauce arrabbiata"],
        formats=[_fmt("200g", 200, _SMALL), _fmt("400g", 400, _MEDIUM), _fmt("600g", 600, _LARGE)],
        sell_base_eur=1.65,
        format_multipliers=[1.0, 1.5, 2.1],
        margin_pct=26.0,
    ),
    "conserves": SubcategorySpec(
        category="Épicerie salée",
        subcategory="Conserves & bocaux",
        brands=[
            ("Bonduelle", ["Légumes vapeur", "Classiques"]),
            ("Cassegrain", ["Recettes cuisinées"]),
            ("Saupiquet", ["Thons & poissons"]),
            ("William Saurin", ["Plats mijotés"]),
        ],
        products=["Haricots verts", "Maïs doux", "Thon au naturel", "Sardines à l'huile", "Ratatouille", "Cassoulet", "Petits pois carottes"],
        formats=[_fmt("140g", 140, _SMALL), _fmt("400g", 400, _POT), _fmt("800g", 800, _LARGE)],
        sell_base_eur=1.45,
        format_multipliers=[1.0, 1.7, 2.6],
        margin_pct=25.0,
    ),
    "soupes_plats": SubcategorySpec(
        category="Épicerie salée",
        subcategory="Soupes & plats cuisinés",
        brands=[
            ("Knorr", ["Soupes douceur"]),
            ("Liebig", ["PurSoup"]),
            ("Panzani", ["Plats express"]),
            ("Lustucru", ["Lunch Box"]),
        ],
        products=["Velouté de tomates", "Soupe de légumes", "Gratin dauphinois", "Risotto champignons", "Pâtes carbonara express", "Taboulé oriental"],
        formats=[_fmt("300g", 300, _MEDIUM), _fmt("1L", 1000, _BOTTLE), _fmt("2x300g", 600, _LARGE)],
        sell_base_eur=1.95,
        format_multipliers=[1.0, 1.6, 1.9],
        margin_pct=27.0,
    ),
    "huiles_epices": SubcategorySpec(
        category="Épicerie salée",
        subcategory="Huiles, épices & aides culinaires",
        brands=[
            ("Puget", ["Huiles d'olive"]),
            ("Lesieur", ["Huiles variées"]),
            ("Ducros", ["Épices du monde", "Herbes de Provence"]),
            ("Maggi", ["Bouillons"]),
        ],
        products=["Huile d'olive vierge extra", "Huile de tournesol", "Poivre noir moulu", "Herbes de Provence", "Sel de Guérande", "Bouillon de volaille", "Paprika doux"],
        formats=[_fmt("50g", 50, _SMALL), _fmt("50cl", 500, _BOTTLE), _fmt("1L", 1000, _BOTTLE)],
        sell_base_eur=2.10,
        format_multipliers=[1.0, 2.2, 3.6],
        margin_pct=28.0,
    ),
    # ---------------- Épicerie sucrée (rangée A, faces arrière) -------------
    "biscuits": SubcategorySpec(
        category="Épicerie sucrée",
        subcategory="Biscuits & gâteaux",
        brands=[
            ("LU", ["Petit Beurre", "Prince"]),
            ("Bonne Maman", ["Tartelettes", "Madeleines"]),
            ("Michel et Augustin", ["Petits carrés"]),
            ("St Michel", ["Galettes"]),
        ],
        products=["Petit beurre", "Cookies chocolat", "Madeleines", "Tartelettes fraise", "Galettes bretonnes", "Sablés citron", "Gaufrettes vanille"],
        formats=[_fmt("150g", 150, _FLAT), _fmt("300g", 300, _FLAT), _fmt("450g", 450, _LARGE)],
        sell_base_eur=1.85,
        format_multipliers=[1.0, 1.7, 2.3],
        margin_pct=27.0,
    ),
    "chocolat_confiserie": SubcategorySpec(
        category="Épicerie sucrée",
        subcategory="Chocolat & confiserie",
        brands=[
            ("Lindt", ["Excellence", "Lindor"]),
            ("Milka", ["Tablettes"]),
            ("Côte d'Or", ["Noir de Noir"]),
            ("Haribo", ["Bonbons"]),
        ],
        products=["Tablette noir 70%", "Tablette lait", "Tablette noisettes", "Bouchées assorties", "Bonbons acidulés", "Dragéifiés fruits", "Tablette blanc"],
        formats=[_fmt("100g", 100, _FLAT), _fmt("200g", 200, _FLAT), _fmt("300g", 300, _FLAT)],
        sell_base_eur=1.95,
        format_multipliers=[1.0, 1.8, 2.5],
        margin_pct=28.0,
    ),
    "petit_dejeuner": SubcategorySpec(
        category="Épicerie sucrée",
        subcategory="Petit-déjeuner",
        brands=[
            ("Kellogg's", ["Corn Flakes", "Extra"]),
            ("Nestlé", ["Chocapic", "Fitness"]),
            ("Nutella", ["Pâte à tartiner"]),
            ("Bonne Maman", ["Confitures"]),
        ],
        products=["Céréales nature", "Céréales chocolat", "Muesli fruits", "Pâte à tartiner", "Confiture fraise", "Confiture abricot", "Miel de fleurs"],
        formats=[_fmt("250g", 250, _MEDIUM), _fmt("375g", 375, _MEDIUM), _fmt("750g", 750, _LARGE)],
        sell_base_eur=2.25,
        format_multipliers=[1.0, 1.4, 2.4],
        margin_pct=25.0,
    ),
    "cafe_the": SubcategorySpec(
        category="Épicerie sucrée",
        subcategory="Café, thé & infusions",
        brands=[
            ("Carte Noire", ["Moulu", "Capsules"]),
            ("L'Or", ["Espresso"]),
            ("Lipton", ["Thés verts", "Thés noirs"]),
            ("Éléphant", ["Infusions"]),
        ],
        products=["Café moulu intense", "Capsules espresso x10", "Thé vert menthe", "Thé noir Earl Grey", "Infusion verveine", "Café grains", "Thé glacé à infuser"],
        formats=[_fmt("100g", 100, _SMALL), _fmt("250g", 250, _MEDIUM), _fmt("500g", 500, _LARGE)],
        sell_base_eur=2.95,
        format_multipliers=[1.0, 1.7, 2.9],
        margin_pct=26.0,
    ),
    "sucre_desserts": SubcategorySpec(
        category="Épicerie sucrée",
        subcategory="Sucre, farine & desserts",
        brands=[
            ("Alsa", ["Préparations"]),
            ("Vahiné", ["Aides pâtisserie"]),
            ("Francine", ["Farines"]),
            ("Saint Louis", ["Sucres"]),
        ],
        products=["Sucre en poudre", "Farine de blé T45", "Levure chimique", "Préparation crêpes", "Sucre vanillé", "Flan entremets", "Pépites de chocolat"],
        formats=[_fmt("100g", 100, _SMALL), _fmt("500g", 500, _MEDIUM), _fmt("1kg", 1000, _LARGE)],
        sell_base_eur=1.25,
        format_multipliers=[1.0, 1.8, 2.8],
        margin_pct=23.0,
    ),
    # ---------------- Bières & vins (rangée B, faces avant) -----------------
    "bieres_cidres": SubcategorySpec(
        category="Bières, vins & spiritueux",
        subcategory="Bières & cidres",
        brands=[
            ("Heineken", ["Original"]),
            ("Leffe", ["Blonde", "Ambrée"]),
            ("Desperados", ["Original"]),
            ("1664", ["Blonde", "Blanc"]),
            ("Loïc Raison", ["Cidres bretons"]),
        ],
        products=["Bière blonde", "Bière ambrée", "Bière blanche", "Bière aromatisée tequila", "Cidre brut", "Cidre doux", "Bière sans alcool"],
        formats=[_fmt("33cl", 330, _CAN), _fmt("50cl", 500, _CAN), _fmt("Pack 6x25cl", 1500, _LARGE)],
        sell_base_eur=1.60,
        format_multipliers=[1.0, 1.4, 4.2],
        margin_pct=24.0,
    ),
    "vins": SubcategorySpec(
        category="Bières, vins & spiritueux",
        subcategory="Vins",
        brands=[
            ("La Cave d'Augustin Florent", ["Bordeaux", "Côtes du Rhône"]),
            ("JP Chenet", ["Cépages", "Réserve"]),
            ("Roche Mazet", ["Pays d'Oc", "Sélection"]),
            ("Listel", ["Gris de gris"]),
        ],
        products=["Rouge merlot", "Rouge cabernet", "Blanc chardonnay", "Blanc sauvignon", "Rosé cinsault", "Rouge syrah", "Blanc moelleux"],
        formats=[_fmt("25cl", 250, _SMALL), _fmt("75cl", 750, _BOTTLE), _fmt("Bag-in-box 3L", 3000, _LARGE)],
        sell_base_eur=2.20,
        format_multipliers=[1.0, 2.4, 6.5],
        margin_pct=30.0,
    ),
    "spiritueux": SubcategorySpec(
        category="Bières, vins & spiritueux",
        subcategory="Spiritueux & apéritifs",
        brands=[
            ("Ricard", ["Anisés"]),
            ("Martini", ["Vermouths"]),
            ("Label 5", ["Whiskies"]),
            ("Poliakov", ["Vodkas"]),
        ],
        products=["Pastis", "Vermouth rosso", "Whisky blend", "Vodka pure", "Rhum ambré", "Gin London Dry", "Porto tawny"],
        formats=[_fmt("20cl", 200, _SMALL), _fmt("70cl", 700, _BOTTLE), _fmt("1L", 1000, _BOTTLE)],
        sell_base_eur=6.50,
        format_multipliers=[1.0, 2.3, 3.0],
        margin_pct=32.0,
    ),
    # ---------------- Boissons (rangée B, faces arrière) --------------------
    "eaux": SubcategorySpec(
        category="Boissons",
        subcategory="Eaux",
        brands=[
            ("Evian", ["Plates"]),
            ("Volvic", ["Plates", "Touche de fruit"]),
            ("Perrier", ["Gazeuses", "Fines bulles"]),
            ("San Pellegrino", ["Gazeuses fines bulles"]),
            ("Cristaline", ["Sources de France"]),
        ],
        products=["Eau minérale naturelle", "Eau de source", "Eau gazeuse", "Eau finement pétillante", "Eau aromatisée citron", "Eau aromatisée fraise", "Eau minérale sport"],
        formats=[_fmt("50cl", 500, _BOTTLE), _fmt("1L", 1000, _BOTTLE), _fmt("1.5L", 1500, _BOTTLE)],
        sell_base_eur=0.70,
        format_multipliers=[1.0, 1.5, 1.9],
        margin_pct=22.0,
    ),
    "sodas": SubcategorySpec(
        category="Boissons",
        subcategory="Sodas & limonades",
        brands=[
            ("Coca-Cola", ["Original", "Zéro", "Cherry"]),
            ("Pepsi", ["Original", "Max"]),
            ("Orangina", ["Original"]),
            ("Schweppes", ["Agrumes", "Tonic"]),
        ],
        products=["Soda cola", "Soda cola sans sucres", "Soda orange", "Limonade artisanale", "Tonic", "Soda agrumes", "Soda cerise"],
        formats=[_fmt("33cl", 330, _CAN), _fmt("50cl", 500, _BOTTLE), _fmt("1.5L", 1500, _BOTTLE)],
        sell_base_eur=1.10,
        format_multipliers=[1.0, 1.5, 2.3],
        margin_pct=25.0,
    ),
    "jus": SubcategorySpec(
        category="Boissons",
        subcategory="Jus & nectars",
        brands=[
            ("Tropicana", ["Pure Premium"]),
            ("Innocent", ["Smoothies", "Jus frais"]),
            ("Joker", ["Le Fruit"]),
            ("Pago", ["Nectars"]),
        ],
        products=["Jus d'orange", "Jus de pomme", "Multifruits", "Smoothie mangue passion", "Nectar abricot", "Jus d'ananas", "Jus de raisin"],
        formats=[_fmt("25cl", 250, _SMALL), _fmt("1L", 1000, _BOTTLE), _fmt("1.5L", 1500, _BOTTLE)],
        sell_base_eur=1.50,
        format_multipliers=[1.0, 2.0, 2.7],
        margin_pct=26.0,
    ),
    "energisantes": SubcategorySpec(
        category="Boissons",
        subcategory="Boissons énergisantes & thés glacés",
        brands=[
            ("Red Bull", ["Energy"]),
            ("Monster", ["Energy", "Ultra"]),
            ("Lipton", ["Ice Tea"]),
            ("Fuze Tea", ["Thés glacés"]),
        ],
        products=["Boisson énergisante", "Boisson énergisante sans sucres", "Thé glacé pêche", "Thé glacé citron", "Thé glacé menthe", "Boisson isotonique", "Thé glacé framboise"],
        formats=[_fmt("25cl", 250, _CAN), _fmt("50cl", 500, _CAN), _fmt("1L", 1000, _BOTTLE)],
        sell_base_eur=1.35,
        format_multipliers=[1.0, 1.6, 2.4],
        margin_pct=27.0,
    ),
    # ---------------- Mur gauche --------------------------------------------
    "hygiene_corps": SubcategorySpec(
        category="Hygiène & beauté",
        subcategory="Hygiène corps & douche",
        brands=[
            ("Dove", ["Nourrissants"]),
            ("Le Petit Marseillais", ["Douceurs de Provence"]),
            ("Nivea", ["Soins corps"]),
            ("Sanex", ["Zéro %"]),
        ],
        products=["Gel douche lait", "Gel douche amande", "Savon solide", "Déodorant bille", "Déodorant spray", "Crème mains", "Lait corporel"],
        formats=[_fmt("50ml", 50, _SMALL), _fmt("250ml", 250, _MEDIUM), _fmt("400ml", 400, _MEDIUM)],
        sell_base_eur=1.95,
        format_multipliers=[1.0, 1.8, 2.4],
        margin_pct=30.0,
    ),
    "capillaire_bucco": SubcategorySpec(
        category="Hygiène & beauté",
        subcategory="Capillaire & bucco-dentaire",
        brands=[
            ("Head & Shoulders", ["Antipelliculaires"]),
            ("L'Oréal Elsève", ["Réparateurs"]),
            ("Signal", ["Protection"]),
            ("Colgate", ["Blancheur"]),
        ],
        products=["Shampooing usage fréquent", "Après-shampooing", "Dentifrice menthe", "Dentifrice blancheur", "Brosse à dents medium", "Bain de bouche", "Shampooing 2en1"],
        formats=[_fmt("75ml", 75, _SMALL), _fmt("250ml", 250, _MEDIUM), _fmt("400ml", 400, _MEDIUM)],
        sell_base_eur=2.30,
        format_multipliers=[1.0, 1.7, 2.3],
        margin_pct=31.0,
    ),
    "beaute_solaire": SubcategorySpec(
        category="Hygiène & beauté",
        subcategory="Beauté & solaire",
        brands=[
            ("Nivea Sun", ["Protect & Hydrate"]),
            ("Garnier Ambre Solaire", ["Sensitive"]),
            ("Mixa", ["Peaux sensibles"]),
            ("Labello", ["Soins lèvres"]),
        ],
        products=["Crème solaire SPF30", "Crème solaire SPF50", "Après-soleil", "Lait hydratant", "Stick lèvres", "Eau micellaire", "Brume visage"],
        formats=[_fmt("20ml", 20, _SMALL), _fmt("200ml", 200, _MEDIUM), _fmt("400ml", 400, _MEDIUM)],
        sell_base_eur=3.20,
        format_multipliers=[1.0, 2.2, 3.1],
        margin_pct=33.0,
    ),
    "entretien": SubcategorySpec(
        category="Entretien & maison",
        subcategory="Entretien & maison",
        brands=[
            ("Paic", ["Vaisselle"]),
            ("Ajax", ["Multi-surfaces"]),
            ("Le Chat", ["Lessives"]),
            ("Lotus", ["Papier & essuie-tout"]),
        ],
        products=["Liquide vaisselle citron", "Nettoyant multi-usages", "Lessive liquide", "Éponges x3", "Essuie-tout x2", "Papier toilette x6", "Sacs poubelle 30L"],
        formats=[_fmt("Format voyage", 100, _SMALL), _fmt("Standard", 500, _MEDIUM), _fmt("Maxi", 1500, _LARGE)],
        sell_base_eur=1.75,
        format_multipliers=[1.0, 1.9, 3.0],
        margin_pct=26.0,
    ),
    "bebe": SubcategorySpec(
        category="Bébé",
        subcategory="Bébé",
        brands=[
            ("Blédina", ["Petits pots", "Blédichef"]),
            ("Pampers", ["Baby-Dry"]),
            ("Gallia", ["Laits infantiles"]),
            ("Mustela", ["Toilette bébé"]),
        ],
        products=["Petit pot carotte", "Petit pot pomme", "Couches T3 x12", "Lingettes bébé", "Lait de suite", "Gel lavant doux", "Céréales infantiles"],
        formats=[_fmt("130g", 130, _SMALL), _fmt("2x200g", 400, _MEDIUM), _fmt("Pack familial", 900, _LARGE)],
        sell_base_eur=2.10,
        format_multipliers=[1.0, 1.7, 3.2],
        margin_pct=24.0,
    ),
    # ---------------- Mur droit ---------------------------------------------
    "chips_aperitif": SubcategorySpec(
        category="Snacking & apéritif",
        subcategory="Chips & apéritif",
        brands=[
            ("Lay's", ["Nature", "Saveurs"]),
            ("Doritos", ["Tortillas", "Dips"]),
            ("Pringles", ["Tubes", "Hot"]),
            ("Bénénuts", ["Cacahuètes & mix"]),
        ],
        products=["Chips nature", "Chips barbecue", "Tortillas fromage", "Cacahuètes grillées", "Mélange apéritif", "Crackers salés", "Chips vinaigre"],
        formats=[_fmt("45g", 45, _SMALL), _fmt("120g", 120, _FLAT), _fmt("200g", 200, _FLAT)],
        sell_base_eur=1.20,
        format_multipliers=[1.0, 1.9, 2.6],
        margin_pct=29.0,
    ),
    "terroir": SubcategorySpec(
        category="Produits régionaux & souvenirs",
        subcategory="Terroir & épicerie fine",
        brands=[
            ("Reflets de France", ["Recettes régionales", "Douceurs"]),
            ("La Mère Poulard", ["Biscuiterie normande", "Palets"]),
            ("Albert Ménès", ["Épicerie fine", "Terrines"]),
            ("Maison Francis Miot", ["Confitures artisanales"]),
        ],
        products=["Terrine de campagne", "Rillettes de canard", "Caramels au beurre salé", "Galettes pur beurre", "Confiture artisanale", "Nougat de Provence", "Calissons"],
        formats=[_fmt("90g", 90, _SMALL), _fmt("180g", 180, _POT), _fmt("Coffret 350g", 350, _FLAT)],
        sell_base_eur=3.40,
        format_multipliers=[1.0, 1.7, 3.2],
        margin_pct=36.0,
    ),
    "bazar": SubcategorySpec(
        category="Bazar & dépannage",
        subcategory="Bazar plage & dépannage",
        brands=[
            ("Carrefour Essentiel", ["Dépannage"]),
            ("Duracell", ["Piles"]),
            ("Bic", ["Briquets & rasoirs"]),
            ("Solar Fun", ["Accessoires plage"]),
        ],
        products=["Piles AA x4", "Briquet", "Rasoir jetable x3", "Lunettes de soleil", "Chapeau de paille", "Adaptateur prise EU", "Parapluie pliant"],
        formats=[_fmt("Unité", 100, _SMALL), _fmt("Lot x2", 200, _MEDIUM), _fmt("Lot familial", 400, _MEDIUM)],
        sell_base_eur=2.50,
        format_multipliers=[1.0, 1.8, 2.9],
        margin_pct=40.0,
    ),
    # ---------------- Fond de magasin (gondoles murales) --------------------
    "boulangerie": SubcategorySpec(
        category="Boulangerie & viennoiserie",
        subcategory="Pain & viennoiserie",
        brands=[
            ("Harrys", ["American Sandwich", "Beau & Bon"]),
            ("Jacquet", ["Pains de mie"]),
            ("La Boulangère", ["Viennoiseries"]),
            ("Pasquier", ["Brioches"]),
        ],
        products=["Pain de mie nature", "Pain de mie complet", "Croissants x4", "Pains au chocolat x4", "Brioche tressée", "Baguette précuite", "Pains au lait x6"],
        formats=[_fmt("280g", 280, _FLAT), _fmt("500g", 500, _LARGE), _fmt("Maxi 750g", 750, _LARGE)],
        sell_base_eur=1.55,
        format_multipliers=[1.0, 1.6, 2.2],
        margin_pct=25.0,
    ),
    "cuisine_monde": SubcategorySpec(
        category="Cuisine du monde",
        subcategory="Cuisine du monde",
        brands=[
            ("Suzi Wan", ["Asie"]),
            ("Old El Paso", ["Tex-Mex"]),
            ("Blue Dragon", ["Wok"]),
            ("Zakia", ["Orient"]),
        ],
        products=["Nouilles sautées", "Kit fajitas", "Sauce soja", "Lait de coco", "Couscous perlé", "Curry rouge", "Tortillas x8"],
        formats=[_fmt("150g", 150, _SMALL), _fmt("300g", 300, _MEDIUM), _fmt("Kit complet", 550, _LARGE)],
        sell_base_eur=2.35,
        format_multipliers=[1.0, 1.6, 2.5],
        margin_pct=28.0,
    ),
    "animalerie": SubcategorySpec(
        category="Animalerie",
        subcategory="Animalerie",
        brands=[
            ("Whiskas", ["Chats adultes"]),
            ("Pedigree", ["Chiens adultes"]),
            ("Sheba", ["Délices"]),
            ("Frolic", ["Complets"]),
        ],
        products=["Croquettes chat", "Croquettes chien", "Sachets fraîcheur chat x4", "Bouchées chien", "Friandises chat", "Bâtonnets chien", "Pâtée chat"],
        formats=[_fmt("100g", 100, _SMALL), _fmt("400g", 400, _MEDIUM), _fmt("1.5kg", 1500, _LARGE)],
        sell_base_eur=1.60,
        format_multipliers=[1.0, 1.9, 3.4],
        margin_pct=27.0,
    ),
    # ---------------- Frigos verticaux (mur arrière) ------------------------
    "yaourts": SubcategorySpec(
        category="Crémerie",
        subcategory="Yaourts & desserts frais",
        brands=[
            ("Danone", ["Activia", "Danette"]),
            ("Yoplait", ["Panier de Yoplait", "Yop"]),
            ("La Laitière", ["Desserts gourmands"]),
        ],
        products=["Yaourt nature x4", "Yaourt fruits x4", "Crème dessert chocolat x4", "Riz au lait x2", "Yaourt grec x2", "Mousse chocolat x4", "Yaourt à boire fraise"],
        formats=[_fmt("x2", 250, _POT), _fmt("x4", 500, _POT)],
        sell_base_eur=1.80,
        format_multipliers=[1.0, 1.7],
        margin_pct=23.0,
    ),
    "cremerie_base": SubcategorySpec(
        category="Crémerie",
        subcategory="Lait, beurre & œufs",
        brands=[
            ("Lactel", ["Laits", "Bio"]),
            ("Président", ["Beurres & crèmes"]),
            ("Elle & Vire", ["Crèmes"]),
            ("Matines", ["Œufs plein air"]),
        ],
        products=["Lait demi-écrémé 1L", "Lait entier 1L", "Beurre doux 250g", "Beurre demi-sel 250g", "Crème fraîche 30cl", "Œufs x6", "Crème liquide 20cl"],
        formats=[_fmt("Standard", 500, _MEDIUM), _fmt("Familial", 1000, _LARGE)],
        sell_base_eur=1.45,
        format_multipliers=[1.0, 1.8],
        margin_pct=20.0,
    ),
    "fromages": SubcategorySpec(
        category="Crémerie",
        subcategory="Fromages",
        brands=[
            ("Président", ["Camemberts", "Emmental"]),
            ("Caprice des Dieux", ["Pâtes molles"]),
            ("Boursin", ["Ail & fines herbes"]),
            ("Société", ["Roquefort"]),
        ],
        products=["Camembert", "Emmental râpé", "Fromage ail & fines herbes", "Bûche de chèvre", "Roquefort", "Comté affiné", "Parmesan râpé"],
        formats=[_fmt("125g", 125, _POT), _fmt("250g", 250, _POT)],
        sell_base_eur=2.40,
        format_multipliers=[1.0, 1.7],
        margin_pct=26.0,
    ),
    "charcuterie": SubcategorySpec(
        category="Charcuterie & traiteur",
        subcategory="Charcuterie & traiteur frais",
        brands=[
            ("Herta", ["Tendre Noix", "Bons Snacks"]),
            ("Fleury Michon", ["Le Supérieur"]),
            ("Aoste", ["Charcuteries fines"]),
            ("Madrange", ["Jambons"]),
        ],
        products=["Jambon blanc x4", "Jambon cru x8", "Saucisson sec", "Chorizo doux", "Lardons fumés", "Pâté en croûte", "Rosette tranchée"],
        formats=[_fmt("120g", 120, _FLAT), _fmt("200g", 200, _FLAT)],
        sell_base_eur=2.60,
        format_multipliers=[1.0, 1.6],
        margin_pct=24.0,
    ),
    "snacking_frais": SubcategorySpec(
        category="Snacking frais",
        subcategory="Sandwichs, salades & desserts frais",
        brands=[
            ("Daunat", ["Club", "Maxi"]),
            ("Sodebo", ["Salades repas", "Pasta Box"]),
            ("Mix Buffet", ["Wraps"]),
        ],
        products=["Sandwich jambon beurre", "Sandwich poulet crudités", "Wrap chèvre miel", "Salade César", "Pasta box carbonara", "Salade quinoa", "Dessert tiramisu"],
        formats=[_fmt("Solo", 220, _FLAT), _fmt("Maxi", 350, _FLAT)],
        sell_base_eur=3.20,
        format_multipliers=[1.0, 1.5],
        margin_pct=32.0,
    ),
    "boissons_fraiches": SubcategorySpec(
        category="Boissons",
        subcategory="Boissons fraîches",
        brands=[
            ("Coca-Cola", ["Frais", "Zéro frais"]),
            ("Evian", ["Frais"]),
            ("Tropicana", ["Frais"]),
            ("Lipton", ["Ice Tea frais"]),
        ],
        products=["Soda cola frais", "Eau fraîche", "Jus d'orange frais", "Thé glacé pêche frais", "Smoothie frais", "Eau gazeuse fraîche", "Limonade fraîche"],
        formats=[_fmt("33cl", 330, _CAN), _fmt("50cl", 500, _BOTTLE)],
        sell_base_eur=1.30,
        format_multipliers=[1.0, 1.4],
        margin_pct=30.0,
    ),
    # ---------------- Frigos horizontaux (surgelés) -------------------------
    "glaces": SubcategorySpec(
        category="Surgelés",
        subcategory="Glaces & desserts glacés",
        brands=[
            ("Magnum", ["Classic"]),
            ("Ben & Jerry's", ["Pots"]),
            ("Häagen-Dazs", ["Pots"]),
            ("Carte d'Or", ["Bacs"]),
        ],
        products=["Bâtonnets chocolat x4", "Pot vanille macadamia", "Pot cookie dough", "Cônes x4", "Sorbet citron", "Bac vanille"],
        formats=[_fmt("300ml", 300, _POT), _fmt("500ml", 500, _POT)],
        sell_base_eur=3.50,
        format_multipliers=[1.0, 1.5],
        margin_pct=31.0,
    ),
    "surgeles_sales": SubcategorySpec(
        category="Surgelés",
        subcategory="Plats & légumes surgelés",
        brands=[
            ("Findus", ["Poissons panés"]),
            ("Marie", ["Plats cuisinés"]),
            ("Bonduelle", ["Légumes surgelés"]),
            ("McCain", ["Frites & pommes de terre"]),
        ],
        products=["Poisson pané x6", "Lasagnes bolognaise", "Poêlée méridionale", "Frites classiques", "Pizza royale", "Épinards hachés"],
        formats=[_fmt("400g", 400, _FLAT), _fmt("750g", 750, _LARGE)],
        sell_base_eur=2.90,
        format_multipliers=[1.0, 1.6],
        margin_pct=27.0,
    ),
    # ---------------- Présentoirs de caisse ---------------------------------
    "confiserie_caisse": SubcategorySpec(
        category="Épicerie sucrée",
        subcategory="Confiserie de caisse",
        brands=[
            ("Mentos", ["Rouleaux"]),
            ("Kinder", ["Bueno", "Surprise"]),
            ("Hollywood", ["Chewing-gums"]),
            ("Tic Tac", ["Boîtes"]),
        ],
        products=["Chewing-gum menthe", "Barre chocolatée", "Bonbons rouleau", "Pastilles fraîcheur", "Œuf chocolat surprise", "Mini dragées"],
        formats=[_fmt("Unité", 40, _SMALL), _fmt("Lot x3", 120, _SMALL)],
        sell_base_eur=0.95,
        format_multipliers=[1.0, 2.4],
        margin_pct=38.0,
    ),
    "souvenirs": SubcategorySpec(
        category="Produits régionaux & souvenirs",
        subcategory="Souvenirs & cartes postales",
        brands=[
            ("Souvenirs de France", ["Collection Riviera", "Collection Paris"]),
            ("Éditions du Littoral", ["Cartes postales"]),
            ("Frenchy", ["Magnets & porte-clés"]),
        ],
        products=["Carte postale", "Magnet région", "Porte-clés tour Eiffel", "Mug souvenir", "Tote bag France", "Éventail provençal"],
        formats=[_fmt("Unité", 50, _SMALL), _fmt("Lot x5", 250, _SMALL)],
        sell_base_eur=1.90,
        format_multipliers=[1.0, 3.5],
        margin_pct=45.0,
    ),
    "accessoires_caisse": SubcategorySpec(
        category="Bazar & dépannage",
        subcategory="Accessoires de caisse",
        brands=[
            ("Duracell", ["Piles"]),
            ("Carrefour Essentiel", ["Recharge & mobile"]),
            ("Kleenex", ["Mouchoirs"]),
        ],
        products=["Piles AAA x4", "Câble USB-C", "Mouchoirs poche x6", "Gel hydroalcoolique 50ml", "Écouteurs filaires", "Batterie de secours"],
        formats=[_fmt("Unité", 80, _SMALL), _fmt("Lot x2", 160, _SMALL)],
        sell_base_eur=2.80,
        format_multipliers=[1.0, 1.8],
        margin_pct=42.0,
    ),
    # ---------------- Palettes promo -----------------------------------------
    "promo_eaux": SubcategorySpec(
        category="Promotions",
        subcategory="Multipacks eaux & sodas",
        brands=[
            ("Cristaline", ["Packs"]),
            ("Coca-Cola", ["Packs"]),
        ],
        products=["Pack eau 6x1.5L", "Pack eau gazeuse 6x1L", "Pack soda 6x33cl"],
        formats=[_fmt("Pack x6", 6000, _LARGE), _fmt("Pack x12", 9000, _LARGE)],
        sell_base_eur=3.90,
        format_multipliers=[1.0, 1.8],
        margin_pct=18.0,
    ),
    "promo_bieres": SubcategorySpec(
        category="Promotions",
        subcategory="Multipacks bières",
        brands=[
            ("Heineken", ["Packs"]),
            ("1664", ["Packs"]),
        ],
        products=["Pack bière 6x25cl", "Pack bière 12x25cl", "Pack bière blanche 6x25cl"],
        formats=[_fmt("Pack x6", 1500, _LARGE), _fmt("Pack x12", 3000, _LARGE)],
        sell_base_eur=5.50,
        format_multipliers=[1.0, 1.9],
        margin_pct=20.0,
    ),
}


# ---------------------------------------------------------------------------
# Génération des produits
# ---------------------------------------------------------------------------

def _product_stream(spec: SubcategorySpec, ean_counter: Iterator[int]) -> Iterator[dict]:
    """Itère indéfiniment sur les combinaisons marque → gamme → produit → format.

    L'ordre marque-major garantit que les références d'une même marque restent
    contiguës dans le planogramme (compliance de marque).

    Un flux est partagé entre toutes les faces d'une même sous-catégorie
    (ex. deux faces « Bières & cidres ») : chaque référence est donc produite
    et implantée exactement une fois, avec un EAN unique issu du compteur global.
    """
    cycle = 0
    while True:
        for brand, ranges in spec.brands:
            for range_name in ranges:
                for product_index, product in enumerate(spec.products):
                    for format_index, (label, weight_g, dims) in enumerate(spec.formats):
                        sell = spec.sell_base_eur * spec.format_multipliers[format_index]
                        sell += 0.1 * product_index + 0.3 * cycle
                        sell = round(sell, 2)
                        buy = round(sell * (1.0 - spec.margin_pct / 100.0), 2)
                        index = next(ean_counter)
                        suffix = f" n°{cycle + 1}" if cycle else ""
                        yield {
                            "ean": f"{_EAN_PREFIX}{index:010d}",
                            "name": f"{product} {range_name} {label}{suffix}",
                            "brand": brand,
                            "category": spec.category,
                            "subcategory": spec.subcategory,
                            "productRange": range_name,
                            "format": label,
                            "widthCm": float(dims["width"]),
                            "depthCm": float(dims["depth"]),
                            "heightCm": float(dims["height"]),
                            "weightG": float(weight_g),
                            "imageUrl": None,
                            "priceBuyEur": buy,
                            "priceSellEur": sell,
                            "marginPct": spec.margin_pct,
                        }
        cycle += 1


# ---------------------------------------------------------------------------
# Scène : magasin 110 m² sur le modèle carrefour_city
# ---------------------------------------------------------------------------

@dataclass
class FixtureSpec:
    """Un meuble à instancier avec les faces à remplir.

    ``faces`` : liste de (face, sous-catégorie, lignes, colonnes, largeur, hauteur).
    """

    name: str
    library_id: str
    position: list[float]
    rotation_y: float
    dimensions: dict[str, float]
    material_id: str
    zone: str
    faces: list[tuple[Face, str, int, int, float, float]] = field(default_factory=list)


_GONDOLA_FACE = (6, 12, 120.0, 200.0)   # 72 emplacements
_FRIDGE_FACE = (6, 10, 100.0, 210.0)    # 60 emplacements
_FREEZER_TOP = (4, 12, 300.0, 100.0)    # 48 emplacements
_DISPLAY_FACE = (6, 6, 60.0, 180.0)     # 36 emplacements
_PALLET_FACE = (3, 4, 120.0, 200.0)     # 12 emplacements


def _gondola_face(face: Face, subcat: str) -> tuple[Face, str, int, int, float, float]:
    rows, cols, width, height = _GONDOLA_FACE
    return (face, subcat, rows, cols, width, height)


def _build_fixture_specs() -> list[FixtureSpec]:
    specs: list[FixtureSpec] = []

    gondola_dims = {"width": 120.0, "depth": 60.0, "height": 200.0}
    double_dims = {"width": 120.0, "depth": 80.0, "height": 200.0}
    fridge_dims = {"width": 100.0, "depth": 80.0, "height": 210.0}
    freezer_dims = {"width": 300.0, "depth": 100.0, "height": 100.0}
    display_dims = {"width": 60.0, "depth": 40.0, "height": 180.0}
    pallet_dims = {"width": 120.0, "depth": 80.0, "height": 200.0}
    register_dims = {"width": 80.0, "depth": 60.0, "height": 90.0}

    # ---- Rangée centrale A (épicerie) : front (+Z) = salée, back (−Z) = sucrée
    row_a_front = ["pates_riz", "sauces_condiments", "conserves", "soupes_plats", "huiles_epices"]
    row_a_back = ["biscuits", "chocolat_confiserie", "petit_dejeuner", "cafe_the", "sucre_desserts"]
    for i in range(5):
        specs.append(FixtureSpec(
            name=f"Gondole A-{i + 1:02d}",
            library_id="gondola_double",
            position=[250.0 + i * 120.0, 0.0, 290.0],
            rotation_y=0.0,
            dimensions=dict(double_dims),
            material_id="metal_gray",
            zone="Allée centrale – épicerie",
            faces=[
                _gondola_face(Face.front, row_a_front[i]),
                _gondola_face(Face.back, row_a_back[i]),
            ],
        ))

    # ---- Rangée centrale B (liquides) : front (+Z) = bières/vins, back = soft
    row_b_front = ["bieres_cidres", "bieres_cidres", "vins", "vins", "spiritueux"]
    row_b_back = ["eaux", "eaux", "sodas", "jus", "energisantes"]
    for i in range(5):
        specs.append(FixtureSpec(
            name=f"Gondole B-{i + 1:02d}",
            library_id="gondola_double",
            position=[250.0 + i * 120.0, 0.0, 500.0],
            rotation_y=0.0,
            dimensions=dict(double_dims),
            material_id="metal_gray",
            zone="Allée centrale – liquides",
            faces=[
                _gondola_face(Face.front, row_b_front[i]),
                _gondola_face(Face.back, row_b_back[i]),
            ],
        ))

    # ---- Mur gauche (rotation 90 → face avant vers +X, emprise x ∈ [0, 60])
    left_wall = ["hygiene_corps", "capillaire_bucco", "beaute_solaire", "entretien", "bebe"]
    for i, subcat in enumerate(left_wall):
        specs.append(FixtureSpec(
            name=f"Rayon mur gauche {i + 1:02d}",
            library_id="gondola_single",
            position=[-30.0, 0.0, 290.0 + i * 130.0],
            rotation_y=90.0,
            dimensions=dict(gondola_dims),
            material_id="metal_white",
            zone="Mur gauche – hygiène & maison",
            faces=[_gondola_face(Face.front, subcat)],
        ))

    # ---- Mur droit (rotation 270 → face avant vers −X, emprise x ∈ [1040, 1100])
    right_wall = ["chips_aperitif", "chips_aperitif", "terroir", "terroir", "bazar"]
    for i, subcat in enumerate(right_wall):
        specs.append(FixtureSpec(
            name=f"Rayon mur droit {i + 1:02d}",
            library_id="gondola_single",
            position=[1010.0, 0.0, 290.0 + i * 130.0],
            rotation_y=270.0,
            dimensions=dict(gondola_dims),
            material_id="metal_white",
            zone="Mur droit – snacks & terroir",
            faces=[_gondola_face(Face.front, subcat)],
        ))

    # ---- Mur arrière : 6 frigos verticaux (rotation 180 → face vers l'entrée)
    fridge_subcats = ["yaourts", "cremerie_base", "fromages", "charcuterie", "snacking_frais", "boissons_fraiches"]
    fridge_rows, fridge_cols, fridge_w, fridge_h = _FRIDGE_FACE
    for i, subcat in enumerate(fridge_subcats):
        specs.append(FixtureSpec(
            name=f"Frigo mural {i + 1:02d}",
            library_id="fridge",
            position=[40.0 + i * 110.0, 0.0, 900.0],
            rotation_y=180.0,
            dimensions=dict(fridge_dims),
            material_id="glass_clear",
            zone="Mur arrière – frais",
            faces=[(Face.front, subcat, fridge_rows, fridge_cols, fridge_w, fridge_h)],
        ))

    # ---- Mur arrière : 3 gondoles murales (rotation 180)
    back_wall = ["boulangerie", "cuisine_monde", "animalerie"]
    for i, subcat in enumerate(back_wall):
        specs.append(FixtureSpec(
            name=f"Rayon fond {i + 1:02d}",
            library_id="gondola_single",
            position=[700.0 + i * 130.0, 0.0, 920.0],
            rotation_y=180.0,
            dimensions=dict(gondola_dims),
            material_id="metal_white",
            zone="Mur arrière – fond de magasin",
            faces=[_gondola_face(Face.front, subcat)],
        ))

    # ---- Frigos horizontaux surgelés (face top)
    freezer_rows, freezer_cols, freezer_w, freezer_h = _FREEZER_TOP
    for i, subcat in enumerate(["glaces", "surgeles_sales"]):
        specs.append(FixtureSpec(
            name=f"Frigo horizontal {i + 1}",
            library_id="fridge_horizontal",
            position=[250.0 + i * 320.0, 0.0, 700.0],
            rotation_y=0.0,
            dimensions=dict(freezer_dims),
            material_id="glass_clear",
            zone="Zone surgelés",
            faces=[(Face.top, subcat, freezer_rows, freezer_cols, freezer_w, freezer_h)],
        ))

    # ---- Caisses (2, sans planogramme)
    for i in range(2):
        specs.append(FixtureSpec(
            name=f"Caisse {i + 1}",
            library_id="register",
            position=[140.0 + i * 200.0, 0.0, 100.0],
            rotation_y=0.0,
            dimensions=dict(register_dims),
            material_id="plastic_dark",
            zone="Zone caisses",
            faces=[],
        ))

    # ---- Présentoirs de caisse (rotation 180 → face vers l'entrée / la file)
    display_rows, display_cols, display_w, display_h = _DISPLAY_FACE
    for i, subcat in enumerate(["confiserie_caisse", "souvenirs", "accessoires_caisse"]):
        specs.append(FixtureSpec(
            name=f"Présentoir caisse {i + 1}",
            library_id="display",
            position=[480.0 + i * 80.0, 0.0, 100.0],
            rotation_y=180.0,
            dimensions=dict(display_dims),
            material_id="plastic_white",
            zone="Zone caisses",
            faces=[(Face.front, subcat, display_rows, display_cols, display_w, display_h)],
        ))

    # ---- Palettes promo (face vers l'entrée)
    pallet_rows, pallet_cols, pallet_w, pallet_h = _PALLET_FACE
    for i, subcat in enumerate(["promo_eaux", "promo_bieres"]):
        specs.append(FixtureSpec(
            name=f"Palette promo {i + 1}",
            library_id="pallet",
            position=[760.0 + i * 140.0, 0.0, 140.0],
            rotation_y=180.0,
            dimensions=dict(pallet_dims),
            material_id="wood_light",
            zone="Zone entrée – promotions",
            faces=[(Face.front, subcat, pallet_rows, pallet_cols, pallet_w, pallet_h)],
        ))

    return specs


def _default_faces() -> dict[str, str | None]:
    return {face.value: None for face in Face}


def _build_store() -> Store:
    return Store(
        id=str(uuid4()),
        name=PROJECT_NAME,
        position=[0.0, 0.0, 0.0],
        rotation=[0.0, 0.0, 0.0],
        dimensions={"width": STORE_WIDTH_CM, "depth": STORE_DEPTH_CM, "height": STORE_HEIGHT_CM},
        walls=[
            Wall(
                id=str(uuid4()),
                name="Mur arrière",
                position=[STORE_WIDTH_CM / 2.0, 150.0, STORE_DEPTH_CM - 10.0],
                rotation=[0.0, 0.0, 0.0],
                dimensions={"width": STORE_WIDTH_CM, "depth": 20.0, "height": 300.0},
                materialId="solid_blue",
            ),
            Wall(
                id=str(uuid4()),
                name="Mur gauche",
                position=[10.0, 150.0, STORE_DEPTH_CM / 2.0],
                rotation=[0.0, 0.0, 0.0],
                dimensions={"width": STORE_DEPTH_CM, "depth": 20.0, "height": 300.0},
                materialId="solid_blue",
            ),
            Wall(
                id=str(uuid4()),
                name="Mur droit",
                position=[STORE_WIDTH_CM - 10.0, 150.0, STORE_DEPTH_CM / 2.0],
                rotation=[0.0, 0.0, 0.0],
                dimensions={"width": STORE_DEPTH_CM, "depth": 20.0, "height": 300.0},
                materialId="solid_blue",
            ),
            Wall(
                id=str(uuid4()),
                name="Mur façade",
                position=[STORE_WIDTH_CM / 2.0, 150.0, 10.0],
                rotation=[0.0, 0.0, 0.0],
                dimensions={"width": STORE_WIDTH_CM, "depth": 20.0, "height": 300.0},
                materialId="solid_red",
            ),
        ],
        zones=[
            FloorZone(
                id=str(uuid4()),
                type=ZoneTypeEnum.entrance,
                label="Entrée",
                x=760.0,
                z=20.0,
                width=280.0,
                depth=60.0,
            ),
            FloorZone(
                id=str(uuid4()),
                type=ZoneTypeEnum.exit,
                label="Sortie caisses",
                x=120.0,
                z=20.0,
                width=300.0,
                depth=60.0,
            ),
        ],
    )


def _build_materials() -> list[Material]:
    return [
        Material(id="metal_white", name="Métal blanc", type="metal", color="#f0f0f0", roughness=0.4, metalness=0.6),
        Material(id="metal_gray", name="Métal gris", type="metal", color="#c0c0c0", roughness=0.4, metalness=0.6),
        Material(id="solid_red", name="Rouge Carrefour", type="solid_color", color="#e31820", roughness=0.8, metalness=0.0),
        Material(id="solid_blue", name="Bleu Carrefour", type="solid_color", color="#0060a8", roughness=0.8, metalness=0.0),
        Material(id="plastic_dark", name="Plastique foncé", type="plastic", color="#303030", roughness=0.7, metalness=0.0),
        Material(id="plastic_white", name="Plastique blanc", type="plastic", color="#f7f7f7", roughness=0.5, metalness=0.0),
        Material(id="wood_light", name="Bois clair", type="wood", color="#d4a96a", roughness=0.85, metalness=0.0),
        Material(id="glass_clear", name="Verre", type="glass", color="#aadde8", roughness=0.1, metalness=0.0),
    ]


def generate_carrefour_express() -> dict:
    """Génère la scène, le catalogue, les planogrammes et les matériaux."""
    ean_counter = iter(range(1, 10_000_000))
    streams: dict[str, Iterator[dict]] = {}
    products: list[dict] = []

    furniture: list[dict] = []
    planograms: list[dict] = []

    for spec in _build_fixture_specs():
        furniture_id = str(uuid4())
        instance = FurnitureInstance(
            id=furniture_id,
            name=spec.name,
            type=spec.library_id,
            libraryId=spec.library_id,
            position=list(spec.position),
            rotation=[0.0, spec.rotation_y, 0.0],
            dimensions=dict(spec.dimensions),
            materialId=spec.material_id,
            visible=True,
            locked=False,
            parentId=None,
            childIds=[],
            faces=_default_faces(),
        )

        for face, subcat_key, rows, cols, width_cm, height_cm in spec.faces:
            subcat = _SUBCATEGORIES[subcat_key]
            if subcat_key not in streams:
                streams[subcat_key] = _product_stream(subcat, ean_counter)
            stream = streams[subcat_key]

            cells: list[PlanogramCell] = []
            for row in range(rows):
                for col in range(cols):
                    product = next(stream)
                    products.append(product)
                    cells.append(PlanogramCell(
                        id=str(uuid4()),
                        ean=product["ean"],
                        row=row,
                        col=col,
                        rotation=0,
                    ))

            planogram = Planogram(
                id=str(uuid4()),
                name=f"{spec.name} – {face.value} – {subcat.subcategory}",
                furnitureId=furniture_id,
                face=face,
                rows=rows,
                cols=cols,
                widthCm=width_cm,
                heightCm=height_cm,
                cells=cells,
            )
            instance.faces[face.value] = planogram.id
            planograms.append(planogram.model_dump(mode="json"))

        furniture.append(instance.model_dump(mode="json"))

    scene = SceneData(store=_build_store(), furniture=[
        FurnitureInstance.model_validate(item) for item in furniture
    ]).model_dump(mode="json")

    catalog = Catalog.model_validate({"products": products}).model_dump(mode="json")

    return {
        "scene": scene,
        "catalog": catalog,
        "planograms": {"planograms": planograms},
        "materials": {"materials": [material.model_dump(mode="json") for material in _build_materials()]},
    }
