# Rapport de validation — Carrefour Express Aéroport 120 m²

Projet : `carrefour_express_aeroport`
Régénéré à partir de `assortment.json` (pool brut, 4807 produits, lecture seule).

## 1. Demande interprétée

- Enseigne : Carrefour Express
- Contexte : aéroport
- Surface totale = surface de vente : **120 m² exactement**
  (`scene.json.store.dimensions` : 1200 × 1000 cm = 120 000 cm² = 120 m²).
  Il n'y a plus de zone de réserve : la totalité de la grille au sol est
  meublée et vendable (le support de la zone `type: "reserve"` a été
  retiré, cf. §3).
- Format : proximité / boutique aéroportuaire
- ~2 800 références (2 800 exactement en catalogue), **une image produit
  par référence sur 100 % du catalogue** (aucune référence sans
  `imageUrl`) et **une facing minimum par référence** sur le plan de
  rayon (cf. §5) — priorité donnée à la largeur d'assortiment plutôt qu'à
  la profondeur de stock, cohérent avec une surface très contrainte.
- Modificateurs de contexte (voir `store-profile.json`) :
  - Catégories boostées : Snacking et prêt-à-manger, Boissons, Presse et
    dépannage, Hygiène et beauté (×1.6 sur le poids de sélection)
  - Catégories réduites : Surgelés, Entretien et droguerie (×0.5)

## 2. Suppression du support "réserve"

La demande précise que la réserve ne sera pas utilisée. En conséquence :

- `scene.json.store.zones` ne contient plus que `entrance` et `exit`
  (plus de zone `reserve`, plus de cloison de séparation arrière).
- `ZoneTypeEnum` (`backend/models/project.py`) et `ZoneType`
  (`frontend/src/types/cad.ts`), qui avaient été étendus pour supporter
  `"reserve"`, sont revenus à `entrance | exit | supply` : ce type de zone
  n'étant utilisé nulle part ailleurs dans le repo, son support a été
  retiré intégralement (y compris la couleur associée dans
  `FloorPlanEditor`).

## 3. Mobilier : sélection et implantation

Mobilier repris tel quel de `backend/storage/furniture_library.json`
(aucune géométrie inventée) : `register`, `display`, `pallet`, `fridge`,
`fridge_horizontal`, `gondola_double`, `gondola_single`. 32 meubles au
total, choisis et dimensionnés pour maximiser le nombre de références
présentables en une seule facing par produit sur seulement 120 m² :

- **2 caisses** (`register`) entre l'entrée et la sortie.
- **1 présentoir presse** (`display`) + **1 palette promo snacking**
  (`pallet`, 4 faces) juste après les caisses : achat impulsif
  aéroport (catégories boostées Presse et Snacking).
- **5 frigos verticaux** (`fridge`) : crèmerie/fromages (×3) et
  traiteur/charcuterie (×2), zone grab-and-go proche de l'entrée.
- **3 allées de gondoles doubles** (`gondola_double`, 6 + 6 + 4 modules,
  faces avant/arrière) : épicerie salée/sucrée, boissons/vins, hygiène
  et beauté / entretien / puériculture / animalerie.
- **Un rayon mural** (`gondola_single` ×3) pour boulangerie/pâtisserie
  et fruits & légumes, plus **1 frigo horizontal** (`fridge_horizontal`)
  pour les surgelés (catégorie réduite).
