# ShopAI — Documentation complète de reprise

Cette documentation est conçue pour une personne qui reprend le projet de zéro :
- comprendre rapidement le produit,
- démarrer localement,
- connaître les modules clés (frontend, backend, orchestrateur),
- savoir où intervenir selon le besoin,
- éviter les pièges fréquents.

---

## 1) Résumé exécutif

**ShopAI** est une plateforme de conception retail orientée **implantation 3D + planogrammes + simulation de flux**.

Le produit est structuré en 3 blocs :
1. **Frontend (React/TypeScript)** : studio 3D, planogrammes, simulation, workspace.
2. **Backend (FastAPI/Python)** : API métier, persistance JSON des projets, logique simulation/import/export.
3. **Orchestrator (FastAPI/Python, séparé)** : webhook LLM optionnel, pipeline de preview/confirmation.

Le projet fonctionne sans orchestrateur (assistant local déterministe), mais l’orchestrateur permet un mode agent externe piloté par LLM.

---

## 2) Stack technique

### Frontend
- React 19
- TypeScript
- Vite
- Three.js + React Three Fiber + Drei
- Zustand (state management)
- Vitest (tests)
- Oxlint (lint)

### Backend
- Python 3.11+
- FastAPI
- Pydantic v2
- Pytest
- JuPedSim (simulation piétons)

### Orchestrateur (service séparé)
- Python 3.11+
- FastAPI
- Providers LLM optionnels (OpenAI, Anthropic, xAI, OpenRouter)

---

## 3) Arborescence utile pour la reprise

```text
shopAi/
├── README.md
├── ARCHITECTURE.md
├── DEEP_DIVE.md
├── METRIQUES.md
├── AI_WORKFLOW_README.md
├── assortment.json
│
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   ├── api/
│   │   ├── cad_projects.py
│   │   ├── platform.py
│   │   ├── furniture_library.py
│   │   └── projects.py
│   ├── models/
│   │   └── project.py
│   ├── services/
│   │   ├── project_manager.py
│   │   ├── simulation.py
│   │   ├── live_simulation.py
│   │   ├── platform_service.py
│   │   ├── llm_assistant.py
│   │   ├── walkable_partition.py
│   │   ├── pedestrian_import.py
│   │   ├── pickup_planning.py
│   │   └── ...
│   ├── storage/
│   │   ├── projects/
│   │   ├── templates/
│   │   └── furniture_library.json
│   └── tests/
│
├── frontend/
│   ├── package.json
│   ├── src/
│   │   ├── App.tsx
│   │   ├── StudioApp.tsx
│   │   ├── api/
│   │   ├── components/
│   │   ├── engine/
│   │   ├── store/
│   │   ├── three/
│   │   └── types/
│   └── README.md
│
├── orchestrator/
│   ├── README.md
│   ├── requirements.txt
│   └── app/
│       ├── main.py
│       ├── agent.py
│       ├── workflow.py
│       ├── tools.py
│       ├── llm.py
│       └── schemas.py
│
└── scripts/
    ├── README.md
    └── astra_build_store.py
```

---

## 4) Démarrage local rapide

## 4.1 Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Windows (PowerShell) :
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Optionnel (uniquement pour activer `/assistant/llm`) : définir `STUDIO_LLM_WEBHOOK_URL=http://localhost:8010/webhook/llm` avant le lancement du backend (ex. `export ...` en bash ou `$env:...=...` en PowerShell), puis démarrer l’orchestrator.

API docs : `http://localhost:8000/docs`

## 4.2 Frontend

```bash
cd frontend
npm install
npm run dev
```

UI : `http://localhost:5173`

## 4.3 Orchestrateur (optionnel)

Uniquement si vous activez le mode agent LLM externe.

```bash
cd orchestrator
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export BACKEND_BASE_URL="http://localhost:8000"
export LLM_PROVIDER="none"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

Variables à renseigner : voir `orchestrator/README.md` (sections *Variables d'environnement* et *Connexion avec le backend ShopAI*). Les minimums sont `BACKEND_BASE_URL` et `LLM_PROVIDER`.
`LLM_PROVIDER=none` est un mode valide (sans fournisseur réel). Une clé provider n'est requise que si vous activez un mode LLM (`openai`, `anthropic`, `xai`, `openrouter`).
Avec `LLM_PROVIDER=none`, `/assistant/llm` reste appelable en mode déterministe (sans appel fournisseur) et n’interprète pas de modifications libres.
Chaîne de prérequis `/assistant/llm` : backend avec `STUDIO_LLM_WEBHOOK_URL` + orchestrator démarré (provider réel ou `none`).

Windows (PowerShell) :
```powershell
cd orchestrator
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:BACKEND_BASE_URL = "http://localhost:8000"
$env:LLM_PROVIDER = "none"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

Dans le backend, configurer `STUDIO_LLM_WEBHOOK_URL=http://localhost:8010/webhook/llm`.

---

## 5) Architecture fonctionnelle

