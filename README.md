# Retail CAD — AI-Native Planogram & Digital Twin Builder

**The Figma of Planograms.** A professional SaaS tool for designing retail stores in 3D, editing planograms independently of geometry, running customer flow simulations, and automatically applying them to store furniture.

---

## Workspace and studio assistant

La page d'accueil sépare **Projects**, **Implantations**, **Catalogues**,
**Simulations** et **Configuration**. Chaque workspace reçoit des projets
Carrefour de référence, des variantes layout-only, et un **catalogue
Assortiment Carrefour** persistant. Le provisioning est idempotent : rouvrir le
dashboard ne réécrit pas vos ressources.

### Règle produit : où gérer les catalogues ?

- **Import JSON catalogue : workspace uniquement** (`Catalogues`).
- **Choix du catalogue : au moment de créer le projet** (`Projects`).
- **Dans la vue 3D : plus d'import ni de changement de catalogue** ; le panneau
  catalogue sert uniquement à consulter, rechercher, sélectionner et illustrer
  les produits du projet courant.

Flux recommandé :

1. Importer le JSON assortiment dans `Catalogues`.
2. Créer un projet et choisir éventuellement une implantation, un catalogue et
   un dataset piéton/panier.
3. Ouvrir le studio 3D pour travailler l'implantation et les planogrammes du
   projet créé.

### Import OSM dans le workspace

Dans `Workspace > Implantations > Importer une implantation (OSM XML)`, l'option
**Réduction agressive des polygones OSM** simplifie plus fortement les contours
fermés importés. Elle sert à réduire le nombre de sommets quand la priorité est
la performance plutôt que la fidélité exacte du contour.

Pourquoi c'est important :

- une géométrie OSM dense coûte plus cher à importer et à stocker ;
- plus de sommets augmentent le coût de triangulation et d'affichage ;
- la compilation des obstacles de navigation et les mises à jour de simulation
  deviennent plus lourdes ;
- les zones très détaillées génèrent plus de travail pour les diagnostics
  `Chemin navigable`.

En pratique : laissez l'option désactivée pour conserver des contours plus
fidèles, et activez-la pour des imports massifs ou des fonds OSM très détaillés
où un contour plus grossier reste acceptable.

### Assistant intégré du studio

Dans le studio 3D, le panneau **Assistant** reste un assistant local,
déterministe, basé sur des modèles Carrefour. Il sait créer une implantation
complète, une implantation seule, sauvegarder et auditer un projet enregistré.
Il **n'est pas** un LLM connecté et n'exécute pas de consignes libres.

### Agent externe : préfixes de demandes recommandés

Pour des demandes riches et pilotées par agent, utilisez l'onglet
**Configuration** avec ces préfixes :

- `Créer implantation:` créer une implantation à partir d'un besoin décrit.
- `Modifier implantation:` changer grille, dimensions, mobilier, circulation.
- `Créer assortiment:` placer les produits en rayon selon des règles
  merchandising.
- `Modifier assortiment:` retoucher les facings et règles sans refaire le
  layout.
- `Projet complet:` enchaîner implantation + assortiment avec le catalogue du
  projet déjà fourni.

Exemples :

- `Modifier implantation: passe la grille à 50 cm et ajoute 2 têtes de gondole en entrée.`
- `Créer assortiment: utilise le catalogue du projet, priorise la marge et garde les frais sur les meubles froids.`
- `Projet complet: à partir du catalogue du projet, crée une supérette urbaine orientée dépannage du soir.`

### Comment connecter un provider API à un agent

Pour une version synthétique du parcours IA complet (assistant local, webhook
LLM et pilote Astra), voir [`AI_WORKFLOW_README.md`](AI_WORKFLOW_README.md).