- **3 têtes de gondole** (`gondola_single` pivotées à 90°, en bout de
  chaque allée, face tournée vers l'allée de circulation) : Snacking,
  Boissons et Hygiène — les 3 catégories boostées les plus fortes en
  trafic reçoivent une double exposition (produit déjà en rayon +
  facing promotionnel supplémentaire en tête de gondole, cf. §5).

Validation géométrique (même logique que
`backend/tests/test_reference_projects.py`) : **aucune collision**
(AABB avec rotation), **toutes les allées ≥ 100 cm**, zones entrée/sortie
entièrement dégagées, tous les meubles utilisent uniquement les faces
déclarées dans `furniture_library.json`.

## 4. Table de pricing et table de dimensions/poids

Mêmes tables que la version précédente du projet (aucune table de marge
ou de dimension pré-existante trouvée ailleurs dans le repo) :

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
`quantity` (borné 0.4–1.8). `priceSellEur` = arrondi commercial `,x9`
au-dessus de `priceBuyEur / (1 - marge/100)` ; `marginPct` est recalculé
après arrondi. Dimensions produit plafonnées à 40 cm (largeur/profondeur)
et 32 cm (hauteur) pour rester cohérentes avec la taille des rayons
d'une boutique de 120 m². Aucun produit n'a de prix, marge ou dimension à
0/null/vide.

## 5. Merchandising — un facing par référence, maximum d'images en rayon

Principe directeur : **chaque référence retenue dans `catalog.json`
obtient exactement une facing sur sa gondole d'affectation** (une seule
cellule de planogramme par `ean` dans le rayon principal), ce qui permet
de présenter le maximum de références différentes — donc le maximum
d'images produit visibles en rayon — sur une surface de vente très
contrainte, plutôt que de dupliquer un même produit sur plusieurs
facings comme dans un hypermarché classique.

- **Remplissage capacité-first** : pour chaque face de mobilier, les
  produits de la/les catégorie(s) affectée(s) sont empilés ligne par
  ligne (hauteur de niveau 32 cm) et remplis en largeur réelle
  (`widthCm`) jusqu'à saturation de la face — **zéro dépassement** :
  aucun produit sélectionné ne reste sans emplacement, donc aucune
  référence du catalogue n'est sans image affichée en rayon (vérifié :
  2 800 / 2 800 références placées).
- **Têtes de gondole (têtes de rayon)** : les 3 têtes de gondole (voir
  §3) reçoivent des facings supplémentaires dupliquant les meilleures
  références déjà présentes en rayon (Snacking, Boissons, Hygiène — les
  catégories boostées par le contexte aéroport), pour une double
  exposition sans ajouter de nouvelles références au catalogue (72
  facings promotionnels au total, cf. §6).
- **Adjacence** : snacking/presse près de l'entrée (achat impulsif),
  frigos crèmerie/traiteur en grab-and-go proche de l'entrée, épicerie
  salée/sucrée puis boissons/vins en allées centrales, hygiène/entretien/
  puériculture/animalerie en 3ᵉ allée, boulangerie/fruits & légumes/
  surgelés en fond de magasin.

## 6. Répartition finale par catégorie (catalog.json, 2 800 produits, dont
467 `isMdd: true`)

| Catégorie | Nombre de références |
|---|---|
| Épicerie salée | 631 |
| Boissons | 532 |
| Épicerie sucrée | 297 |
| Vins, bières et spiritueux | 279 |
| Hygiène et beauté | 266 |
| Snacking et prêt-à-manger | 203 |
| Crèmerie et fromages | 194 |
| Boucherie, charcuterie, traiteur | 91 |
| Entretien et droguerie | 62 |
| Animalerie | 62 |
| Boulangerie et pâtisserie | 60 |
| Fruits et légumes | 60 |
| Surgelés | 23 |
| Puériculture | 21 |
| Presse et dépannage | 19 |
| **Total** | **2 800** |

`planograms.json` contient 47 planogrammes (une entrée par face de
mobilier utilisée + 3 têtes de gondole) pour un total de 2 872 cellules
(2 800 facings « catalogue », une par référence, + 72 facings promo en
tête de gondole).

## 7. Champs additionnels de `catalog.json` (schéma étendu, non destructif)

| Champ | Type | Raison |
|---|---|---|
| `isMdd` | bool | Copié de `is_mdd` du pool ; pilote l'étagement. |
| `rotationIndice` | float (1–10) | Absent du pool ; estimé pour un usage futur de tri par performance. |

Aucun champ existant n'a été renommé ni supprimé dans `catalog.json`,
`materials.json` ou `planograms.json`. `materials.json` est repris
intégralement de la version précédente du projet (aucun ajout requis).

## 8. Limitations

Aucun mobilier ni matériau requis n'a été introuvable. Le nombre de
références par catégorie chilled (crèmerie, traiteur) est plafonné par
la capacité réelle des frigos posés plutôt que par la disponibilité du
pool ; les catégories réduites par le contexte (surgelés, entretien)
restent volontairement sous-remplies par rapport à leur capacité
disponible.
