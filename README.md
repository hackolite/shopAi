# Retail CAD — AI-Native Planogram & Digital Twin Builder

**The Figma of Planograms.** A professional SaaS tool for designing retail stores in 3D, editing planograms independently of geometry, running customer flow simulations, and automatically applying them to store furniture.

---

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
| POST | `/{id}/catalog/import` | **Import catalog from JSON** (see format below) |
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

The **📂 Importer JSON** button in the Catalog panel (and the `POST /{id}/catalog/import` API
endpoint) accepts a JSON file in one of two shapes:

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

> **Note:** importing replaces the entire catalog by default. To keep existing products and only
> add/overwrite the imported ones, add `"merge": true` at the root of the JSON (API only).

---

---

## Simulation Module

The simulation engine models customer foot traffic inside the store using an agent-based approach.

### Waypoint Types

| Type | Role |
|------|------|
| `entry` | Spawns agents at the specified rate (agents/hour). First arrival scheduled at t=0, then exponential inter-arrivals. |
| `transit` | Routes agents through the store; used for aisle traversal or dwell points. |
| `exit` | Despawns agents once they arrive (circular exit zone of configurable radius). |

### Simulation Modes

| Mode | Description |
|------|-------------|
| **Batch** | Full offline run → produces heatmap + per-zone dwell statistics |
| **Live** | Real-time session; frontend polls at 100 ms, backend streams agent states |

### Live Simulation API

| Endpoint | Action |
|----------|--------|
| `POST /{project_id}/simulation/live/start` | Start a new live session |
| `POST /{project_id}/simulation/live/{session_id}/tick` | Advance simulation clock |
| `POST /{project_id}/simulation/live/{session_id}/pause` | Pause session |
| `POST /{project_id}/simulation/live/{session_id}/resume` | Resume session |
| `POST /{project_id}/simulation/live/{session_id}/update` | Hot-update waypoint config |
| `GET /{project_id}/simulation/live/{session_id}/analytics` | Cumulative occupancy heatmap + agent trajectories |
| `POST /{project_id}/simulation/live/{session_id}/stop` | Stop and discard session |

### Frontend Simulation Features

- **SimulationPanel**: waypoint placement, live controls (play/pause/stop), agent-count display, heatmap/trajectory toggles, floor-heatmap intensity selector (traffic or exposed margin), per-waypoint queue waiting times (average, max, live)
- **SimulationLayer**: instanced rendering of 40+ agents at 100 ms tick, 220 ms render buffer, 200 ms extrapolation cap, floor heatmap and agent trajectory overlays (analytics polled every second). The margin heatmap (`engine/marginHeatmap.ts`) is computed client-side, column by column: each planogram column radiates its cumulated facing margin onto the aisle in front of its own footprint slice, so it needs no running session.
- **New object placement**: furniture and waypoints created from the panels appear at the bottom-left corner of the store grid
- **Undo history**: simulation waypoint edits have their own undo stack (Ctrl/Cmd+Z in simulation context)
- **Video recording**: on-screen labels use `TextSprite3D` (WebGL sprite) so they appear in `canvas.captureStream()` recordings

### Waypoint Placement Constraints

| Type | Clearance rule |
|------|---------------|
| `entry` | Centre must be ≥ `AGENT_RADIUS_CM` from any obstacle |
| `transit` | Centre must be inside walkable area (0 cm clearance) |
| `exit` | Centre must be ≥ `radiusCm + AGENT_RADIUS_CM` from any obstacle |

---

## Metrics

All metrics are raw (non-normalised) unless the table says otherwise: they keep
their physical unit so two projects, two furniture units or two runs can be
compared in absolute terms.

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

The reference project `carrefour_express_aeroport` is validated at **2 800 /
2 800** references implanted, 52 planograms, 3 818 facings.

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
| `marginHeatmap` (`engine/marginHeatmap.ts`) | Client-side: each planogram column radiates its cumulated facing margin onto the aisle slice in front of it. No running session needed. | € |
| `yieldHeatmap` (`engine/yieldHeatmap.ts`) | **Normalised** margin × traffic index, for relative colouring only. | 0–1 |
| `absoluteYield` (`engine/absoluteYield.ts`) | Raw margin × traffic: € per facing × persons/s. Never normalise it. | €/s |

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