## 5.1 Frontend (studio + workspace)

Entrées principales :
- `frontend/src/App.tsx` : shell principal (workspace + navigation).
- `frontend/src/StudioApp.tsx` : studio 3D.

### Dossiers importants
- `frontend/src/components/` : UI métier (CatalogPanel, PlanogramEditor, SimulationPanel, StudioAssistant, etc.).
- `frontend/src/store/` : stores Zustand (`sceneStore`, `planogramStore`, `simulationStore`, `assetStore`, etc.).
- `frontend/src/engine/` : logique pure testée (collision, ancrage mobilier, métriques, simulation playback, etc.).
- `frontend/src/three/` : rendu 3D et overlays (SceneEditor, SimulationLayer).
- `frontend/src/api/` : clients HTTP typés pour backend/platform.

### Ce qu’il faut retenir
- Les fonctions dans `engine/` sont le meilleur point d’entrée pour corriger une règle métier.
- Les stores Zustand sont la source de vérité côté client.
- Le rendu 3D lit l’état et ne doit pas contenir de logique métier complexe.

## 5.2 Backend (API + métier + stockage)

Entrée principale : `backend/main.py`
- configure FastAPI/CORS,
- initialise démo + schéma plateforme,
- monte les routeurs (`cad_projects`, `platform`, `furniture_library`, `projects`),
- gère la session courante par middleware.

### Routeurs
- `backend/api/cad_projects.py` : cœur CAD (scène, mobilier, catalogue, planogrammes, simulation, assistant studio).
- `backend/api/platform.py` : auth/session, dashboard workspace, ressources tenant (catalogues, layouts, datasets), import/export, logs.
- `backend/api/furniture_library.py` : lecture bibliothèque mobilier.
- `backend/api/projects.py` : endpoints legacy (viewer historique).

### Services critiques
- `backend/services/project_manager.py` : I/O JSON sécurisé, validation chemins, écriture atomique.
- `backend/services/platform_service.py` : multi-tenant, utilisateurs, sessions, ressources workspace.
- `backend/services/simulation.py` et `live_simulation.py` : batch/live simulation.
- `backend/services/llm_assistant.py` : bridge webhook LLM côté backend.
- `backend/services/walkable_partition.py` : partition des zones navigables.
- `backend/services/pedestrian_import.py` + `pickup_planning.py` : import CSV piétons/paniers et mapping EAN→positions.

### Modèles
- `backend/models/project.py` contient la majorité des schémas Pydantic (scène, planogrammes, simulation, import/export).

## 5.3 Orchestrateur (agent externe)

Entrée : `orchestrator/app/main.py`
- endpoint `POST /webhook/llm`,
- session requise via `X-ShopAI-Session`,
- exécution via `ShopAIOrchestrator`.

Pipeline global :
1. recevoir demande + session,
2. générer un plan borné,
3. retourner un aperçu (preview),
4. exécuter uniquement après confirmation.

Ce service est découplé du backend métier et peut être arrêté sans bloquer le mode assistant local.

---

## 6) Modèle de données (vision reprise)

Le stockage projet est principalement JSON, dossier par projet.
Fichiers usuels par projet :
- `project.json`
- `scene.json`
- `catalog.json`
- `planograms.json`
- `materials.json`
- `settings.json`
- `pedestrians.json` (si simulation/import piétons)

Principes :
- unités en centimètres pour la géométrie,
- identifiants stables (UUID/IDs),
- séparation claire scène / catalogue / planogrammes,
- validation stricte par Pydantic côté backend et types TS côté frontend.

---

## 7) API opérationnelle (résumé)

## 7.1 CAD (`/api/cad/projects`)
- CRUD projets
- lecture/édition scène + mobilier
- lecture/édition catalogue + import
- lecture/édition planogrammes
- simulation batch/live
- import datasets piétons sur projet
- assistant studio (`/assistant` et `/assistant/llm`)
- pré-requis `/assistant/llm` : webhook backend configuré via `STUDIO_LLM_WEBHOOK_URL`
- endpoints clés :
  - `GET /api/cad/projects/`
  - `POST /api/cad/projects/`
  - `GET /api/cad/projects/{id}/scene`
  - `PUT /api/cad/projects/{id}/scene/store`
  - `POST /api/cad/projects/{id}/scene/furniture`
  - `GET|POST|PUT|DELETE /api/cad/projects/{id}/planograms...`
  - `POST /api/cad/projects/{id}/simulation/live/start`
  - `POST /api/cad/projects/{id}/simulation/live/{session_id}/tick`
  - `GET /api/cad/projects/{id}/simulation/live/{session_id}/analytics`