1. Activez votre provider d'authentification dans le workspace si vous voulez un
   vrai parcours utilisateur : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REDIRECT_URI`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `GITHUB_REDIRECT_URI`.
2. Donnez à votre orchestrateur agent l'URL OpenAPI exposée par ShopAI :
   `/openapi.json`.
3. Laissez l'agent appeler l'API REST du produit avec le cookie de session du
   workspace.
4. Gardez vos clés LLM/provider **hors du dépôt**, via variables d'environnement
   ou secret manager.

### Créer ou modifier un projet via UI (client) uniquement

Objectif : permettre à l'utilisateur final de **créer** ou **modifier** son
projet depuis l'interface, sans exécuter de script local.

Parcours UI :

1. Ouvrir un projet dans le studio 3D.
2. Aller dans le panneau **Assistant**.
3. Choisir une catégorie obligatoire (implantation / assortiment / freestyle).
4. (Optionnel) Activer la case **Utiliser l’agent LLM externe configuré côté serveur**.
5. Envoyer la demande puis confirmer l'action si demandé.

Résultat :

- En mode assistant local : traitement déterministe interne (`/assistant`).
- En mode agent LLM externe : prompt relayé au webhook serveur (`/assistant/llm`).
- Si l'agent crée/modifie un projet, le projet est rechargé côté client.

Ce que doit faire le développeur pour que ce flux UI soit possible :

1. Configurer le backend avec `STUDIO_LLM_WEBHOOK_URL` (obligatoire pour le mode LLM).
2. Démarrer l'orchestrateur et configurer uniquement son fournisseur et sa clé API
   pour utiliser un LLM. **Aucun secret partagé à créer ou à copier entre services.**
   Le backend transmet automatiquement la session dans `X-ShopAI-Session`.
   Les callbacks vérifient sa validité/expiration en base et l'accès au projet/tenant
   avant tout appel payant au fournisseur. Une session invalide est refusée,
   jamais traitée comme une création anonyme.
   Ajuster si nécessaire `STUDIO_LLM_WEBHOOK_TIMEOUT_SECONDS`.
3. Implémenter un webhook orchestrateur qui reçoit :
   `{"projectId","prompt","confirm","category","confirmationToken"}`.
   Les deux derniers champs sont optionnels pour les webhooks historiques ;
   l'orchestrateur fourni exige le jeton de l'aperçu pour confirmer une écriture.
4. Faire appeler à l'orchestrateur l'API ShopAI (`/openapi.json`, `/api/cad/projects/...`)
   avec la session utilisateur transmise.
5. Retourner au frontend le contrat JSON attendu :
   `message`, `requiresConfirmation`, `changed`, `projectId`, `steps`,
   et `confirmationToken` pour confirmer l'aperçu exact.
6. Ne jamais exposer de clé provider dans le client ni dans le dépôt.

Le backend vérifie l'accès au projet retourné et audite les écritures annoncées.
Un audit en échec remplace le message de succès par un avertissement explicite ;
il ne constitue pas un rollback. `changed` indique des écritures, pas leur validité.

Pour le lancement le plus simple sous **PowerShell**, voir les
[deux commandes de démarrage des services](orchestrator/README.md#lancement-simple-sous-powershell).
Les logs INFO Uvicorn affichent étapes, fournisseur, statuts et durées, sans prompts,
sessions, clés API ni jetons de confirmation. Les erreurs 401/403/503 donnent une
explication sûre et une piste de diagnostic, jamais le corps brut d'une réponse amont.

#### Diagnostic Windows et projets refusés (403)

Les anciens dossiers `storage/projects/carrefour_*` contiennent des liens vers
`storage/templates`. Sous Windows, Git peut les matérialiser en fichiers texte
contenant `../../templates/.../project.json` (43, 46 ou 55 caractères), et non du
JSON. Ces modèles ne sont plus parcourus comme projets utilisateur : les copies
tenant sont créées depuis les vrais JSON de `storage/templates`, sans exiger
le support des liens symboliques Windows. Les fichiers UTF-8 avec BOM sont acceptés
et les sauvegardes JSON remplacent atomiquement un fichier complet.

Un 403 sur un UUID signifie que le compte connecté ne possède pas ce projet.
Les anciennes créations par un orchestrateur sans session reconnue peuvent être
restées sans rattachement. Le correctif sécurise les **nouvelles** créations, mais
ne revendique pas automatiquement les projets existants : sauvegarder le stockage
et `_platform.sqlite3`, puis faire vérifier leur propriétaire par l'administrateur
avant toute récupération. Ne pas supprimer la base ni désactiver les contrôles
d'accès. Le GET des piétons applique désormais le même contrôle de tenant.

Exemple de providers avec offre gratuite de test (selon quotas en vigueur) :

- **Groq** (API avec free tier)
- **Google AI Studio / Gemini API** (quota gratuit)
- **OpenRouter** (certains modèles gratuits ou à faible coût)

### Exemple pédagogique — assortiment avec layout déjà fourni

Cas d'usage : le layout existe déjà, vous voulez seulement remplir les rayons.

1. Enregistrez ou importez d'abord le layout dans `Implantations`.
2. Importez le catalogue fournisseur dans `Catalogues`.
3. Créez un projet en sélectionnant ce layout et ce catalogue.
4. Envoyez ensuite une demande agent du type :
   `Créer assortiment: le layout est déjà fourni, utilise le catalogue du projet, mets les promotions en tête de gondole, garde les produits frais près des frigos et limite les doublons.`
5. L'agent peut alors se concentrer sur les règles d'assortiment, sans redéfinir
   la géométrie du magasin.

**Enregistrer** / **Ctrl+S** persiste la scène, les zones et la configuration
de simulation. **Enregistrer sous…** sauvegarde avant duplication.
**Exporter…** télécharge une archive projet ou un retail layout. Les
implantations, catalogues, simulations et datasets du workspace sont
téléchargeables depuis leurs cartes respectives. Dans la simulation 3D, les
flux piétons proviennent uniquement des datasets du workspace.

## Architecture

```
shopAi/
├── backend/                          # FastAPI (Python 3.11+)
│   ├── main.py                       # Entry point, CORS, routers, demo init
│   ├── models/
│   │   └── project.py                # Pydantic v2 models for all entities
│   ├── api/
│   │   ├── cad_projects.py           # CAD CRUD + simulation session endpoints
│   │   ├── furniture_library.py      # Furniture library (/api/furniture-library)
│   │   └── projects.py               # Legacy voxel viewer endpoints (backward compat)
│   ├── services/
│   │   ├── project_manager.py        # Secure JSON file I/O for CAD projects
│   │   ├── demo_generator.py         # Demo data: 200 products, 13 furniture, 22 planograms
│   │   ├── demo_initializer.py       # Auto-seeds retail_cad project on startup
│   │   ├── planogram_loader.py       # Legacy JSON I/O + EAN index
│   │   ├── voxel_generator.py        # Converts planogram → 3D voxel descriptors
│   │   ├── ean_search.py             # EAN lookup + analytics
│   │   ├── simulation.py             # Batch simulation engine (waypoints, pathfinding, heatmaps)
│   │   ├── live_simulation.py        # Live real-time simulation sessions (start/tick/pause/resume/stop)
│   │   ├── flow_analytics.py         # Occupancy heatmap + agent trajectories recorder
│   │   ├── gondola_adapter.py        # Converts gondola geometry for simulation obstacles
│   │   └── retail_layout.py          # Retail-specific layout helpers
│   ├── storage/
│   │   ├── furniture_library.json    # 9 parametric furniture types
│   │   └── projects/
│   │       ├── retail_cad/           # CAD demo (50m × 30m store)
│   │       │   ├── project.json      # Metadata
│   │       │   ├── scene.json        # Store + 13 furniture instances
│   │       │   ├── catalog.json      # 200 products (6 categories)
│   │       │   ├── planograms.json   # 22 planograms with cells
│   │       │   ├── materials.json    # 8 materials
│   │       │   └── settings.json     # Grid/snap settings
│   │       └── demo_store/           # Legacy voxel viewer demo
│   ├── tests/
│   │   ├── test_simulation_api.py    # Simulation + live simulation API tests
│   │   ├── test_scene_concurrency.py # Concurrent scene write tests
│   │   └── test_retail_layout.py     # Retail layout helper tests
│   └── requirements.txt
│
└── frontend/                         # React 19 + Vite + TypeScript
    └── src/
        ├── constants.ts              # CM_TO_UNIT scale factor
        ├── types/
        │   ├── cad.ts                # Full type system (FurnitureInstance, Planogram…)
        │   └── index.ts              # Legacy types + re-exports
        ├── store/                    # Zustand state stores
        │   ├── uiStore.ts            # Active tool, view mode, panel visibility
        │   ├── sceneStore.ts         # Scene data, furniture selection, hierarchy
        │   ├── planogramStore.ts     # Active planogram, cell selection
        │   ├── catalogStore.ts       # Products, search, favorites
        │   ├── projectStore.ts       # Project list, current project
        │   ├── simulationStore.ts    # Simulation config, waypoints, live session state
        │   └── zoneStore.ts          # Zone (heatmap area) definitions
        ├── engine/                   # Pure business-logic modules (tested with Vitest)
        │   ├── gondola.ts / .test.ts           # Gondola shelf geometry engine
        │   ├── furnitureAnchor.ts / .test.ts   # Furniture snap & anchor logic
        │   ├── simulationPlayback.ts / .test.ts # Agent playback interpolation
        │   ├── simulationConstraint.ts / .test.ts # Waypoint placement validation
        │   └── recording.ts / .test.ts         # Canvas stream video recording
        ├── api/
        │   ├── cad.ts                # Typed client for /api/cad/* endpoints
        │   └── index.ts              # Legacy API client
        ├── three/
        │   ├── SceneEditor.tsx       # R3F canvas: furniture meshes, floor, gizmo, measure tool
        │   ├── SimulationLayer.tsx   # R3F overlay: agent instanced rendering, heatmap
        │   ├── StoreScene.tsx        # Scene root & lighting
        │   ├── Shelf.tsx             # Individual shelf mesh
        │   └── ProductBlock.tsx      # Product block mesh for 3D planogram preview
        └── components/
            ├── Toolbar/              # Top bar: tool picker, view toggle
            ├── Header/               # App header + project switcher
            ├── SceneHierarchy/       # Unity/Blender-style tree, visibility toggles
            ├── CatalogPanel/         # Product browser with search + drag-and-drop
            ├── Inspector/            # Properties panel (position, dims, rotation, faces)
            ├── PlanogramEditor/      # 2D grid editor: click/drag to place products
            ├── SimulationPanel/      # Simulation config, waypoint editor, live controls
            ├── FloorPlanEditor/      # 2D top-down floor plan editor
            ├── ExportDialog/         # Scene / planogram export wizard
            ├── ImportDialog/         # Scene / catalog import wizard
            ├── CheckoutChartsOverlay/# Real-time charts overlay (checkout throughput)
            ├── StoreViewer/          # Read-only 3D store preview
            ├── SidePanel/            # Collapsible side panel shell
            ├── SearchBar/            # Global search bar
            ├── ProductInfo/          # Product detail popup
            ├── NameDialog/           # Generic name-input dialog
            └── ErrorBoundary/        # React error boundary
