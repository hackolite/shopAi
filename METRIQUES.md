# Métriques

Référentiel des métriques de shopAi : ce qui est **calculé aujourd'hui**, ce qui
reste **à calculer**, et le rôle métier de chaque indicateur.

Toutes les métriques sont **brutes (non normalisées)** sauf mention explicite :
elles conservent leur unité physique, afin que deux projets, deux meubles ou deux
runs de simulation puissent être comparés en valeur absolue.

> Ce document est la version française et autonome de la section *Metrics* du
> [README](README.md). Il fait foi pour la définition et le rôle des indicateurs.

---

## 1. Métriques calculées

### 1.1 Assortiment / implantation

Source : `frontend/src/engine/assortmentMetrics.ts`.
Affichage : **Inspector**, par meuble (section *Implantation*) et pour le projet
entier (panneau bas quand rien n'est sélectionné).

| Métrique | Définition | Unité | Rôle |
|----------|-----------|-------|------|
| **Produits différents** | Nombre d'**EAN distincts** portés par le périmètre sélectionné. Une référence présente en 5 facings compte pour 1. | références | Mesure la **largeur** de l'offre proposée au client. |
| **Facings implantés** | Nombre total de cellules de planogramme, c'est-à-dire de fronts produits physiquement visibles. | facings | Mesure le **linéaire occupé**, indépendamment du nombre de références. |
| **Facings / produit** | `facings / produits différents` — profondeur moyenne d'exposition d'une référence. | facings/réf | Arbitre largeur vs profondeur : ≈ 1 = assortiment très large et peu profond (proximité) ; > 2 = assortiment de masse. |
| **Planogrammes remplis** | `planogrammes remplis / planogrammes` — un planogramme est « rempli » dès qu'il porte au moins un facing. | nb / nb | Détecte les faces de meuble laissées vides. |
| **Couverture catalogue** | `produits différents / taille du catalogue` | % | Part du catalogue effectivement implantée en magasin ; une couverture < 100 % signale des références non exposées. |

Valeurs actuelles des projets de référence (recalculées depuis
`backend/storage/projects/*/planograms.json`) :

| Projet | Catalogue | Planogrammes | Facings | Réf. distinctes | Facings / réf | Couverture |
|--------|----------:|-------------:|--------:|----------------:|--------------:|-----------:|
| `carrefour_express_aeroport` | 2 800 | 52 | 3 818 | 2 800 | 1,4 | 100 % |
| `carrefour_express` | 2 964 | 46 | 2 964 | 2 964 | 1,0 | 100 % |
| `carrefour_city` | 5 000 | 306 | 15 300 | 5 000 | 3,1 | 100 % |
| `retail_cad` (démo) | 200 | 50 | 1 324 | 200 | 6,6 | 100 % |
| `demo` | 5 000 | 306 | 15 300 | 1 250 | 12,2 | 25 % |

### 1.2 Marge produit

La marge est un **attribut produit du catalogue** : toute métrique en € en
découle, rien n'est codé en dur dans les moteurs.

| Champ (`CADProduct` / `Product` backend) | Signification |
|------------------------------------------|---------------|
| `priceBuyEur` | Prix d'achat (€ HT), optionnel |
| `priceSellEur` | Prix de vente (€ TTC), optionnel |
| `marginPct` | Taux de marque (%), optionnel |

`engine/marginHeatmap.ts` → `productMarginEur()` calcule la marge unitaire d'un
facing dans cet ordre de repli :

1. `priceSellEur − priceBuyEur` quand les deux prix sont connus (borné à ≥ 0) ;
2. sinon `priceSellEur × marginPct / 100` ;
3. sinon **0 €** — un produit sans prix ne contribue à rien, il ne casse jamais
   la métrique.

> Conséquence : la marge exposée au sol est une **marge de facing** (marge
> unitaire × nombre de facings), c'est-à-dire les € qu'un client peut voir — pas
> une marge réalisée : il n'existe pas encore de flux de ventes ni de stock.

### 1.3 Simulation — par waypoint

Source : `WaypointMetrics` (backend `services/simulation.py`).

| Métrique | Définition | Unité | Rôle |
|----------|-----------|-------|------|
| `releasedAgents` | Nombre cumulé d'agents ayant **traversé** le waypoint. Comptabilisé par `WaypointPassageTracker`, qui crédite un waypoint dès qu'un agent cesse de le viser : renseigné pour `entry`, `transit` **et** `exit`, pas seulement pour les files d'attente. | agents | Volume de passage d'un point de la circulation. |
| **Débit** (`engine/waypointThroughput.ts`) | `Δ releasedAgents / Δt` entre deux échantillons, plus valeur courante et pic sur la fenêtre. | agents/s | Capacité écoulée d'une caisse ou d'un passage ; base du dimensionnement. |
| `maxActiveAgents` | Occupation simultanée maximale du waypoint. | agents | Pic de charge, dimensionnement de la zone. |
| `queuedAgents` / `completedWaits` | Agents entrés dans / sortis de la file d'un waypoint de rétention. | agents | Volume traité par une file d'attente. |
| `averageWaitSeconds`, `maxWaitSeconds`, `currentMaxWaitSeconds` | Temps d'attente en file : moyen, pic historique, pic instantané. | s | Qualité de service perçue en caisse. |

Niveau run (`SimulationSummary`) : `spawnedCustomers`, `completedCustomers`,
`activeCustomers`, `averageWaypointLoad`, `maxWaypointLoad`,
`averageConfiguredRetentionSeconds`.

### 1.4 Simulation — grilles au sol

`SimulationAnalytics`, interrogées chaque seconde tant qu'un overlay est actif.

| Grille | Définition | Unité | Rôle |
|--------|-----------|-------|------|
| `heatmap` | **Échantillons d'agents** cumulés par cellule — proxy du temps de présence (un agent immobile continue d'accumuler des échantillons). | échantillons | Localise les zones de stationnement. |
| `visitHeatmap` | **Entrées d'agents** cumulées par cellule (un comptage par entrée, quelle que soit la durée). Divisée par `timeSeconds`, elle donne un flux absolu. | pers/s | Localise les zones de passage ; base de toute métrique de flux. |
| `marginHeatmap` (`engine/marginHeatmap.ts`) | Côté client : chaque colonne de planogramme rayonne sa marge de facing cumulée sur la tranche d'allée devant elle, sur `MARGIN_INFLUENCE_CM` = 100 cm, grille de 50 cm (`MARGIN_HEATMAP_CELL_CM`, plafond 120 cellules/axe). Aucune session en cours nécessaire. | € | Cartographie la valeur exposée au sol, indépendamment du trafic. |
| `yieldHeatmap` (`engine/yieldHeatmap.ts`) | Indice **normalisé** marge × trafic (`marge/margeMax × trafic/traficMax`), pour la coloration relative uniquement. | 0–1 | Comparaison relative des zones **à l'intérieur** d'un magasin. |
| `absoluteYield` (`engine/absoluteYield.ts`) | Marge × trafic bruts : € exposés par facing × pers/s, sommés sur la grille de **visites**. **Ne jamais normaliser.** Expose `totalEurPerSecond`, `maxCellEurPerSecond`, `productiveCells`, `exposedFlowPerSecond`, `exposedMarginEur`. | €/s | Comparaison absolue de deux implantations ou d'un avant/après. |

