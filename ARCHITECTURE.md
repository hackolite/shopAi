# Architecture & Stratégie — shopAi (Retail CAD)

## Vision du produit

**shopAi** est un outil SaaS professionnel de conception de magasins en 3D, surnommé « le Figma des planogrammes ». Il permet à des responsables de rayon ou des merchandisers de :

- modéliser un magasin entier en 3D (plan de vente, mobilier, zones),
- créer et éditer des **planogrammes** (disposition produits sur les étagères) de façon indépendante de la géométrie 3D,
- appliquer automatiquement ces planogrammes sur les faces du mobilier en temps réel.

---

## Stack technique

| Couche | Technologie | Rôle |
|--------|-------------|------|
| Backend | Python 3.11 + FastAPI | API REST, persistence JSON, logique métier |
| Frontend | React 19 + TypeScript + Vite | SPA, éditeur 3D, éditeur de planogrammes |
| 3D | Three.js via React Three Fiber (R3F) | Rendu 3D, gizmos, raycast / pick |
| État global | Zustand | Stores réactifs découpés par domaine |
| Validation | Pydantic v2 (back) / TypeScript strict (front) | Schémas partagés et cohérents |
| Tests | Vitest (front) | Tests unitaires du moteur d'ancrage |

---

## Structure du repo

```
shopAi/
├── backend/
│   ├── main.py                   # Entrée FastAPI, CORS, montage des routeurs
│   ├── api/                      # Routeurs REST (cad_projects, furniture_library, projects)
│   ├── models/project.py         # Modèles Pydantic (Store, FurnitureInstance, Planogram…)
│   ├── services/                 # Logique métier (project_manager, demo_generator…)
│   └── storage/projects/         # Persistence JSON par projet (scene, catalog, planograms…)
│
└── frontend/
    └── src/
        ├── types/cad.ts          # Types TypeScript (miroir des modèles Pydantic)
        ├── store/                # Zustand : uiStore, sceneStore, planogramStore, catalogStore…
        ├── api/cad.ts            # Client HTTP typé vers /api/cad/*
        ├── engine/               # Moteur de calcul pur (ancrage, gondoles)
        ├── three/SceneEditor.tsx # Canvas R3F : meshes, overlay planogramme, gizmo
        └── components/           # Toolbar, Inspector, SceneHierarchy, PlanogramEditor…
```

---

## Modèle de données

Toutes les coordonnées et dimensions sont stockées en **centimètres**. Le rendu Three.js divise par 100 (1 unit = 1 m) via la constante `CM_TO_UNIT`.

### Entités principales

```
Project (id)
  └── Scene
        ├── Store            (dimensions, murs, zones, couleurs)
        └── FurnitureInstance[]
              ├── position / rotation / dimensions  (en cm)
              └── faces: { front, back, left, right, top, bottom } → planogramId | null

Planogram (id)
  ├── rows × cols
  ├── widthCm / heightCm
  ├── colWidthsCm[] / rowHeightsCm[]   (largeurs/hauteurs par colonne/rangée)
  └── cells: PlanogramCell[]
        └── { ean, row, col, rotation }

Catalog
  └── Product[]  { ean, name, brand, category, widthCm, depthCm, heightCm }
```

**Relations clés :**
- Une `FurnitureInstance` référence jusqu'à 6 planogrammes (un par face).
- Un `Planogram` référence des produits uniquement par leur **EAN** (pas de doublon de données).
- La scène ne contient jamais de données produits directement.

---

## Architecture backend

### Persistence JSON par projet

Chaque projet est un dossier `storage/projects/{id}/` contenant des fichiers JSON indépendants (`scene.json`, `catalog.json`, `planograms.json`, `materials.json`, `settings.json`). Cette approche :

- est suffisante pour un MVP et des démos,
- est **drop-in compatible PostgreSQL** (les modèles Pydantic utilisent des UUIDs, aucun code SQL-spécifique).

### Initialisation automatique

Au démarrage, `demo_initializer.py` vérifie si le projet `retail_cad` existe et le génère via `demo_generator.py` s'il est absent (200 produits, 13 meubles, 22 planogrammes dans un magasin de 50 m × 30 m).

### Routeurs