```

---

## Data Model

### CAD Project Files

| File | Contents |
|------|----------|
| `project.json` | `{ id, name, createdAt, updatedAt }` |
| `scene.json` | Store config + furniture instances (position/rotation/dimensions in cm) |
| `catalog.json` | 200 products with EAN, name, brand, category, dimensions |
| `planograms.json` | Planogram grids (rows × cols) with `PlanogramCell[]` per face |
| `materials.json` | Material library (wood, metal, glass, plastic, solid colour) |
| `settings.json` | Grid size, snap settings |

**Scale:** 1 Three.js unit = 100 cm (all data stored in cm)

### Furniture Types (Furniture Library)

Toutes les dimensions sont en **centimètres** (`largeur × profondeur × hauteur`).

| Type | Nom | Dimensions par défaut | Faces avec planogramme |
|------|-----|-----------------------|------------------------|
| `gondola_single` | Gondole simple | 120 × 60 × 200 cm | `front` |
| `gondola_double` | Gondole double face | 120 × 80 × 200 cm | `front`, `back`, `left`, `right` |
| `end_gondola` | Tête de gondole | 80 × 60 × 180 cm | `front`, `back`, `left`, `right` |
| `pallet` | Palette | 120 × 80 × 20 cm | `front`, `back`, `left`, `right` |
| `fridge` | Frigo vertical | 100 × 80 × 210 cm | `front` |
| `fridge_horizontal` | Frigo horizontal | 300 × 300 × 100 cm | `top` |
| `display` | Présentoir | 60 × 40 × 180 cm | `front` |
| `register` | Caisse | 80 × 60 × 90 cm | _(aucune)_ |
| `wall` | Mur | 500 × 20 × 300 cm | `front` |
| `partition` | Cloison | 200 × 10 × 200 cm | `front`, `back` |

### Category Colours

| Category | Colour |
|----------|--------|
| Épicerie | Amber `#F5C518` |
| Boissons | Blue `#2196F3` |
| Frais | Green `#4CAF50` |
| Hygiène | Purple `#9C27B0` |
| Bébé | Orange `#FF9800` |
| Promotion | Red `#F44336` |

---

## API Reference

### CAD Endpoints (`/api/cad/projects/`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List CAD projects |
| POST | `/` | Create new project `{ name }` |
| GET | `/{id}` | Project metadata |
| DELETE | `/{id}` | Delete project |
| GET | `/{id}/scene` | Scene: store + furniture |
| PUT | `/{id}/scene/store` | Update store config |
| POST | `/{id}/scene/furniture` | Add furniture instance |
| PUT | `/{id}/scene/furniture/{fid}` | Update furniture (position, dims, etc.) |
| DELETE | `/{id}/scene/furniture/{fid}` | Delete furniture |
| GET | `/{id}/catalog` | All products |
| GET | `/{id}/catalog/search?q=` | Search products (name/brand/category/EAN) |
| POST | `/{id}/catalog/products` | Add product |
| PUT | `/{id}/catalog/products/{ean}` | Update product |
| DELETE | `/{id}/catalog/products/{ean}` | Delete product |
| POST | `/{id}/catalog/import` | **Import catalog from JSON** for automation/agent workflows |
| GET | `/{id}/planograms` | List planograms (summaries) |
| POST | `/{id}/planograms` | Create planogram |
| GET | `/{id}/planograms/{pid}` | Full planogram with cells |
| PUT | `/{id}/planograms/{pid}` | Update planogram (cells, metadata) |
| DELETE | `/{id}/planograms/{pid}` | Delete planogram |
| GET | `/{id}/materials` | Materials library |
| POST | `/{id}/materials` | Add material |
| PUT | `/{id}/settings` | Update settings |

### Furniture Library (`/api/furniture-library`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | All furniture definitions |
| GET | `/{type}` | Single furniture definition |

### Legacy Viewer (`/api/projects/`)
Original voxel viewer endpoints remain fully functional for the `demo_store` project.

Interactive docs: **http://localhost:8000/docs**

---

## Catalog JSON Import Format

Les imports de catalogue se font dans le **workspace** via l'onglet
`Catalogues` ou l'endpoint `POST /api/platform/catalogs/import-json`.
Le JSON accepté peut prendre deux formes :

### Shape 1 — bare array