### 1.5 Où les métriques sont affichées

| Surface | Métriques affichées |
|---------|---------------------|
| **Inspector** (meuble sélectionné) | *Implantation* : produits différents, facings, facings/produit ; pour la cellule sélectionnée : prix d'achat, prix de vente, marge unitaire (€ et %) |
| **Inspector** (rien de sélectionné) | Idem au niveau projet + planogrammes remplis + couverture catalogue |
| **SimulationPanel** | Nombre d'agents en direct, temps d'attente par waypoint, sélecteur d'intensité de la heatmap sol (`traffic`, `margin`, `yield` — `simulationStore.heatmapMode`) |
| **CheckoutChartsOverlay** | Rendement absolu (€/s : courant, cellule pic, marge exposée) + débit par waypoint (ag/s) |

---

## 2. Métriques à calculer (non implémentées)

| Métrique | Définition | Rôle |
|----------|-----------|------|
| **Linéaire développé** | Σ (largeur de rangée × nombre de niveaux) par meuble / catégorie, en mètres. | Unité de référence du category management ; rend possible la *part de linéaire*. |
| **Part de linéaire par catégorie** | Linéaire catégorie / linéaire total, comparé à sa part de marge ou de ventes. | Détecte les catégories sur- et sous-dotées en espace (space-to-sales index). |
| **Densité de marge au mètre linéaire** | Σ marge de facing / mètres linéaires de la face. | Classe les meubles par rentabilité de l'espace occupé, et non par ventes. |
| **GMROS** (marge au m² de sol) | Marge cumulée / emprise au sol du meuble (largeur × profondeur). | Arbitre entre une gondole et une île pour une même surface au sol. |
| **Indice d'accessibilité / hauteur de prise** | Part des facings situés dans la zone de préhension 80–140 cm, pondérée par l'indice de rotation. | Vérifie que les best-sellers sont bien à hauteur d'yeux / de main. |
| **Taux de conversion trafic → marge** | Rendement absolu (€/s) / flux local (pers/s) devant la face. | Isole les faces à fort trafic mais faible monétisation. |
| **Temps d'exposition par meuble** | Temps de présence cumulé (issu de `heatmap`) des cellules faisant face au meuble. | Transforme le temps de présence en KPI par meuble plutôt que par cellule. |
| **Taux de rupture simulé** | Facings dont le stock (facing × capacité en profondeur) est épuisé avant la fin du run, compte tenu de l'indice de rotation. | Anticipe la fréquence de réassort par étagère. |
| **Duplication d'assortiment** | Part des références présentes sur plusieurs faces du même rayon. | Mesure la cannibalisation du linéaire par les doublons. |
| **Indice de congestion** | Part du temps où la densité locale dépasse un seuil de confort (pers/m²). | Localise les goulots invisibles sur une heatmap cumulative. |

