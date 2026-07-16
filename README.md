# Retail CAD — AI-Native Planogram & Digital Twin Builder

**The Figma of Planograms.** A professional SaaS tool for designing retail stores in 3D, editing planograms independently of geometry, and automatically applying them to store furniture.

---

## Architecture

```
shopAi/
├── backend/                          # FastAPI (Python 3.11+)
│   ├── main.py                       # Entry point, CORS, routers, demo init
│   ├── models/
│   │   └── project.py                # Pydantic v2 models for all entities
│   ├── api/
│   │   ├── cad_projects.py           # CAD CRUD endpoints (/api/cad/projects/*)
│   │   ├── furniture_library.py      # Furniture library (/api/furniture-library)
│   │   └── projects.py               # Legacy voxel viewer endpoints (backward compat)
│   ├── services/
│   │   ├── project_manager.py        # Secure JSON file I/O for CAD projects
│   │   ├── demo_generator.py         # Demo data: 200 products, 13 furniture, 22 planograms
│   │   ├── demo_initializer.py       # Auto-seeds retail_cad project on startup
│   │   ├── planogram_loader.py       # Legacy JSON I/O + EAN index
│   │   ├── voxel_generator.py        # Converts planogram → 3D voxel descriptors
│   │   └── ean_search.py             # EAN lookup + analytics
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
        │   └── projectStore.ts       # Project list, current project
        ├── api/
        │   ├── cad.ts                # Typed client for /api/cad/* endpoints
        │   └── index.ts              # Legacy API client
        ├── three/
        │   └── SceneEditor.tsx       # R3F canvas: furniture meshes, floor, gizmo
        └── components/
            ├── Toolbar/              # Top bar: tool picker, view toggle
            ├── SceneHierarchy/       # Unity/Blender-style tree, visibility toggles
            ├── CatalogPanel/         # Product browser with search + drag-and-drop
            ├── Inspector/            # Properties panel (position, dims, rotation, faces)
            └── PlanogramEditor/      # 2D grid editor: click/drag to place products
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

| Type | Name | Default Dimensions |
|------|------|--------------------|
| `gondola_single` | Gondole simple | 120 × 60 × 200 cm |
| `gondola_double` | Gondole double face | 120 × 80 × 200 cm |
| `end_gondola` | Tête de gondole | 100 × 60 × 200 cm |
| `pallet` | Palette | 120 × 80 × 20 cm |
| `fridge` | Frigo | 100 × 80 × 210 cm |
| `display` | Présentoir | 60 × 40 × 180 cm |
| `register` | Caisse | 80 × 60 × 90 cm |
| `wall` | Mur | 500 × 20 × 300 cm |
| `partition` | Cloison | 200 × 10 × 200 cm |

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

Future modules are architecturally prepared but not yet implemented:

| Module | Status |
|--------|--------|
| Analytics Engine (heatmaps, traffic) | 🔲 Stub |
| Vision Engine (computer vision compliance) | 🔲 Stub |
| RAG / LLM planogram assistant | 🔲 Stub |
| Sales / Margin / Stock integration | 🔲 Stub |
| PostgreSQL migration | 🔲 Ready (UUID-based, no SQL-specific code) |
| PDF / Excel export | 🔲 Stub |
| Multi-user / collaboration | 🔲 Stub |