## 7.2 Platform (`/api/platform`)
- auth/password + OAuth + session
- dashboard workspace
- catalogues/layouts/simulations/datasets (create/list/get/delete/import/download)
- logs client
- capacités guide agent
- règle de flux recommandée : import catalogue au niveau workspace (`/api/platform/catalogs/import-json`) ; l’import catalogue projet (`/api/cad/projects/{id}/catalog/import`) reste surtout destiné à l’automatisation agent.
- endpoints clés :
  - `POST /api/platform/auth/login`
  - `GET /api/platform/dashboard`
  - `POST|GET|DELETE /api/platform/catalogs...`
  - `POST|GET|DELETE /api/platform/store-layouts...`
  - `POST /api/platform/store-layouts/import-osm`
  - `POST|GET|DELETE /api/platform/pedestrian-datasets...`
  - `POST /api/platform/pedestrian-datasets/import-csv`

## 7.3 Bibliothèque mobilier (`/api/furniture-library`)
- liste des types mobilier
- détail d’un type
- endpoints : `GET /api/furniture-library/`, `GET /api/furniture-library/{type}`

## 7.4 Legacy (`/api/projects`)
- endpoints historiques de visualisation
- exemples : `GET /api/projects/{project_id}/store`, `GET /api/projects/{project_id}/products`

---

## 8) Workflows métier clés

## 8.1 Workflow standard utilisateur
1. Importer ressources workspace (catalogues / implantations / datasets).
2. Créer un projet en liant les ressources nécessaires.
3. Travailler dans le studio 3D : mobilier + planogrammes.
4. Lancer simulation et analyser résultats.
5. Exporter projet/layout/datasets selon besoin.

## 8.2 Workflow assistant
- Assistant local déterministe : `POST /assistant`.
- Assistant LLM externe (optionnel) : `POST /assistant/llm` si webhook configuré.
- Les écritures annoncées par l’agent sont auditées côté backend.

## 8.3 Workflow simulation
- config des waypoints/systèmes,
- démarrage session live,
- tick/update/pause/resume,
- analytics cumulés (heatmap, trajectoires, etc.),
- arrêt de session.

---

## 9) Tests, lint et build (commandes de référence)
Chaque bloc ci-dessous est autonome et doit être exécuté depuis le répertoire indiqué.

## 9.1 Frontend
```bash
cd frontend
npm run lint
npm run build
npx vitest run
```

Le projet ne fournit pas encore de script npm `test` dédié ; `npx vitest run` est la commande de référence actuelle.

## 9.2 Backend
```bash
cd backend
python -m pytest
```

## 9.3 Orchestrator
Pas de commande de validation orchestrator imposée dans le flux standard de ce dépôt.  
Pour une validation orchestrator adaptée à votre environnement, se référer à `orchestrator/README.md`.

---

## 10) Guide “où modifier quoi”

- **Bug UI/composant** : `frontend/src/components/*`
- **Bug de logique pure (calcul)** : `frontend/src/engine/*` + tests associés
- **Bug de synchronisation état** : `frontend/src/store/*`
- **Bug 3D/rendu** : `frontend/src/three/*`
- **API métier CAD** : `backend/api/cad_projects.py`
- **Ressources workspace / auth / tenant** : `backend/api/platform.py` + `services/platform_service.py`
- **Persistance projet** : `backend/services/project_manager.py`
- **Simulation** : `backend/services/simulation.py` + `live_simulation.py`
- **Comportement agent externe** : `orchestrator/app/*` + `backend/services/llm_assistant.py`

---

## 11) Points de vigilance de reprise

1. **Multi-tenant/session** : ne jamais bypass les contrôles d’accès dans `platform_service`.
2. **Persistance JSON** : conserver l’écriture atomique et les validations de chemin (anti traversal).
3. **Assistant externe** : URL webhook configurée côté serveur uniquement, jamais côté client.
4. **Simulation live** : respecter les contrats API (tick/update) et la cohérence des systèmes de waypoints.
5. **Planogrammes** : préserver les invariants d’ancrage/placement pour éviter les régressions visuelles.
6. **Imports** : garder les validations Pydantic et audits backend après écriture.

---

## 12) Documentation complémentaire

- `ARCHITECTURE.md` : vue architecture détaillée (vision + principes).
- `DEEP_DIVE.md` : stratégie et détails techniques approfondis.
- `METRIQUES.md` : métriques métier et définition des indicateurs.
- `AI_WORKFLOW_README.md` : flux IA complet (assistant local + webhook + Astra).
- `orchestrator/README.md` : installation et exploitation orchestrateur.
- `scripts/README.md` : scripts d’automatisation/pilotage.

---

## 13) Plan de prise en main recommandé (nouvel arrivant)

Semaine de reprise (ordre conseillé) :
1. Lancer backend + frontend et valider le parcours de base.
2. Lire `backend/api/cad_projects.py` puis `frontend/src/api/cad.ts`.
3. Lire `sceneStore.ts`, `planogramStore.ts`, `simulationStore.ts`.
4. Lire `project_manager.py` + `platform_service.py`.
5. Exécuter tests frontend et backend.
6. Étudier `orchestrator/app/agent.py` si mode LLM requis.

Ce parcours permet d’être autonome rapidement sur les incidents production et les évolutions fonctionnelles.