---

## 3. Politique d'assortiment (contexte des métriques)

La politique qui décide **quelles références sont portées et combien de facings
chacune reçoit** est stockée avec le projet, pas dans le code : elle est décrite
dans `store-profile.json` et auditée dans `validation-report.md`
(`backend/storage/projects/carrefour_express_aeroport/`).

| Règle | Contenu |
|-------|---------|
| **Largeur avant profondeur** | Sur une surface contrainte, chaque référence du catalogue reçoit **exactement un facing** sur son meuble d'affectation ; une référence n'est dupliquée que sur les têtes de gondole. `facings / réf` reste proche de 1 et la couverture à 100 %. |
| **Aucune référence sans facing** | Tout le catalogue doit être implanté (2 800 / 2 800 pour le projet aéroport) — une référence non placée signifie un assortiment surdimensionné pour le magasin. |
| **Aucun emplacement vide** | Une rangée est remplie à la largeur réelle du linéaire (`widthCm` par facing) puis raccourcie via `rowColCounts` ; les trous sont comblés d'abord par de nouvelles références, puis par des facings supplémentaires des meilleures rotations. Vérifié par `test_planograms_have_no_empty_slot`. |
| **Modificateurs de contexte** | `store-profile.json` amplifie (×1,6) ou réduit (×0,5) le poids de sélection des catégories selon le contexte (aéroport : Snacking, Boissons, Presse, Hygiène amplifiés ; Surgelés et Entretien réduits). |
| **Duplication en tête de gondole** | Les têtes de gondole ne portent que des références déjà présentes en allée, triées par `rotationIndice` décroissant, sur une grille pleine — exposition supplémentaire, pas de référence supplémentaire. |
| **Adjacence** | Catégories d'impulsion (snacking, presse) près de l'entrée, frais à emporter à côté, épicerie puis boissons en allées centrales, non-alimentaire au fond. |
| **Anti-duplication** | Une référence n'est pas répétée sur deux faces du même meuble tant qu'une autre référence de la catégorie peut prendre la place. |

`assortment.json` à la racine du dépôt est le **vivier brut en lecture seule**
(4 807 produits avec code-barres, marque, `is_mdd`, prix, catégorie) dans lequel
les catalogues de projet sont tirés. Il n'est jamais modifié par l'application.
