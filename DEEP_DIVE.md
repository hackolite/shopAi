# shopAi — Deep Dive : Architecture, Code & Production Readiness

> Document de référence technique à destination des contributeurs et des décideurs.
> Couvre l'architecture complète, le comportement interne de chaque couche et
> tout ce qui manque pour passer en production réelle.

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Modèle de données](#2-modèle-de-données)
3. [Backend : FastAPI + persistence JSON](#3-backend--fastapi--persistence-json)
   - 3.1 Point d'entrée `main.py`
   - 3.2 `project_manager.py` — I/O sécurisé
   - 3.3 Concurrence et mutex par projet
   - 3.4 `cad_projects.py` — logique CRUD
   - 3.5 Routeur legacy + bibliothèque de mobilier
   - 3.6 Couche d'adaptation Gondola ↔ Planogram
4. [Frontend : React 19 + Zustand + R3F](#4-frontend--react-19--zustand--r3f)
   - 4.1 Stores Zustand
   - 4.2 Client API typé (`api/cad.ts`)
   - 4.3 Moteur d'ancrage (`engine/furnitureAnchor.ts`)
   - 4.4 Moteur gondola (`engine/gondola.ts`)
   - 4.5 SceneEditor — rendu 3D R3F
   - 4.6 PlanogramEditor — grille 2D
5. [Flux de données de bout en bout](#5-flux-de-données-de-bout-en-bout)
6. [Ce qui manque pour du production-ready](#6-ce-qui-manque-pour-du-production-ready)
   - 6.1 Authentification & autorisation
   - 6.2 Concurrence et cohérence des données
   - 6.3 Persistance
   - 6.4 Performance & scalabilité
   - 6.5 Sécurité
   - 6.6 Observabilité
   - 6.7 Qualité du code & tests
   - 6.8 Déploiement & infrastructure
   - 6.9 Expérience utilisateur & robustesse

---

## 1. Vue d'ensemble

shopAi est un éditeur CAD de commerce de détail : on conçoit un magasin en 3D, on
place du mobilier (gondoles, frigos, caisses…) et on affecte des **planogrammes** aux
faces de ce mobilier. Un planogramme est une grille 2D qui positionne des produits
(référencés par EAN) sur une face physique.

```
┌──────────────────────────────────────────────────────────┐
│  Browser (React 19 + R3F + Zustand)                      │
│  ┌────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ 3D view│  │Planogram Ed. │  │Catalogue / Inspector│  │
│  └────────┘  └──────────────┘  └─────────────────────┘  │
│              ↑↓ fetch / JSON                              │
├──────────────────────────────────────────────────────────┤
│  FastAPI (Python 3.11)                                   │
│  ┌────────────────┐  ┌───────────────┐  ┌────────────┐  │
│  │ cad_projects   │  │ furniture_lib │  │  projects  │  │
│  └────────────────┘  └───────────────┘  │  (legacy)  │  │
│          ↓ project_manager.py           └────────────┘  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  storage/projects/{id}/                             │ │
│  │  scene.json  catalog.json  planograms.json  …       │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Paradigme architectural clé :** toutes les relations entre entités reposent sur des
UUID (aucune donnée n'est dupliquée). Le catalogue est la source de vérité produit ;
les planogrammes ne stockent que l'EAN.

---

## 2. Modèle de données

### Hiérarchie des entités

```
Project
 ├── project.json    { id, name, createdAt, updatedAt }
 ├── scene.json      SceneData { store: Store, furniture: FurnitureInstance[] }
 ├── catalog.json    Catalog   { products: Product[] }
 ├── planograms.json { planograms: Planogram[] }
 ├── materials.json  { materials: Material[] }
 ├── settings.json   ProjectSettings
 └── textures.json   (réservé)
```

### `FurnitureInstance` (scene.json)

| Champ | Type | Rôle |
|-------|------|------|
| `id` | UUID | Clé primaire |
| `type` | string | `gondola_single`, `fridge`, `register`… |
| `libraryId` | UUID | Référence vers `furniture_library.json` |
| `position` | `[x,y,z]` cm | Coin min de la boîte en espace monde |
| `rotation` | `[rx,ry,rz]` degrés | Rotation Euler XYZ |
| `dimensions` | `{width,depth,height}` cm | Taille de la boîte |
| `faces` | `Record<FaceId, UUID\|null>` | Planogramme assigné à chaque face |

> **Important :** `position` est le **coin inférieur-gauche-avant** de la boîte
> (pas le centre géométrique). Le rendu Three.js positionne donc le mesh à
> `position + dimensions/2`.

### `Planogram` (planograms.json)

Deux modèles coexistent :

**Modèle legacy (cells)**

```
Planogram {
  rows, cols, widthCm, heightCm
  cells: PlanogramCell[]     ← [{ ean, row, col, rotation }]
  colWidthsCm?               ← largeurs non-uniformes par colonne
  rowHeightsCm?              ← hauteurs non-uniformes par rangée
  cellWidthOverrides?        ← overrides à la cellule ("row-col" → cm)
  rowColCounts?              ← nombre de colonnes différent par rangée
  mergedSpans?               ← cellules fusionnées
}
```

**Modèle gondola (boundary-based, §6 du spec)**

```
Gondola {
  width_cm, height_cm, depth_cm
  shelves: Shelf[] {
    id, height_cm
    separators: Separator[]   ← positions absolues en cm depuis bord gauche
  }
  productPlacements: ProductPlacement[] {
    productId (EAN), shelfId, leftSeparatorId, rightSeparatorId, rotation
  }
}
```

Quand `gondola` est présent dans un `Planogram`, c'est la source de vérité.
Les champs legacy (`cells`, `rows`, `cols`…) sont **dérivés à la volée** par
`gondola_adapter.py` (backend) et `gondola.ts` (frontend) à la lecture.

### Invariants à respecter

1. `furniture.faces[face]` ↔ `planogram.furnitureId + planogram.face` — ces deux
   directions doivent être synchronisées lors de toute mutation.
2. `planogram.widthCm` == `furniture.dimensions.width` (ou `depth` pour les faces
   latérales) au moment de la création. Ils divergent si la furniture est
   redimensionnée après coup sans mise à jour du planogramme.
3. Supprimer une furniture doit supprimer ses planogrammes associés (déjà géré par
   `remove_furniture`).

---

## 3. Backend : FastAPI + persistence JSON

### 3.1 Point d'entrée `main.py`

```python
app = FastAPI(…)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", …])
init_retail_cad_demo()   # ← synchrone, au démarrage
app.include_router(cad_router)
app.include_router(furniture_library_router)
app.include_router(projects_router)
```

`init_retail_cad_demo()` génère le projet de démo (`retail_cad`) s'il n'existe pas.
Cette initialisation est **synchrone et bloquante** ; elle s'exécute dans le thread
principal avant que l'event loop uvicorn ne démarre.

### 3.2 `project_manager.py` — I/O sécurisé

C'est la seule couche qui lit/écrit le disque. Elle expose :

| Fonction | Rôle |
|----------|------|
| `_validate_project_id(id)` | Regex `^[A-Za-z0-9_-]{1,64}$` — bloque toute traversée de chemin |
| `_validate_filename(f)` | Allowlist de 7 fichiers — aucun nom arbitraire |
| `_safe_project_path(id, f)` | Construit le chemin après double validation |
| `_read_json` / `_write_json` | JSON load/dump avec récupération de la forme `Extra data` |
| `load_project_file` / `save_project_file` | API publique avec validation |
| `export_project_zip` / `import_project_from_zip` | Archive ZIP des fichiers JSON |
| `duplicate_project` | `shutil.copytree` + nouveau metadata |

**Points notables :**
- Les commentaires `# lgtm[py/path-injection]` désactivent les fausses alertes
  d'analyse statique ; le chemin est réellement sécurisé par la double validation.
- `_read_json` récupère gracieusement les fichiers JSON corrompus par écriture
  partielle (`Extra data`) en rejouant `raw_decode`.
- `_touch_project_metadata` met à jour `updatedAt` à chaque `save_project_file`,
  sans passer par le modèle Pydantic (mutation directe du dict brut).

### 3.3 Concurrence et mutex par projet

FastAPI exécute les handlers **synchrones** dans un thread pool. Plusieurs requêtes
concurrentes pour le même projet peuvent donc lire le même état stale et se
perdre mutuellement.

**Solution actuelle :** un `threading.Lock` par `project_id` protège uniquement
`POST /planograms` (l'opération la plus susceptible d'être appelée en rafale).

```python
_project_locks: dict[str, threading.Lock] = {}
_project_locks_guard = threading.Lock()

def _get_project_lock(project_id: str) -> threading.Lock:
    with _project_locks_guard:
        if project_id not in _project_locks:
            _project_locks[project_id] = threading.Lock()
        return _project_locks[project_id]

# Dans add_planogram :
with _get_project_lock(project_id):
    planograms = _load_planograms(project_id)
    …
    _save_planograms(project_id, planograms)
    _save_scene(project_id, scene)
```

**Ce qui n'est PAS protégé :** `update_furniture`, `update_store`, `add_product`,
`update_planogram`… Toutes ces opérations sont des read-modify-write non atomiques
sur leurs fichiers respectifs.

### 3.4 `cad_projects.py` — logique CRUD

Architecture homogène sur tous les endpoints :

```
1. _load_XXX(project_id)          → Pydantic model
2. mutation locale (find_index, merge_model, pop, append…)
3. _save_XXX(project_id, updated) → JSON sur disque
4. return updated.model_dump(mode="json")
```

`_merge_model(cls, current, payload)` est la fonction centrale : elle fusionne un
payload partiel dans un modèle existant via `model_dump + update + model_validate`,
ce qui déclenche les validators Pydantic sur le résultat final.

**Gestion des images produit :** l'endpoint `POST /catalog/products/{ean}/image`
accepte un upload (max 5 MB, types restreints) et stocke le résultat en
**base64 data-URL** dans `imageUrl` du produit. Cela gonfle massivement
`catalog.json`.

### 3.5 Routeur legacy + bibliothèque de mobilier

- `furniture_library.py` : lit `storage/furniture_library.json` (9 types fixes) et
  expose `GET /api/furniture-library` et `GET /api/furniture-library/{type}`. Lecture
  seule, aucune mutation.
- `projects.py` : endpoints voxel hérités pour le projet `demo_store`. Conservé pour
  compatibilité ascendante.

### 3.6 Couche d'adaptation Gondola ↔ Planogram

`gondola_adapter.py` est la passerelle entre les deux modèles.

**`gondola_to_legacy_cells`** (lecture via API)

1. Itère les shelves dans l'ordre d'affichage (display row 0 = shelf top = `shelves[-1]`).
2. Pour chaque shelf, trie les separators par `position_cm`.
3. Chaque espace entre deux separators adjacents → une cellule `PlanogramCell`.
4. Les largeurs des cellules sont stockées dans `cellWidthOverrides["{row}-{col}"]`.
5. Renvoie un `Planogram` legacy compatible avec la 3D view.

**`legacy_cells_to_gondola`** (migration de projets existants)

1. Calcule les largeurs effectives de colonnes (en priorité `cellWidthOverrides`,
   puis `colWidthsCm`, puis distribution uniforme).
2. Génère des separators equidistants pour chaque shelf.
3. Traduit chaque `PlanogramCell` en `GondolaProductPlacement`.

---

## 4. Frontend : React 19 + Zustand + R3F

### 4.1 Stores Zustand

Tous les stores sont créés avec `create<T>(set => …)` sans middleware (pas de
`devtools`, pas de `persist`).

#### `sceneStore`

Contient `scene` (entier), `selectedFurnitureId`, `selectedFurnitureIds` (multi),
`selection` (typed union), `history` (undo, max 50 snapshots scène entière).

Mécanisme undo :
```ts
updateFurniture: (furniture) =>
  set((state) => ({
    history: [...state.history.slice(-MAX_HISTORY + 1), state.scene], // push
    scene: { …state.scene, furniture: state.scene.furniture.map(…) },
  })),
undo: () =>
  set((state) => {
    const prev = state.history[state.history.length - 1];
    return { scene: prev, history: state.history.slice(0, -1) };
  }),
```

> L'undo est **purement en mémoire** : il ne persiste pas l'état au backend.
> Un Ctrl+Z et un rechargement de page donnent des états différents.

#### `planogramStore`

Cache deux choses distinctes :
- `planograms` : liste de `PlanogramSummary` (métadonnées, pas les cellules)
- `planogramDetails` : `Map<string, Planogram>` (données complètes, chargées à la demande)
- `activePlanogram` : le planogramme ouvert dans l'éditeur 2D

`syncPlanogram` est l'action atomique qui met à jour les trois en une seule
transaction Zustand pour éviter les désynchronisations lors du rebatch.

#### `uiStore`

Pilote l'affichage pur (mode de vue `3d`/`planogram`/`split`, outil actif,
visibilité des sidebars, `flyToFurnitureId`).

**Particularité :** `flyToFurnitureId` est consommé et remis à `null` par
`SceneEditor` pour déclencher un survol caméra one-shot. Depuis un refactoring,
`closePlanogram` **ne** positionne **pas** `flyToFurnitureId` afin de ne pas
réorienter la caméra automatiquement.

#### `catalogStore`

Contient `products: CADProduct[]` + index de recherche `filteredProducts` (filtrage
côté client sur name/brand/category/EAN). Pas de pagination.

### 4.2 Client API typé (`api/cad.ts`)

Un wrapper `fetch` minimal :

```ts
async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const response = await fetch(url, { …opts, headers });
  if (!response.ok) throw new Error(`[${response.status}] ${text}`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
```

Pas d'intercepteur global, pas de retry, pas de timeout, pas d'annulation
(`AbortSignal`). Les erreurs remontent comme exceptions JavaScript brutes — aucun
composant React `ErrorBoundary` ne les capture globalement.

### 4.3 Moteur d'ancrage (`engine/furnitureAnchor.ts`)

**Problème :** ajouter/supprimer une colonne de planogramme modifie la largeur de
la furniture. Three.js centre la mesh sur `position + dims/2`. Si `position` reste
fixe, les deux bords de la furniture bougent symétriquement → le contenu existant
du planogramme se décale en espace monde.

**Solution :** `anchorFurniturePosition` calcule le delta de position nécessaire pour
maintenir un bord physique fixe.

```
half = (newWidth - oldWidth) / 2
theta = rotationY (rad)
c = cos(theta), s = sin(theta)

face front/top  → anchor bord -X local  →  [px - (1-c)×half, py, pz - s×half]
face back       → anchor bord +X local  →  [px - (1+c)×half, py, pz + s×half]
face left/right → anchor bord -Z local  →  [px + s×half,     py, pz - (1-c)×half]
```

La formule est dérivée analytiquement en résolvant la contrainte
`position_world_anchored_edge = constant` pour les rotations Y arbitraires.

**Tests :** `furnitureAnchor.test.ts` valide les angles 0°, 90°, 180°, 270° pour
les trois familles de faces.

### 4.4 Moteur gondola (`engine/gondola.ts`)

36 kb de fonctions pures. Points clés :

**`computeBoxes(gondola)`** — fonction de dérivation centrale :

```
Pour chaque shelf (display order: di=0 = top = shelves[N-1]) :
  sortedSeps = shelf.separators triés par position_cm
  Pour chaque paire adjacente (left, right) :
    chercher productPlacement(shelfId, leftId, rightId)
    → Box { x_cm, width_cm, y_cm, height_cm, placement? }
```

**Commandes immutables** (`cmdXxx`) :
Toutes les mutations retournent un nouveau `Gondola` sans modifier l'original.
Exemples :
- `cmdSetPlacement(gondola, boxKey, ean)` → place un produit
- `cmdMoveSeparator(gondola, shelfId, sepId, newPos)` → déplace un séparateur
- `cmdFuseBoxes(gondola, shelf, [box1, box2])` → fusionne deux boîtes en supprimant le séparateur intermédiaire
- `extendGondolaWidth(gondola, addCm)` → agrandit par la droite (ajoute aux séparateurs du bord droit)
- `shrinkGondolaWidthLeft(gondola, removeCm)` → réduit par la gauche

**`gondolaToLegacyPlanogram`** (frontend, miroir de l'adapter backend) :
Dérive un objet `Planogram` complet depuis un `Gondola` pour alimenter le store et
la 3D view. Le résultat est **toujours recalculé** et jamais stocké en state.

### 4.5 SceneEditor — rendu 3D R3F

`SceneEditor.tsx` (~1500 lignes) héberge toute la logique Three.js.

**Persistence caméra :**
```ts
// Module-level — survit aux démontages/remontages du Canvas
let _persistedCameraState: { position, target } | null = null;

// CameraStateSync — useFrame → mise à jour chaque frame
useFrame(() => {
  _persistedCameraState = {
    position: camera.position.toArray(),
    target: controls.target.toArray(),
  };
});

// SceneContent — useLayoutEffect (avant le premier paint)
useLayoutEffect(() => {
  if (_persistedCameraState) {
    camera.position.set(…_persistedCameraState.position);
    controls.target.set(…_persistedCameraState.target);
  }
}, []);
```

**Overlay planogramme (`PlanogramFaceOverlay`) :**

1. `useMemo` sur `planogram` + `products` + `selectedCellId` + `loadedImages` → génère un `HTMLCanvasElement` 2D.
2. Le canvas est converti en `THREE.CanvasTexture`.
3. Un `<mesh>` `<planeGeometry>` est positionné et orienté pour chaque face
   (`front`, `back`, `left`, `right`, `top`) avec les offsets d'alignement gauche
   et haut calculés depuis les dimensions physiques.
4. `useEffect` → `texture.dispose()` au démontage pour éviter les fuites VRAM.

**UV click mapping :**
Le clic sur une face overlay lit `event.uv`, accumule les largeurs/hauteurs de
colonnes/rangées en cm pour identifier la cellule cliquée avec des largeurs
non-uniformes.

**Gizmo & TransformControls :**
`@react-three/drei TransformControls` + snap 100 cm via `translationSnap`.
Un contexte `ResizeDragCtx` désactive `OrbitControls` pendant un drag de handle de
resize pour éviter les conflits de pointeur.

### 4.6 PlanogramEditor — grille 2D

Rendu en DOM pur (pas de canvas 2D), avec positionnement absolu en pixels calculés
depuis `pxPerCm`.

**Architecture interne :**

```
activePlanogram (gondola model)
    ↓ computeBoxes()
  boxes[]  (dérivés, jamais stockés)
    ↓ rendu
  <div.shelf> × shelves
    <div.box> × boxes
      product thumbnail | empty cell
```

**Drag-and-drop :**
Un ref mutable `dragRef` contient tout l'état du drag en cours (source box, cible
courante, preview). Les handlers `mousemove`/`mouseup` globaux lisent `dragRef`
directement, éliminant les bugs de stale closure.

**Auto-save :**
`useEffect` sur `activePlanogram` → debounce 500 ms → `cadApi.updatePlanogram`.
Le payload envoyé contient le modèle gondola complet si présent.

---

## 5. Flux de données de bout en bout

### Ouverture d'un planogramme

```
SceneHierarchy : clic sur face
  → usePlanogramStore.setRequestOpenPlanogramId(id)
  → App.tsx : useEffect sur requestOpenPlanogramId
      → cadApi.getPlanogram(id)          [GET /planograms/{id}]
          ↳ backend: gondola_to_legacy_cells si gondola présent
      → usePlanogramStore.setActivePlanogram(planogram)
      → uiStore.setViewMode('planogram' | 'split')
```

### Ajout d'un produit dans une cellule

```
CatalogPanel : drag / clic
  → PlanogramEditor : cmdSetPlacement(gondola, boxKey, ean)
      (fonction pure → nouveau gondola sans mutation)
  → usePlanogramStore.setActivePlanogram(newPlanogram)
      (mise à jour immédiate de l'UI)
  → debounce 500ms → cadApi.updatePlanogram(id, payload)
      [PUT /planograms/{id}]
      backend: merge_model → save_project_file
  → SceneEditor : PlanogramFaceOverlay re-render
      (useEffect sur planogramDetails → nouvelle CanvasTexture)
```

### Ajout d'une colonne (extension du planogramme)

```
PlanogramEditor : bouton +col
  → extendGondolaWidth(gondola, addCm)      [moteur pur]
  → anchorFurniturePosition(position, face, …) [moteur pur]
  → cadApi.updateFurniture(id, { dimensions, position })
      [PUT /scene/furniture/{id}]
  → cadApi.updatePlanogram(id, payload)
      [PUT /planograms/{id}]
  → sceneStore.updateFurniture(updated)
  → planogramStore.syncPlanogram(updated)
```

---

## 6. Ce qui manque pour du production-ready

### 6.1 Authentification & autorisation

**Problème :** l'API est totalement ouverte. N'importe qui pouvant atteindre le
backend peut lire, modifier ou supprimer n'importe quel projet.

**Ce qu'il faut :**
- Couche d'authentification (JWT ou session cookie) sur tous les endpoints `/api/cad/`.
- RBAC (admin / editor / viewer) : un viewer ne doit pas appeler PUT/POST/DELETE.
- Le `project_id` dans l'URL ne doit être accessible qu'au propriétaire ou aux
  collaborateurs autorisés.
- Rate limiting par utilisateur/IP (FastAPI + `slowapi` ou un reverse proxy).

---

### 6.2 Concurrence et cohérence des données

**Problèmes identifiés :**

1. **Race condition généralisée :** seul `POST /planograms` est protégé par un
   mutex. Tous les autres endpoints (`update_furniture`, `update_store`,
   `add_product`, `update_planogram`…) font un read-modify-write non atomique.
   Deux onglets ouverts simultanément peuvent corrompre les données.

2. **Double fichier non transactionnel :** `add_planogram` met à jour
   `planograms.json` ET `scene.json` sous le même lock, mais un crash entre les
   deux écritures laisserait un état incohérent (planogramme enregistré,
   `furniture.faces` non mis à jour).

3. **Undo client-only :** le Ctrl+Z annule en mémoire mais ne rollback pas le
   backend. En rechargeant la page, l'état "annulé" est perdu.

**Ce qu'il faut :**
- Soit une base de données SQL avec transactions ACID (voir §6.3).
- Soit, à minima, appliquer le mutex à TOUS les endpoints d'un même projet
  (en enveloppant `_load_scene`/`_save_scene` dans un seul bloc verrouillé).
- Une API d'historique côté serveur (event-sourcing ou simple snapshot versionné)
  pour un undo durable.

---

### 6.3 Persistance

**Problèmes actuels :**

- **Fichiers JSON plats** : pas de transactions, pas d'index, pas de requêtes
  complexes. `catalog.json` croît linéairement ; avec 10 000 produits et des images
  base64, il atteint facilement plusieurs dizaines de Mo.
- **Images en base64 dans le JSON** : `catalog.json` peut exploser. Chaque requête
  GET catalog charge tout en mémoire.
- **Aucune stratégie de backup** : un `shutil.rmtree` accidentel détruit tout.
- **Pas de soft-delete ni d'audit trail**.

**Ce qu'il faut :**
- Migrer vers PostgreSQL (les modèles Pydantic utilisent déjà des UUIDs, aucun code
  SQL-spécifique à réécrire — comme prévu dans la roadmap).
- Stocker les images produit dans un object store (S3/GCS/MinIO) et ne garder que
  l'URL dans le catalogue.
- Sauvegardes automatiques (pg_dump, snapshots S3).
- Soft-delete + `deletedAt` + audit log.

---

### 6.4 Performance & scalabilité

**Problèmes actuels :**

- **O(n) sur tout** : `_find_index` itère lineairement. Avec 1 000 meubles ou 10 000
  produits, toutes les opérations de lecture sont O(n). Pas de dictionnaire, pas
  d'index.
- **Pas de pagination** : `GET /catalog` renvoie tous les produits en une seule
  réponse. `GET /planograms` renvoie tous les planogrammes. Idem côté front :
  `catalogStore` charge tout en mémoire.
- **Autosave sans file d'attente** : le PlanogramEditor déclenche un PUT toutes les
  500 ms. Si l'utilisateur tape vite ou en split-view, des dizaines de requêtes
  concurrentes s'accumulent.
- **Overlay texture recalculée à chaque render** : `useMemo` évite les recalculs
  inutiles dans les cas simples, mais la dépendance à `loadedImages` (Map) force
  une nouvelle texture à chaque image chargée même si le planogramme n'a pas changé.
- **`computeBoxes` appelé à chaque render** dans PlanogramEditor — non mémoïsé.

**Ce qu'il faut :**
- Index en mémoire sur EAN, furniture id, planogram id (dicts Python + Maps JS).
- Pagination côté API et côté frontend (infinite scroll ou page tokens).
- File d'autosave avec `AbortController` : annuler la requête précédente si une
  nouvelle arrive avant qu'elle soit terminée.
- `useMemo` + clé stable pour `loadedImages`.
- `useMemo(computeBoxes, [gondola])` dans PlanogramEditor.

---

### 6.5 Sécurité

**Problèmes actuels :**

- **CORS hardcodé** à `localhost:5173` et `localhost:3000`. Non configurable via
  variable d'environnement.
- **Pas de CSP headers** : aucune Content-Security-Policy, aucun en-tête HSTS,
  X-Frame-Options, etc.
- **`init_retail_cad_demo()` synchrone** : en production, ce genre d'effet de
  bord au démarrage peut masquer des erreurs critiques ou allonger le cold start.
- **Aucune validation de taille sur les payloads JSON** : un POST avec un
  `planograms.json` de 100 Mo est accepté sans limite.
- **Pas de validation des EANs** : n'importe quelle chaîne est acceptée comme EAN.
- **Absence de secrets management** : aucune clé API, pas de gestion `.env`.
- **`console.debug` en production** : `sceneStore.updateFurniture` loggue
  `furniture.id` et `rotation` à chaque mise à jour (peut fuiter des données dans
  les DevTools des utilisateurs finaux).

**Ce qu'il faut :**
- Variables d'environnement pour CORS origins, debug flags, etc.
- Middleware de sécurité (`helmet` équivalent Python : `secure`, ou nginx).
- Limiter la taille des payloads JSON au niveau uvicorn/nginx.
- Valider le format EAN (13 chiffres) côté backend.
- Supprimer les `console.debug` en production ou les conditionner à une variable.
- Séparer le seeding de démo du démarrage de l'app (commande CLI dédiée).

---

### 6.6 Observabilité

**Ce qui manque entièrement :**

- **Logging structuré** : `project_manager.py` utilise `logging` Python, mais les
  routeurs API n'ont aucun log. Les erreurs silencieuses (exception dans un `except:
  pass` dans `get_planogram`) ne sont jamais tracées.
- **Métriques** : pas de Prometheus, pas de compteurs de requêtes, pas de latences.
- **Tracing distribué** : pas d'OpenTelemetry.
- **Alerting** : pas de Sentry ou équivalent.
- **Health check détaillé** : `GET /` retourne `{"status": "ok"}` mais ne vérifie
  pas l'accès au stockage, l'espace disque, etc.

**Ce qu'il faut :**
- Logger chaque requête (structured logging JSON avec correlation ID).
- `GET /health` qui vérifie la disponibilité du stockage et retourne un statut
  dégradé si le disque est plein.
- Sentry (ou équivalent) sur le frontend ET le backend.
- Métriques Prometheus exposées via `/metrics`.

---

### 6.7 Qualité du code & tests

**Ce qui existe :**
- `furnitureAnchor.test.ts` : bon coverage du moteur d'ancrage (angles 0/90/180/270°,
  3 familles de faces).
- `gondola.test.ts` : tests du moteur gondola.
- `oxlint` pour le linting JS/TS.

**Ce qui manque :**

| Niveau | Problème |
|--------|---------|
| Backend | Zéro test (pas de pytest, pas de tests d'intégration API) |
| Frontend | Zéro test de composant (PlanogramEditor, SceneHierarchy, Inspector) |
| E2E | Aucun test Playwright/Cypress |
| API contract | Aucun test de contrat (le frontend peut diverger du backend sans être détecté) |
| TypeScript | `any` dans plusieurs endroits (`cad_projects.py` → `dict[str, Any]`, `App.tsx`) |
| Error boundaries | Aucun `<ErrorBoundary>` React — une exception dans `SceneEditor` plante silencieusement |

**Ce qu'il faut :**
- Tests pytest pour `project_manager.py` (CRUD, path traversal, concurrence).
- Tests API FastAPI avec `httpx.AsyncClient` + fixtures.
- Tests React Testing Library pour les composants critiques.
- `<ErrorBoundary>` global + boundary sur le Canvas R3F.
- `zod` ou validation explicite sur les réponses API côté front (actuellement
  `as Promise<T>` sans vérification runtime).

---

### 6.8 Déploiement & infrastructure

**Ce qui manque entièrement :**

- **Dockerfile** : ni backend ni frontend n'ont de Dockerfile.
- **Docker Compose** : aucune orchestration locale.
- **CI/CD** : aucun pipeline (GitHub Actions, etc.).
- **Configuration par environnement** : tout est hardcodé (`localhost:5173`,
  `http://localhost:8000`). Le frontend utilise des chemins `/api/…` relatifs
  (correct pour un reverse proxy), mais aucune variable d'environnement n'est
  définie pour les cas de déploiement cloud.
- **Build de production frontend** : `npm run dev` (Vite HMR) n'est pas utilisable
  en production ; il faut `npm run build` + un serveur de fichiers statiques.
- **Gestion des assets statiques** : pas de CDN, pas de cache-busting.
- **Secret management** : pas de vault, pas de `.env.example`.

**Ce qu'il faut :**
```
Dockerfile.backend   # python:3.11-slim + uvicorn
Dockerfile.frontend  # node:20 build stage + nginx serve stage
docker-compose.yml   # backend + frontend + volume storage
.github/workflows/ci.yml  # lint + test + build
.env.example
```

---

### 6.9 Expérience utilisateur & robustesse

**Problèmes restants :**

| Problème | Impact |
|---------|--------|
| Undo non persisté | Un rechargement perd l'historique |
| Autosave sans feedback | L'utilisateur ne sait pas si ses modifications sont enregistrées |
| Pas de gestion des conflits de version | En multi-onglet, le dernier enregistrement écrase silencieusement l'autre |
| Pas de skeleton/loading states | La scène se charge "d'un coup" sans indicateur progressif |
| Catalog en mémoire entière | Sur mobile ou connexion lente, charger 200+ produits avec images base64 est long |
| Pas de mode offline | Aucun service worker, aucune stratégie de cache |
| `STORAGE_ROOT` fixé à un chemin relatif au code | En production containerisée, le volume doit être monté et la constante doit être configurable |
| `_project_locks` grandit indéfiniment | La map est purgée à la suppression d'un projet, mais si le serveur est long-running et que des milliers de projets sont créés/supprimés, la map croît (très mineur) |

---

## Résumé des priorités production

| Priorité | Domaine | Action |
|----------|---------|--------|
| 🔴 Critique | Authentification | Ajouter JWT + RBAC avant tout déploiement public |
| 🔴 Critique | Concurrence | Étendre le mutex à tous les endpoints d'un projet |
| 🔴 Critique | Images | Déplacer les images vers un object store (sortir base64 de catalog.json) |
| 🟠 Haute | Persistance | Migrer vers PostgreSQL |
| 🟠 Haute | Tests | Pytest backend + React Testing Library frontend |
| 🟠 Haute | Conteneurisation | Dockerfile + CI/CD |
| 🟡 Moyenne | Observabilité | Logging structuré + Sentry |
| 🟡 Moyenne | Performance | Pagination API + autosave avec AbortController |
| 🟡 Moyenne | Sécurité | CSP headers + configuration par variables d'environnement |
| 🟢 Basse | UX | Indicateur de sauvegarde + undo persisté |