```json
[
  {
    "ean": "3760000000001",
    "name": "Pâtes penne bio 500g",
    "brand": "Barilla",
    "category": "Épicerie",
    "widthCm": 11.0,
    "depthCm": 6.0,
    "heightCm": 22.0,
    "weightG": 500.0,
    "imageUrl": null
  }
]
```

### Shape 2 — `{ products: [...] }` wrapper

```json
{
  "products": [
    {
      "ean": "3760000000001",
      "name": "Pâtes penne bio 500g",
      "brand": "Barilla",
      "category": "Épicerie",
      "widthCm": 11.0,
      "depthCm": 6.0,
      "heightCm": 22.0,
      "weightG": 500.0,
      "imageUrl": null
    }
  ]
}
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ean` | string | ✅ | EAN barcode (unique identifier) |
| `name` | string | ✅ | Product name |
| `brand` | string | ✅ | Brand / manufacturer |
| `category` | string | ✅ | Category — should match one of: `Épicerie`, `Boissons`, `Frais`, `Hygiène`, `Bébé`, `Promotion` |
| `widthCm` | number | ✅ | Product width in **cm** |
| `depthCm` | number | ✅ | Product depth in **cm** |
| `heightCm` | number | ✅ | Product height in **cm** |
| `weightG` | number | ✅ | Product weight in **grams** |
| `imageUrl` | string \| null | optional | URL or `data:` URI for the product thumbnail |

> **Note:** le flux produit recommandé est : importer dans le workspace, créer
> un projet avec ce catalogue, puis travailler dans le studio 3D. L'endpoint
> `POST /api/cad/projects/{id}/catalog/import` reste disponible pour
> l'automatisation pilotée par agent.

---

---

## Simulation Module

The simulation is driven from the **Simulation flux piétons** panel in the 3D studio.
It combines:

- a frontend **scenario editor** (`SimulationPanel`, `simulationStore`);
- backend-computed **walkable geometry** (`walkable_partition.py`);
- a **JuPedSim** pedestrian engine with two routing modes (`FlowField` or `A*`);
- cumulative **analytics** (heatmap, visits, trajectories, baskets) for analysis.

### End-to-end flow

1. The user opens a 3D project and configures the simulation in the right panel.
2. They place **entries**, **waypoints**, and **exits** on the 3D floor.
3. The backend rebuilds the walkable area from the store shell, furniture, and forbidden zones.
4. On launch, the frontend starts a live session and advances it in 100 ms ticks.
5. Overlays (heatmap, trajectories, walkable-path preview, yield) update without reloading the project.

### Two pedestrian input modes

| Mode | Pedestrian source | Usage |
|------|-------------------|-------|
| **Autonomous JuPedSim** | `arrivalRatePerSecond`, `desiredSpeedMps`, `speedVariation`, `randomSeed` | Synthetic traffic to test the store's overall circulation |
| **Pedestrian + basket dataset** | Workspace dataset copied into `pedestrians.json`, then injected into the live session | Replay a planned scenario with entry times, speed, and basket items per pedestrian |

Important:

- there is **no** separate “enable dataset” toggle; selecting a dataset in the panel applies it to the project immediately;
- when a dataset is active, the JuPedSim controls stay visible but are **ignored** for pedestrian spawning;
- pedestrian flows in the 3D studio come only from **workspace datasets**.

### Project-persisted configuration

The configuration is stored in `settings.json` through `ProjectSettings.simulation`.

| Field | Role |
|-------|------|
| `enabled` | Enables/disables simulation |
| `arrivalRatePerSecond` | Poisson arrival rate used only in autonomous JuPedSim mode |
| `durationSeconds` | Batch/offline simulation duration |
| `maxCustomers` | Maximum number of active or planned agents |
| `randomSeed` | Deterministic seed for arrivals and speed generation |
| `desiredSpeedMps` | Target average speed |
| `speedVariation` | Variation around the target speed |
| `pedestrianSimulationTechnology` | `jupedsim-flow` (FlowField) or `jupedsim-astar` |
| `precomputeEntryExitRoutes` | Precomputes entry/exit routes for repeated journeys |
| `waypointSystems[]` | Independent JuPedSim waypoint systems editable in the UI |
| `activeWaypointSystemId` | Currently displayed/edited waypoint system |

At runtime, **all** `waypointSystems` are flattened into `config.waypoints` before live start/update, so the simulation executes the full configured set, not only the system currently shown in the panel.

### Waypoint systems and waypoint types

Each JuPedSim system has its own label, color, and waypoint list. The UI lets you create several systems (`+ JuPedSim`) and switch the active one without losing the others.

| Type | Role | Relevant fields |
|------|------|-----------------|
| `entry` | Agent spawn point | `x`, `z`, `radiusCm`, `visionAngleDeg`, `visionRangeCm` |
| `transit` | Intermediate point; can become a retention / queue point | `optional`, `visitProbability`, `retentionSeconds` |
| `exit` | Exit-approach point followed by effective removal from the simulation | `radiusCm` defines the disappearance zone |

Placement rules:

| Type | Constraint |
|------|------------|
| `entry` | Centre must stay at least `AGENT_RADIUS_CM` away from obstacles |
| `transit` | Centre must stay inside the walkable area |
| `exit` | Centre must stay at least `radiusCm + AGENT_RADIUS_CM` away from obstacles |

Routing behaviour:

- non-optional `transit` points are always visited;
- optional `transit` points are visited according to `visitProbability`;
- a `transit` with `retentionSeconds > 0` becomes a JuPedSim **queue stage**;
- waypoints carry a vision cone (`visionAngleDeg`, `visionRangeCm`) propagated into live frames.

### Walkable geometry and the “Chemin navigable” diagnostic

Before every batch run, live start, or live update, the backend computes a partition of the accessible floor area:

- the store defines the initial envelope;
- furniture and forbidden zones subtract obstacles;
- if the surface splits into several islands, the engine keeps the connected component that still contains valid entries/exits;
- disconnected islands are excluded instead of always hard-failing the simulation.

The preview endpoint `POST /api/cad/projects/{project_id}/simulation/walkable-preview` returns:

- the connected polygon actually used by the simulation;
- excluded islands;
- the obstacles responsible for a split;
- a preview navmesh / flow field;
- obstacle simplification gains (`envelopeMergeGain`).

In the studio, the **Chemin navigable** overlay shows:

- **magenta**: playable connected area;
- **violet**: excluded islands;
- **red**: blocking obstacles.

Constraint violations return `422` with a FastAPI body shaped like `{"detail": {...}}`.
Common cases documented here are:

- `detail.code = "splitAccessibleArea"` for all three blocking families: obstacle-split surface, no reachable entry, or disconnected exit;
- `detail.message` contains the corrective guidance;
- `detail.blockingElementType`, `detail.blockingElementId`, `detail.blockingElementLabel` identify the blocking element when known;
- `detail.blockingElementIds` may list multiple obstacles when no entry is reachable or an exit is disconnected.

### Execution modes and the live loop

| Mode | Main endpoint | Result |
|------|---------------|--------|
| **Batch** | `POST /api/cad/projects/{project_id}/simulation/run` | Full frames + waypoints + summary + analytics |
| **Live** | `POST /api/cad/projects/{project_id}/simulation/live/start` | Persistent session then controlled through `tick/pause/resume/update/stop` |

Live loop details:

- the frontend requests a tick roughly every **100 ms**;
- a single tick may group several backend steps, with progressive catch-up if the tab was throttled;
- the backend returns a bounded frame/sample window to keep payload size stable;
- heavier analytics (heatmap, visits, trajectories) are refreshed separately every **1 s**;
- a live update rebuilds geometry, JuPedSim stages, and the planner without resetting cumulative queue metrics;
- stop destroys the backend live session.

### Simulation API

| Endpoint | Usage |
|----------|-------|
| `POST /api/cad/projects/{project_id}/simulation/run` | Run a batch/offline simulation |
| `POST /api/cad/projects/{project_id}/simulation/walkable-preview` | Preview walkable geometry and navmesh |
| `POST /api/cad/projects/{project_id}/simulation/live/start` | Start a live session |
| `POST /api/cad/projects/{project_id}/simulation/live/{session_id}/tick` | Advance the live session |
| `POST /api/cad/projects/{project_id}/simulation/live/{session_id}/pause` | Freeze the live clock |
| `POST /api/cad/projects/{project_id}/simulation/live/{session_id}/resume` | Resume the live clock |
| `POST /api/cad/projects/{project_id}/simulation/live/{session_id}/update` | Reload scene + config without restarting the session |
| `GET /api/cad/projects/{project_id}/simulation/live/{session_id}/analytics?sinceSeq=<int>` | Read either a full snapshot (`full=true`, `analytics`) or a delta (`full=false`, `analyticsDelta`); responses always include `seq` and `waypoints` |
| `POST /api/cad/projects/{project_id}/simulation/live/{session_id}/stop` | Stop and destroy the session |
| `POST /api/cad/projects/{project_id}/simulation/import-pedestrians` | Import a pedestrian/basket CSV and build pickup plans |
| `GET /api/cad/projects/{project_id}/simulation/pedestrians` | Read the project's latest import |
| `POST /api/cad/projects/{project_id}/simulation/load-pedestrian-dataset/{dataset_id}` | Copy a workspace dataset into the project |
| `POST /api/cad/projects/{project_id}/simulation/live/{session_id}/load-pedestrians` | Inject the project's pedestrian plan into the live session |
| `GET /api/cad/projects/{project_id}/simulation/live/{session_id}/agents/{agent_id}/basket?sinceSeq=<int>` | Pedestrian basket detail; returns `seq`, `changed`, and `basket` only when the cursor advanced |
| `GET /api/cad/projects/{project_id}/simulation/live/{session_id}/baskets?sinceSeq=<int>` | Full list (`full=true`) or delta (`full=false`) of baskets seen in the session; response includes `seq` and `baskets` |

### Pedestrian + basket datasets

Expected CSV format:

- required columns: `pedestrian_id`, `start_unix_ts`, `speed_mps`
- optional columns: `profile_json`, `ean`
- one row per **pedestrian / product** pair
- `ean` may be empty for a pedestrian with no purchase

On import:

1. the CSV is parsed and normalized;
2. each EAN is resolved to a shelf position from the project's planograms;
3. anomalies are preserved (`found=false`, explicit reason);
4. the result is saved into `pedestrians.json`;
5. if `datasetName` is provided, the same payload also becomes a reusable **workspace dataset**.

When that plan is loaded into a live session:

- pedestrians enter in `start_unix_ts` order;
- every resolved product becomes its own pickup stop;
- each stop uses a 1s-4s retention time;
- the **Parcours client** panel and the pedestrian detail view track the `picked / not picked` state of each item.

### What the user sees in the studio

- **SimulationPanel**: active mode, current dataset, live agent count, start/pause/resume/stop controls, waypoint editing, per-waypoint waiting times.
- **SimulationLayer**: instanced agents, floor heatmap, trajectories, navigation overlay.
- **CheckoutChartsOverlay**: per-waypoint throughput and yield indicators.
- **PedestrianDetailPanel**: detailed basket of the pedestrian clicked in the scene.

### Operational notes

- the **traffic** heatmap depends on live analytics;
- the **margin** heatmap is computed client-side from planograms, even without a running session;
- the **yield** heatmap combines exposed margin and measured live density, so it requires a live session;
- waypoint undo history is separate from scene undo history;
- simulation 3D labels use WebGL sprites so they remain visible in video recordings.

---

## Metrics

All metrics are raw (non-normalised) unless the table says otherwise: they keep
their physical unit so two projects, two furniture units or two runs can be
compared in absolute terms.

> French reference sheet (computed metrics, metrics still to build, and the role
> of each one): [METRIQUES.md](METRIQUES.md).

### Assortment metrics (`frontend/src/engine/assortmentMetrics.ts`)

Shown in the **Inspector**: per furniture unit (section *Implantation*) and for
the whole project (bottom panel when nothing is selected).

| Metric | Definition | Unit |
|--------|-----------|------|
| **Produits différents** | Number of **distinct EANs** carried by the selected scope. A reference facing-ed 5 times counts once. | references |
| **Facings implantés** | Total number of planogram cells, i.e. the number of product fronts physically visible. | facings |
| **Facings / produit** | `facings / distinctProducts` — average depth of exposure of a reference. Close to 1 = very wide, very shallow assortment (convenience store); > 2 = mass-merchandised assortment. | facings/ref |
| **Planogrammes remplis** | `filledPlanograms / planograms` — a planogram counts as filled as soon as it carries at least one facing. Detects faces of furniture left empty. | count / count |
| **Couverture catalogue** | `distinctProducts / catalogue size` — share of the catalogue actually implanted in the store. | % |

Current values of the reference projects (recomputed from
`backend/storage/projects/*/planograms.json`):

