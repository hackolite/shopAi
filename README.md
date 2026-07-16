# Retail Digital Twin — MVP v1.0

A 3D voxel digital twin of a retail store. Search products by EAN and instantly illuminate all their shelf positions across the store.

---

## Architecture

```
shopAi/
├── backend/                   # FastAPI (Python)
│   ├── main.py                # Entry point, CORS, router registration
│   ├── api/
│   │   └── projects.py        # REST endpoints
│   ├── services/
│   │   ├── planogram_loader.py  # JSON file I/O + EAN index builder
│   │   ├── voxel_generator.py   # Converts planogram → 3D voxel descriptors
│   │   └── ean_search.py        # EAN lookup + analytics aggregation
│   ├── storage/
│   │   └── projects/
│   │       └── demo_store/      # Demo project (50 m × 30 m, 75 products)
│   │           ├── store.json
│   │           ├── products.json
│   │           ├── planogram.json
│   │           ├── analytics.json
│   │           └── ean_index.json
│   └── requirements.txt
│
└── frontend/                  # React + Vite + TypeScript
    └── src/
        ├── api/               # Typed API client
        ├── types/             # Shared TypeScript interfaces
        ├── three/
        │   ├── StoreScene.tsx   # Canvas + OrbitControls + lighting
        │   ├── ProductBlock.tsx # Voxel block mesh (highlight on search)
        │   └── Shelf.tsx        # Store walls, floor, shelf uprights
        └── components/
            ├── Header/
            ├── SidePanel/     # Project selector + JSON import + legend
            ├── SearchBar/     # EAN search with autocomplete
            └── ProductInfo/   # Product card + analytics + location list
```

---

## Data Model

| File | Role |
|------|------|
| `store.json` | Store geometry (rectangle / polygon), height, aisle layout |
| `products.json` | EAN catalogue: name, brand, category, dimensions (cm) |
| `planogram.json` | Physical instances: EAN → position (x, y, z), shelf, level, facings |
| `ean_index.json` | Auto-generated inverted index: EAN → [instances] |
| `analytics.json` | Per-instance traffic metrics (demo data, structure ready for real data) |

**Scale:** 1 Three.js unit = 10 cm

**Category colours:**

| Category | Colour |
|----------|--------|
| Épicerie | Amber `#F5C518` |
| Boisson | Blue `#2196F3` |
| Frais | Green `#4CAF50` |
| Hygiène | Purple `#9C27B0` |
| Promotion | Red `#F44336` |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects |
| GET | `/api/projects/{id}/store` | Store geometry |
| GET | `/api/projects/{id}/products` | Product catalogue |
| GET | `/api/projects/{id}/planogram` | Planogram + voxel data |
| GET | `/api/projects/{id}/ean-index` | EAN inverted index |
| GET | `/api/projects/{id}/search?ean=` | Search by EAN |
| GET | `/api/projects/{id}/analytics` | All analytics |
| POST | `/api/projects/{id}/import/store` | Upload `store.json` |
| POST | `/api/projects/{id}/import/planogram` | Upload `planogram.json` (rebuilds index) |
| POST | `/api/projects/{id}/import/products` | Upload `products.json` |

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

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**

---

## Using the Demo

1. The app auto-loads the **demo_store** project (50 m × 30 m, 8 aisles, 75 products, 510 shelf instances).
2. In the **EAN Search** box, click **"Demo: Nutella (3017620422003)"** — all Nutella blocks across the store will glow gold.
3. The right panel shows product info, facings count, and aggregated analytics.
4. Rotate/zoom the 3D view with mouse drag / scroll.
5. Hover any block to see its EAN and category.

---

## Importing Your Own Data

Use the **Import** section in the left panel to upload your own JSON files following the schemas in `storage/projects/demo_store/`. The EAN index is rebuilt automatically on planogram import.

---

## Roadmap (Post-MVP)

- PostgreSQL / PostGIS migration (replace JSON files)
- Real-time analytics ingestion (IoT / camera feeds)
- Multi-store / multi-project management
- Planogram compliance scoring
- Heat-map overlay on 3D floor
- Export to PDF / Excel reports