| Routeur | Préfixe | Description |
|---------|---------|-------------|
| `cad_projects` | `/api/cad/projects/` | CRUD complet : scène, mobilier, catalogue, planogrammes, matériaux |
| `furniture_library` | `/api/furniture-library` | Bibliothèque des 9 types de mobilier paramétriques |
| `projects` | `/api/projects/` | Ancien viewer voxel (rétro-compatibilité) |

---

## Architecture frontend

### Découpage des stores Zustand

| Store | Responsabilité |
|-------|---------------|
| `sceneStore` | Données scène, sélection mobilier, historique (undo) |
| `planogramStore` | Planogramme actif, détails des cellules |
| `catalogStore` | Produits, recherche, favoris |
| `uiStore` | Outil actif, mode de vue (3D / split), visibilité des panneaux |
| `projectStore` | Liste des projets, projet courant |
| `zoneStore` | Zones d'entrée / sortie au sol |

Chaque store est indépendant et expose ses actions : les composants s'abonnent uniquement aux tranches dont ils ont besoin.

### Moteur d'ancrage (`engine/furnitureAnchor.ts`)

Quand une colonne est ajoutée ou supprimée dans un planogramme, la dimension du meuble change. Sans correction, le centre géométrique du meuble se déplace symétriquement et le contenu existant du planogramme « glisse ». Le moteur d'ancrage (`anchorFurniturePosition`) compense la position du meuble en fonction de :

- la **face** concernée (front/top ancrent sur le bord −X local ; back sur le bord +X ; left/right sur le bord −Z),
- la **rotation Y** du meuble (un meuble retourné à 180° inverse les bords monde).

Résultat : ajouter/supprimer une colonne ne déplace jamais le contenu existant en espace monde.

### Rendu 3D (`three/SceneEditor.tsx`)

- Chaque `FurnitureInstance` est rendu comme un `mesh` Three.js (box geometry).
- Une **overlay texture** (canvas 2D) est projetée sur chaque face avec un planogramme assigné, représentant la grille produits en couleurs de catégorie.
- La face `back` inverse la texture (`repeat.x = -1`) et l'UV du clic (`uvX = 1 - event.uv.x`) pour que la colonne 0 soit toujours à la même extrémité physique que la face avant.
- La caméra (position + cible OrbitControls) est persistée en mémoire et restaurée au remontage du Canvas, sans jamais déplacer la vue automatiquement lors du retour depuis l'éditeur de planogramme.

### Éditeur de planogramme (`components/PlanogramEditor/`)

- Grille 2D interactive : clic pour placer un produit (depuis le catalogue), clic droit pour effacer, drag-and-drop depuis le CatalogPanel.
- Ajout/suppression de colonnes et rangées avec ancrage physique correct.
- Une modification sur un planogramme n'affecte que ce planogramme et son meuble lié — jamais la face opposée.
- Auto-sauvegarde toutes les 500 ms.

---

## Principes architecturaux

1. **Data-first** : toutes les relations utilisent des UUIDs. Aucun objet n'embarque la donnée d'un autre.
2. **Planogrammes indépendants** : un planogramme n'est lié à un meuble que par référence (UUID). Il peut exister sans meuble.
3. **Pas de duplication** : le catalogue produits est la source de vérité ; les planogrammes ne stockent que l'EAN.
4. **Séparation moteur / UI** : les calculs d'ancrage et de géométrie gondole vivent dans `engine/` (fonctions pures, testées) sans dépendance React.
5. **Persistance neutre** : les fichiers JSON peuvent être remplacés par PostgreSQL sans changer les modèles ni l'API.

---

## Roadmap architecturale

Les modules suivants sont préparés dans l'architecture mais non encore implémentés :

| Module | Statut |
|--------|--------|
| Moteur analytique (heatmaps, trafic) | 🔲 Stub |
| Vision par ordinateur (conformité planogramme) | 🔲 Stub |
| Assistant LLM / RAG planogramme | 🔲 Stub |
| Intégration ventes / marges / stocks | 🔲 Stub |
| Migration PostgreSQL | 🔲 Prêt (UUID, pas de code SQL) |
| Export PDF / Excel | 🔲 Stub |
| Multi-utilisateurs / collaboration | 🔲 Stub |

La stratégie est donc de construire d'abord un **MVP solide et cohérent** (éditeur 3D + planogrammes + catalogue), avec une architecture suffisamment propre pour greffer ensuite les modules IA et analytiques sans refonte majeure.