| Project | Catalogue | Planograms | Facings | Distinct refs | Facings / ref | Coverage |
|---------|----------:|-----------:|--------:|--------------:|--------------:|---------:|
| `carrefour_express_aeroport` | 2 800 | 52 | 3 818 | 2 800 | 1.4 | 100 % |
| `carrefour_express` | 2 964 | 46 | 2 964 | 2 964 | 1.0 | 100 % |
| `carrefour_city` | 5 000 | 306 | 15 300 | 5 000 | 3.1 | 100 % |
| `retail_cad` (demo) | 200 | 50 | 1 324 | 200 | 6.6 | 100 % |
| `demo` | 5 000 | 306 | 15 300 | 1 250 | 12.2 | 25 % |

### Assortment policy

The policy that decides **which references are carried and how many facings
each one gets** is stored with the project, not in the code: it is described in
`store-profile.json` (context modifiers) and audited in `validation-report.md`
(`backend/storage/templates/carrefour_express_aeroport/`).

| Rule | Content |
|------|---------|
| **Breadth before depth** | On a constrained sales area, every catalogue reference gets **exactly one facing** on its assigned furniture unit; a reference is duplicated only on end-gondolas. This keeps `facings / ref` close to 1 and coverage at 100 %. |
| **No reference without a facing** | The whole catalogue must be implanted (2 800 / 2 800 for the airport project) — an unplaced reference means the assortment is over-sized for the store. |
| **No empty slot** | A row is filled to the real width of the linear (`widthCm` per facing) then shortened with `rowColCounts`; holes are re-filled with new references first, then with extra facings of the best rotations. Enforced by `test_planograms_have_no_empty_slot`. |
| **Context modifiers** | `store-profile.json` boosts (×1.6) or reduces (×0.5) the selection weight of categories according to the store context (airport: Snacking, Boissons, Presse, Hygiène boosted; Surgelés and Entretien reduced). |
| **End-gondola duplication** | End-gondolas carry only references already in the aisle, sorted by decreasing `rotationIndice`, on a full grid without holes — extra exposure, no extra reference. |
| **Adjacency** | Impulse categories (snacking, press) near the entrance, grab-and-go chilled next to it, grocery then beverages in the central aisles, non-food at the back. |
| **Anti-duplication** | A reference is not repeated on two faces of the same furniture unit as long as another reference of the category can take the slot. |

`assortment.json` at the repo root is the **read-only raw pool** (4 807
products with barcode, brand, `is_mdd`, prices, category) the project catalogues
are drawn from. It is never modified by the app.

### Margin policy

Margin is a **product attribute of the catalogue**, and every €-based metric
(margin heatmap, absolute yield) is derived from it — nothing is hard-coded in
the engines.

| Field (`CADProduct` / backend `Product`) | Meaning |
|------------------------------------------|---------|
| `priceBuyEur` | Buying price (€ excl. tax), optional |
| `priceSellEur` | Selling price (€ incl. tax), optional |
| `marginPct` | Mark-up rate (%), optional |

`engine/marginHeatmap.ts` → `productMarginEur()` computes the unit margin of a
facing with this fallback order:

1. `priceSellEur − priceBuyEur` when both prices are known (clamped at ≥ 0);
2. else `priceSellEur × marginPct / 100`;
3. else **0 €** — a product without pricing contributes nothing, it never
   breaks the metric.

How the reference projects are priced (see `validation-report.md` §4): each
category carries a target margin rate (22 % baby / grocery savory … 40 %
ready-to-eat) and a base buying price; `priceBuyEur` = base price × size factor
derived from `quantity` (clamped 0.4–1.8), `priceSellEur` = commercial rounding
to `,x9` above `priceBuyEur / (1 − rate)`, and `marginPct` is recomputed after
rounding. No product is left with a null or zero price.

> Consequence for the metrics: the margin exposed on the floor is a **facing
> margin** (unit margin × number of facings), i.e. the € a shopper can see, not
> a realised margin — there is no sales or stock feed yet (see Roadmap).

### Simulation metrics

Per waypoint (`WaypointMetrics`, backend `services/simulation.py`):

| Metric | Definition | Unit |
|--------|-----------|------|
| `releasedAgents` | Cumulative number of agents that have **passed through** the waypoint. Counted by `WaypointPassageTracker`, which credits a waypoint when an agent stops targeting it — so it is populated for `entry`, `transit` **and** `exit`, not only for queueing waypoints. | agents |
| **Débit** (`engine/waypointThroughput.ts`) | `Δ releasedAgents / Δt` between two samples, plus current and peak value over the window. Displayed in the checkout charts overlay. | agents/s |
| `maxActiveAgents` | Peak simultaneous occupancy of the waypoint. | agents |
| `queuedAgents` / `completedWaits` | Agents that entered / finished the queue of a retention waypoint. | agents |
| `averageWaitSeconds`, `maxWaitSeconds`, `currentMaxWaitSeconds` | Queue waiting time: mean, all-time peak, live peak. | s |

Run-level (`SimulationSummary`): `spawnedCustomers`, `completedCustomers`,
`activeCustomers`, `averageWaypointLoad`, `maxWaypointLoad`,
`averageConfiguredRetentionSeconds`.

Grids (`SimulationAnalytics`, polled every second while an overlay is on):

| Grid | Definition | Unit |
|------|-----------|------|
| `heatmap` | Cumulated **agent samples** per cell — a proxy for dwell time (a standing agent keeps adding samples). | samples |
| `visitHeatmap` | Cumulated **agent entries** per cell (one count per entry, whatever the dwell). Divided by `timeSeconds` it gives an absolute flow. | persons/s |
| `marginHeatmap` (`engine/marginHeatmap.ts`) | Client-side: each planogram column radiates its cumulated facing margin onto the aisle slice in front of it, over `MARGIN_INFLUENCE_CM` = 100 cm, on a 50 cm grid (`MARGIN_HEATMAP_CELL_CM`, capped at 120 cells/axis). No running session needed. | € |
| `yieldHeatmap` (`engine/yieldHeatmap.ts`) | **Normalised** margin × traffic index (`margin/maxMargin × traffic/maxTraffic`), for relative colouring only. | 0–1 |
| `absoluteYield` (`engine/absoluteYield.ts`) | Raw margin × traffic: € exposed per facing × persons/s, summed on the *visit* grid. Never normalise it. Exposes `totalEurPerSecond`, `maxCellEurPerSecond`, `productiveCells`, `exposedFlowPerSecond`, `exposedMarginEur`. | €/s |

