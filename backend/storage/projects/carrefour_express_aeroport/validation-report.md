# Rapport de validation — Carrefour Express Aéroport 400 m²

Projet : `carrefour_express_aeroport`
Généré à partir de `assortment.json` (pool brut, 4807 produits, lecture seule).

## 1. Demande interprétée

- Enseigne : Carrefour Express
- Contexte : aéroport
- Surface totale : 400 m² (magasin 20 m × 20 m, `scene.json.store.dimensions`)
- Surface de vente : 340 m² (bande arrière de 2000 × 300 cm = 60 m² réservée en
  "réserve / zone technique", non meublée, zone `type: "reserve"` dans
  `scene.json.store.zones`)
- Format : proximité
- Modificateurs de contexte (voir `store-profile.json`) :
  - Catégories boostées : Snacking et prêt-à-manger, Boissons, Presse et
    dépannage, Hygiène et beauté (×1.6 sur le poids de sélection)
  - Catégories réduites : Surgelés, Entretien et droguerie (×0.5)

## 2. Workflow exécuté

1. Parsing de la demande → `store-profile.json`.
2. Exploration du repo pour le mobilier : source trouvée dans
   `backend/storage/furniture_library.json` (types `gondola_single`,
   `gondola_double`, `pallet`, `fridge`, `fridge_horizontal`, `display`,
   `register`, `wall`, `partition`, `floor_grid`) et convention d'instance
   dans `scene.json.furniture` (voir projets `carrefour_city` /
   `carrefour_express` déjà présents : `id`, `type`, `libraryId`, `position`
   [coin bas-gauche], `rotation`, `dimensions`, `materialId`, `faces`
   {face → planogramId}). Aucune géométrie inventée : chaque meuble reprend
   `defaultDimensions` et `hasFaces` de `furniture_library.json`.
3. Répartition surface → rayons : linéaire par (catégorie, sous-catégorie)
   calculé à partir des faces de mobilier attribuées (voir §5), pondéré par
   la part réelle de chaque catégorie dans le pool et les modificateurs de
   contexte.
4. Sélection assortment.json → `catalog.json` : 2002 produits uniques
   (≤ 3000), enrichis (prix, marge, dimensions, poids, gamme, format,
   `isMdd`, `rotationIndice`). Aucun champ prix/marge/dimension laissé vide.
5. Mobilier positionné dans `scene.json` (34 meubles + 3 caisses), validé
   sans collision et allées ≥ 100 cm (voir §6).
6. `materials.json` : réutilisation intégrale des matériaux existants
   (`carrefour_express/materials.json`), + 1 ajout documenté (§7).
7. `planograms.json` : 46 planogrammes générés (une entrée par face de
   mobilier utilisée), cellules remplies selon règles de merchandising
   (§8).
8. Validation finale : script auto-validé avec la même logique que
   `backend/tests/test_reference_projects.py` (collision AABB/OBB avec
   rotation, allées ≥ 100 cm, zones entrée/sortie dégagées, faces
   compatibles avec le mobilier, unicité des `ean`, cohérence
   cellule↔catalogue). **Résultat : aucune violation.**

## 3. Table de pricing (marge % par category_id) — aucune table de marge
préexistante trouvée ailleurs dans le repo ; table construite pour ce
projet :

| category_id | Catégorie | Marge % | Prix d'achat de base (€) |
|---|---|---|---|
| fruits_vegetables | Fruits et légumes | 28.0 | 1.20 |
| butchery_deli | Boucherie, charcuterie, traiteur | 27.0 | 3.20 |
| dairy_cheese | Crèmerie et fromages | 24.0 | 1.40 |
| bakery_pastry | Boulangerie et pâtisserie | 32.0 | 1.10 |
| ready_to_eat | Snacking et prêt-à-manger | 40.0 | 2.60 |
| grocery_savory | Épicerie salée | 22.0 | 1.30 |
| grocery_sweet | Épicerie sucrée | 24.0 | 1.60 |
| frozen | Surgelés | 26.0 | 2.20 |
| beverages | Boissons | 26.0 | 0.70 |
| wine_alcohol | Vins, bières et spiritueux | 23.0 | 4.50 |
| hygiene | Hygiène et beauté | 35.0 | 2.80 |
| household | Entretien et droguerie | 30.0 | 2.10 |
| baby | Puériculture | 22.0 | 3.50 |
| pet | Animalerie | 24.0 | 2.60 |
| press_stationery | Presse et dépannage | 30.0 | 1.80 |