Where they are displayed:

| Surface | Metrics shown |
|---------|---------------|
| **Inspector** (furniture selected) | *Implantation*: distinct products, facings, facings/product; for the selected planogram cell: buying price, selling price, unit margin (€ and %) |
| **Inspector** (nothing selected) | Same project-wide + filled planograms + catalogue coverage |
| **SimulationPanel** | Live agent count, per-waypoint queue waiting times, floor-heatmap intensity selector (`traffic` or `margin`, `simulationStore.heatmapMode`) |
| **CheckoutChartsOverlay** | Absolute yield (€/s: current, peak cell, exposed margin) + per-waypoint throughput (ag/s) |

### Proposed metrics (not implemented yet)

| Metric | Definition | Why it matters |
|--------|-----------|----------------|
| **Linéaire développé** | Σ (row width × number of levels) per furniture unit / category, in metres. | The reference unit of category management; makes *share of linear* possible. |
| **Part de linéaire par catégorie** | Category linear / total linear, compared with its share of margin or of sales. | Detects over- and under-spaced categories (space-to-sales index). |
| **Densité de marge au mètre linéaire** | Σ facing margin / linear metres of the face. | Ranks furniture units by profitability of the space they occupy, not by sales. |
| **GMROS** (margin per m² of floor) | Cumulated margin / floor footprint of the furniture (width × depth). | Arbitrates between a gondola and an island for the same floor area. |
| **Indice d'accessibilité / hauteur de prise** | Share of facings within the 80–140 cm grab zone, weighted by rotation index. | Checks that best sellers really sit at eye/hand level. |
| **Taux de conversion trafic → marge** | Absolute yield (€/s) / local flow (persons/s) in front of the face. | Isolates faces with heavy traffic but poor monetisation. |
| **Temps d'exposition par meuble** | Cumulated dwell time (from `heatmap`) of the cells facing the furniture unit. | Turns dwell into a per-furniture KPI instead of a per-cell one. |
| **Taux de rupture simulé** | Facings whose stock (facing × depth capacity) is exhausted before the end of the run, given the rotation index. | Anticipates replenishment frequency per shelf. |
| **Duplication d'assortiment** | Share of references present on several faces of the same run. | Measures cannibalisation of linear by duplicates. |
| **Indice de congestion** | Time share where the local density exceeds a comfort threshold (persons/m²). | Locates bottlenecks not visible on a cumulative heatmap. |

---

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 20+

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The `retail_cad` demo project is auto-seeded on first startup.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**

### Astra pilot (AI agent store builder)

Build a complete store from zero through the REST API (project, store dimensions,
furniture layout, catalog import, planograms):

```bash
python scripts/astra_build_store.py --name "Magasin Astra" --catalog assortment.json
```

For the complete integration guide — API endpoints used, how to plug an agent,
auth/key expectations, cost framing, CLI options, payload formats, and troubleshooting —
see [`scripts/README.md`](scripts/README.md).

### 3. Tests

```bash
# Backend
cd backend && python -m pytest

# Frontend
cd frontend && npx vitest run
```

---

## Using the CAD Editor

The app loads the **retail_cad** demo project automatically (50 m × 30 m store, 10 gondolas, 2 fridges, 1 register, 200 products, 22 planograms).

### 3D Scene View
- **Left panel / Scene tab**: Tree hierarchy of all furniture (like Blender/Unity)
- Click any furniture to **select** it (blue highlight in 3D + Inspector)
- Orbit camera: **left drag** · Zoom: **scroll** · Pan: **right drag**

### Planogram Editor
- In the Scene hierarchy, **expand** a furniture piece to see its faces
- Click a face (e.g. "Face avant") to open the **Planogram Editor**
- Switch to **Split view** (toolbar) to edit planograms alongside the 3D scene

### Editing a Planogram
1. Open the **Catalog tab** in the left panel
2. Search or browse 200 products
3. **Click** a product to select it, then click an empty cell to place it
4. **Drag** a product card from the Catalog directly onto a cell
5. **Right-click** a filled cell to clear it
6. **Ctrl+Z** to undo
7. Changes auto-save every 500 ms

### Inspector Panel (right)
- Select furniture → edit position (cm), dimensions, rotation
- Click a face badge → open its planogram editor
- *Implantation* section: distinct products, facings and facings per product for
  the selected furniture unit; with nothing selected the panel shows the same
  metrics for the whole project plus catalogue coverage (see [Metrics](#metrics))
- A face badge marked `DÉBORD` means the planogram is larger than the face it is
  mapped on. **Ajuster** (per face) or **Ajuster au meuble** (all faces) resizes
  it with `engine/planogramFit.ts`: facings keep their real width, only the
  columns/rows that no longer fit are de-listed (a single facing wider than the
  face is scaled down as a last resort)
- Changes auto-save every 500 ms

---

## Architecture Principles

- **Data first**: All relations use UUIDs. Scene never references products directly.
- **Planograms are independent documents**: They reference only EANs.
- **Furniture references planograms**: via face-to-planogramId mapping.
- **Scale**: All coordinates/dimensions stored in **cm**; 3D renders divide by 100.
- **Storage**: JSON files in `backend/storage/projects/{id}/`. Drop-in compatible with PostgreSQL later.
- **No data duplication**: Catalog products are referenced by EAN only.

---

## Roadmap

| Module | Status |
|--------|--------|
| 3D CAD editor + planogram editor | ✅ Done |
| Gondola shelf engine (variable shelves & separators) | ✅ Done |
| Live customer flow simulation | ✅ Done |
| Batch simulation + heatmaps | ✅ Done |
| Floor plan editor (2D top-down) | ✅ Done |
| Video recording of the 3D scene | ✅ Done |
| Export / Import wizard | ✅ Done |
| Analytics Engine (traffic heatmaps, dwell) | ✅ Done |
| Vision Engine (computer vision compliance) | 🔲 Stub |
| RAG / LLM planogram assistant | 🔲 Stub |
| Sales / Margin / Stock integration | 🔲 Stub |
| PostgreSQL migration | 🔲 Ready (UUID-based, no SQL-specific code) |
| PDF / Excel export | 🔲 Stub |
| Multi-user / collaboration | 🔲 Stub |

---

## Tailles de référence & cohérence

### Tailles des cellules de planogramme

Chaque planogramme est découpé en cases (*boxes*) dont la taille dépend du meuble auquel il est attaché. Les dimensions sont toujours en **centimètres**.

#### Valeurs par défaut du moteur gondole

| Constante | Valeur | Description |
|-----------|--------|-------------|
| `DEFAULT_SHELF_HEIGHT_CM` | **30 cm** | Hauteur d'une étagère à la création |
| `DEFAULT_SEP_SPACING_CM` | **15 cm** | Écartement entre séparateurs (= largeur de case par défaut) |
| `MIN_BOX_CM` | **2 cm** | Largeur minimale d'une case (impossible de rétrécir en dessous) |
| `DEFAULT_GONDOLA_DEPTH_CM` | **45 cm** | Profondeur gondole par défaut (moteur interne) |
| `OVERFLOW_TOLERANCE_CM` | **0.5 cm** | Tolérance avant d'afficher l'avertissement débordement ⚠ |

> **Rendu pixel** : à zoom = 1, le planogramme est affiché à **2,2 px/cm** horizontalement et **1,4 px/cm** verticalement. Le zoom va de ×0,4 à ×4.

#### Projet démo `retail_cad` — tailles réelles des cases

| Meuble | Face | Planogramme | Lignes × Colonnes | Case (larg × haut) |
|--------|------|-------------|-------------------|---------------------|
| Gondoles A–J (120 × 200 cm) | `front` / `back` | 120 × 200 cm | 5 × 8 | **15 × 40 cm** |
| Gondoles A–J (120 × 200 cm) | `left` / `right` | 60 × 200 cm | 5 × 4 | **15 × 40 cm** |
| Têtes de gondole (80 × 180 cm) | `front` / `back` | 80 × 180 cm | 4 × 2 | **40 × 45 cm** |
| Têtes de gondole (80 × 180 cm) | `left` / `right` | 60 × 180 cm | 4 × 2 | **30 × 45 cm** |
| Frigos 1–2 (100 × 210 cm) | `front` | 100 × 210 cm | 6 × 5 | **20 × 35 cm** |

---

### Cohérence planogramme ↔ gondole

La dimension du planogramme doit toujours correspondre exactement à la face du meuble auquel il est lié :

| Face | Dimension horizontale du PLN | Dimension verticale du PLN |
|------|------------------------------|---------------------------|
| `front` / `back` | = `furniture.dimensions.width` | = `furniture.dimensions.height` |
| `left` / `right` | = `furniture.dimensions.depth` | = `furniture.dimensions.height` |
| `top` | = `furniture.dimensions.width` | = `furniture.dimensions.depth` |

**Vérification automatique** : si `planogram.widthCm > furniture.width + 0.5 cm` ou `planogram.heightCm > furniture.height + 0.5 cm`, le planogramme affiche une alerte en rouge dans l'éditeur.

**Validation cas démo** :
- Gondole 120 × 200 cm, face `front` → PLN 120 × 200 cm, 8 cols × 15 cm = 120 ✅, 5 rows × 40 cm = 200 ✅
- Gondole 120 × 200 cm, face `left` → PLN 60 × 200 cm (profondeur 60 cm), 4 cols × 15 cm = 60 ✅
- Frigo 100 × 210 cm, face `front` → PLN 100 × 210 cm, 5 cols × 20 cm = 100 ✅

---

### Tailles des produits (catalogue)

Toutes les dimensions produit sont stockées en **centimètres**.

| Champ | Plage (démo 200 produits) | Valeurs présentes |
|-------|---------------------------|-------------------|
| `widthCm` | 4 – 14 cm | 4, 6, 7, 9, 10, 14 cm |
| `heightCm` | 6 – 18 cm | 6, 8, 15, 16, 18 cm |
| `depthCm` | 3 – 8 cm | — |

**Cohérence produits → cases** : les produits du catalogue démo (max 14 cm de large, max 18 cm de haut) entrent dans toutes les cases du démo (min 15 × 30 cm). L'éditeur affiche un badge ⚠ **débordement** en rouge si un produit dépasse la case qui lui est assignée (tolérance 0,5 cm).

---

### Upload d'images produit

L'image d'un produit s'ajoute via le bouton 📷 dans l'éditeur de planogramme ou via l'API.

| Paramètre | Valeur |
|-----------|--------|
| **Taille maximale** | **5 Mo** |
| **Formats acceptés** | JPEG, PNG, WebP, GIF, SVG |
| **Stockage** | Base64 data-URL inline dans `catalog.json` → champ `product.imageUrl` |
| **Endpoint API** | `POST /{project_id}/catalog/products/{ean}/image` (multipart `file`) |

#### Résolution recommandée (pixels par centimètre)

L'image est affichée en `object-contain` dans la case du planogramme. La taille en pixels d'une case dépend de l'échelle d'affichage :

| Zoom | px / cm horizontal | px / cm vertical |
|------|--------------------|-----------------|
| ×0,4 (min) | 0,88 px/cm | 0,56 px/cm |
| **×1 (normal)** | **2,2 px/cm** | **1,4 px/cm** |
| ×2 | 4,4 px/cm | 2,8 px/cm |
| ×4 (max) | 8,8 px/cm | 5,6 px/cm |

**Résolution minimale recommandée** : **3 px/cm** (couvre le zoom normal avec une légère marge).  
**Résolution idéale** : **9–10 px/cm** (net jusqu'au zoom maximum ×4, pas de flou visible).

**Exemples concrets** pour une case de 15 × 40 cm (case standard gondole) :

| Qualité | Formule | Taille image |
|---------|---------|--------------|
| Minimum (zoom ×1) | 15 × 2,2 = 33 px · 40 × 1,4 = 56 px | ≥ **33 × 56 px** |
| Recommandé (zoom ×4) | 15 × 9 = 135 px · 40 × 6 = 240 px | ≥ **135 × 240 px** |
| Confort général | — | **200 × 200 px** (carré, ratio auto-ajusté par object-contain) |

> 💡 **Conseil pratique** : une image carrée de **200 × 200 px à 300 × 300 px** est suffisante pour tous les cas d'usage. Au-delà, le gain visuel est imperceptible mais le poids de `catalog.json` augmente inutilement.

> ⚠️ Les images sont encodées en base64 et stockées **dans le JSON du catalogue**. Un catalogue avec de nombreux produits illustrés peut donc devenir volumineux. Pour les environnements de production, migrer vers un stockage fichier ou objet (S3, etc.) est recommandé.

**Codes d'erreur retournés par l'API** :
- `413` — fichier supérieur à 5 Mo
- `415` — format non supporté (seuls JPEG, PNG, WebP, GIF, SVG sont acceptés)