`priceBuyEur` = prix d'achat de base × facteur de taille dérivé de
`quantity` (borné 0.4–2.5). `priceSellEur` = `priceBuyEur / (1 - marge/100)`,
arrondi à la terminaison commerciale la plus proche (`,x5` / `,x9`) ; la
marge finale (`marginPct`) est recalculée après arrondi pour rester
cohérente avec `priceBuyEur`/`priceSellEur`. Aucun produit n'a de prix,
marge ou dimension à 0/null/vide (vérifié par script).

## 4. Table de dimensions/poids par défaut (par subcategory_id)

Aucune table de dimensions produit préexistante trouvée dans le repo (le
pool `assortment.json` n'a ni `widthCm`/`heightCm`/`depthCm`, ni poids).
Table construite (valeurs de référence pour une quantité "standard",
mises à l'échelle par un facteur de taille dérivé de `quantity`) :

| subcategory_id | L×P×H (cm, réf.) | Poids réf. (g) |
|---|---|---|
| fresh_fruits / fresh_vegetables | 12×12×10 | 500 |
| meat | 14×10×4 | 300 |
| delicatessen | 14×10×3 | 150 |
| deli_counter | 16×12×6 | 300 |
| dairy | 7×7×9 | 400 |
| cheese | 10×10×4 | 200 |
| eggs | 16×11×6 | 350 |
| bread | 30×12×10 | 400 |
| viennoiserie | 14×10×6 | 90 |
| sandwiches | 14×8×5 | 180 |
| ready_meals | 18×13×5 | 350 |
| pasta_rice | 6×4×12 | 250 |
| canned_food | 7.5×7.5×10.5 | 400 |
| sauces_condiments | 6.5×6.5×15 | 350 |
| oil_vinegar | 7×7×24 | 750 |
| biscuits | 18×5×12 | 200 |
| chocolate | 14×2×8 | 100 |
| breakfast | 18×8×24 | 375 |
| ice_cream | 12×12×10 | 500 |
| water | 8.5×8.5×24 | 1000 |
| soda | 6.5×6.5×20 | 500 |
| juice | 7×7×18 | 1000 |
| hot_beverages | 10×6×14 | 250 |
| wine | 7.5×7.5×30 | 750 |
| beer | 6.5×6.5×20 | 330 |
| spirits | 8.5×8.5×28 | 700 |
| body_care | 6×6×18 | 250 |
| oral_care | 4×3×18 | 100 |
| hair_care | 6.5×6.5×19 | 300 |
| feminine_hygiene | 12×8×16 | 200 |
| paper_hygiene | 20×20×22 | 500 |
| laundry | 15×10×22 | 1000 |
| dishwashing | 7×7×22 | 500 |
| cleaning_products | 8×8×24 | 750 |
| household_supplies | 15×10×20 | 400 |
| diapers | 30×18×25 | 800 |
| pet_food | 12×8×20 | 800 |
| press | 21×1×29 | 150 |
| stationery | 12×2×18 | 100 |
| *(fallback)* | 10×8×15 | 300 |

`weightG` est recalculé directement depuis `quantity` quand l'unité le
permet (g/kg/mL/L/cl → grammes), sinon on retombe sur la table ci-dessus.

## 5. Table de correspondance des marques

`brand` = premier nom si plusieurs marques listées, séparées par une
virgule dans le pool (aucune occurrence multiple significative rencontrée
dans les 2002 produits sélectionnés).

## 6. Géométrie & circulation

- Magasin 2000 × 2000 cm (400 m²), organisé en deux colonnes parallèles
  (gauche : snacking/presse, épicerie salée, boissons/sucrée, hygiène/vins ;
  droite : surgelés, frais/traiteur, boulangerie/fruits&légumes,
  entretien/puériculture/animalerie), séparées par une allée centrale de
  160 cm.
- Allée entre rangées successives d'une même colonne : 140 cm (> minimum
  100 cm, conforme à la recommandation 120–140 cm en zone à fort trafic
  aéroport).
- Aucune collision entre meubles (test AABB avec rotation, 34 meubles).
- Zones entrée (x 900–1200, z 20–85) et sortie caisses (x 200–500,
  z 20–85) entièrement dégagées de tout mobilier.
- 3 caisses positionnées entre l'entrée et le premier rayon, hors des
  zones entrée/sortie.
- Réserve (60 m²) : bande arrière z 1700–2000, séparée par une cloison,
  non meublée côté vente — aucune violation de circulation associée
  puisqu'aucun mobilier n'y est placé.
- **Aucun écart** aux règles géométriques n'a été nécessaire (pas de
  réduction de module, pas d'allée resserrée) : le nombre de meubles a été
  dimensionné dès la conception pour respecter les contraintes.

## 7. Matériaux

Tous les matériaux déjà définis dans
`backend/storage/projects/carrefour_express/materials.json` sont repris
tels quels. **Un seul ajout** a été nécessaire :

- `wood_dark` (« Bois foncé », `#5C4033`, roughness 0.7, metalness 0.0) :
  requis par `defaultMaterial` du mobilier `pallet` dans
  `furniture_library.json`, absent de `carrefour_express/materials.json`
  (qui ne contient que `wood_light`). Repris à l'identique de la
  définition déjà présente dans `backend/storage/projects/retail_cad/materials.json`
  (aucune géométrie/couleur inventée).

## 8. Merchandising

- **Adjacence de rayons** (cross-selling) : aucune matrice d'adjacence
  préexistante trouvée dans le repo → règles par défaut appliquées :
  snacking/presse près de l'entrée (achat impulsif aéroport), boissons
  fraîches et sodas à proximité des palettes snacking, pâtes/sauces/huiles
  regroupées sur les mêmes gondoles (épicerie salée), fromages/crèmerie et
  traiteur/boucherie/charcuterie en frigos adjacents, boulangerie et
  fruits & légumes en rayon mural adjacent.
- **Adjacence intra-meuble** : sur une même face, produits d'une même
  sous-catégorie regroupés (au lieu d'un tri alphabétique).
- **Étagement vertical** : niveau des yeux (lignes du milieu) = produits au
  meilleur score `rotationIndice × marginPct` ; niveau bas = formats
  lourds et/ou `isMdd: true` ; niveau haut = petits formats.
- **Facings** : nombre de cellules répétant le même `ean` proportionnel au
  score `rotationIndice × marginPct` (plafonné à 4 facings par produit,
  aucun champ `facings` séparé stocké — conforme au schéma figé de
  `planograms.json`).
- Modificateurs de contexte (aéroport) appliqués en amont de la sélection :
  Snacking et prêt-à-manger, Boissons, Presse et dépannage et Hygiène et
  beauté ont un poids de sélection ×1.6 ; Surgelés et Entretien et
  droguerie ×0.5 (conditionnements plus petits/nomades privilégiés via le
  facteur de taille dérivé de `quantity`, formats lourds réduits en
  proportion).

## 9. Répartition finale par catégorie (catalog.json, 2002 produits, dont
364 `isMdd: true`)

| Catégorie | Nombre de références |
|---|---|
| Épicerie salée | 432 |
| Boissons | 234 |
| Épicerie sucrée | 216 |
| Vins, bières et spiritueux | 216 |
| Hygiène et beauté | 197 |
| Boucherie, charcuterie, traiteur | 135 |
| Boulangerie et pâtisserie | 90 |
| Fruits et légumes | 90 |
| Crèmerie et fromages | 90 |
| Snacking et prêt-à-manger | 81 |
| Presse et dépannage | 50 |
| Puériculture | 45 |
| Animalerie | 45 |
| Entretien et droguerie | 45 |
| Surgelés | 36 |
| **Total** | **2002** |

Le total (2002) reste sous le plafond de 3000 imposé par le brief : la
capacité réelle du mobilier posé (46 faces de planogramme, 2700 cellules,
ratio de diversité 0.75) dimensionne un assortiment réaliste pour un
format proximité de 400 m² plutôt que de forcer artificiellement 3000
références.

## 10. Champs additionnels ajoutés à `catalog.json` (schéma étendu, non
destructif)

| Champ | Type | Raison |
|---|---|---|
| `isMdd` | bool | Copié de `is_mdd` du pool ; pilote l'étagement (MDD → niveau bas/haut). |
| `rotationIndice` | float (1–10) | Absent du pool ; estimé (MDD + marge) pour piloter le nombre de facings et la priorité niveau des yeux. |

Aucun champ existant n'a été renommé ni supprimé dans `catalog.json`,
`materials.json` ou `planograms.json`.

## 11. Mobilier non trouvé / limitations

Aucun mobilier ni matériau requis n'a été introuvable (hors l'ajout
documenté `wood_dark`, §7). Aucune règle géométrique n'a dû être
contournée ou assouplie.
