# Workflow IA ShopAI — implémentation actuelle

Ce document décrit le workflow IA **tel qu'il est réellement implémenté dans ce dépôt** : UI studio, backend métier, proxy LLM externe, orchestrateur et pilote Astra.

## Vue d'ensemble

Le produit expose aujourd'hui **3 chemins IA distincts** :

1. **Assistant local du studio**  
   Endpoint : `POST /api/cad/projects/{id}/assistant`  
   Nature : déterministe, sans provider LLM.

2. **Assistant LLM externe via webhook**  
   Endpoints :  
   - `GET /api/cad/projects/{id}/assistant/llm/status`
   - `POST /api/cad/projects/{id}/assistant/llm`  
   Nature : le backend relaie vers un orchestrateur externe configuré **côté serveur uniquement**.

3. **Pilote agent Astra**  
   Script : `scripts/astra_build_store.py`  
   Nature : pipeline REST déterministe de bout en bout, sans chat UI.

---

## 1. Workflow IA côté interface Studio

### Point d'entrée frontend

Le chat est implémenté dans :

- `frontend/src/components/StudioAssistant.tsx`

Le composant impose :

- un `projectId` courant ;
- une **catégorie obligatoire** avant envoi :
  - `layout-modify`
  - `layout-create`
  - `assortment-modify`
  - `assortment-full`
  - `freestyle`
- un prétest LLM au chargement via `cadApi.getLlmAssistantStatus(projectId)`.

### Sélection du mode local vs LLM

La décision frontend est simple :

- `GET /assistant/llm/status`
- si `enabled && reachable` ⇒ envoi vers `/assistant/llm`
- sinon ⇒ fallback automatique vers `/assistant`

La règle est centralisée dans :

- `frontend/src/engine/assistantRouting.ts`

### Contrat frontend → backend

#### Assistant local

```json
{
  "prompt": "Recommandation d'implantation",
  "confirm": false
}
```

#### Assistant LLM externe

```json
{
  "prompt": "Projet complet: supérette urbaine",
  "confirm": false,
  "category": "freestyle",
  "confirmationToken": null
}
```

Le contrat TypeScript est défini dans :

- `frontend/src/api/cad.ts`

### Boucle UX

1. L'utilisateur ouvre un projet 3D.
2. Le frontend teste la disponibilité du chemin LLM externe.
3. L'utilisateur choisit une catégorie.
4. Il envoie un prompt.
5. Le frontend appelle soit `/assistant`, soit `/assistant/llm`.
6. Le backend répond avec :
   - `message`
   - `requiresConfirmation`
   - `changed`
   - `projectId` optionnel
   - `steps`
   - `confirmationToken` optionnel
7. Si `requiresConfirmation=true`, le frontend garde le contexte en mémoire et affiche un CTA de confirmation.
8. Si `changed=true` et `projectId` est présent, le frontend recharge/ouvre le projet retourné.

---

## 2. Assistant local intégré (`/assistant`)

### Point d'entrée backend

- `backend/api/cad_projects.py`
- fonction `studio_assistant(...)`

Le moteur est dans :

- `backend/services/studio_assistant.py`

### Ce qu'il fait réellement

Cet assistant **n'appelle aucun LLM**.  
Il interprète un sous-ensemble borné de commandes via normalisation de texte et règles métier.

Il sait notamment :

- relire l'état persistant ;
- auditer le projet enregistré ;
- produire une recommandation de placement catalogue → planogrammes ;
- cloner des templates de référence distribués ;
- préparer un aperçu avant confirmation.

### Garanties côté local

- accès utilisateur/projet vérifié avant traitement ;
- templates de référence pinés par digest SHA-256 ;
- validation Pydantic des snapshots ;
- audit métier après relecture des fichiers persistés ;
- aucune dépendance à un provider externe.

### Limite importante

Le local assistant n'est pas un agent libre : il reste un moteur déterministe à intentions connues.

---

## 3. Assistant LLM externe (`/assistant/llm`)

### Point d'entrée backend

- `backend/api/cad_projects.py`
- fonction `studio_assistant_llm(...)`

La logique de proxy est dans :

- `backend/services/llm_assistant.py`

### Principe

Le backend ShopAI :

1. vérifie l'accès au projet ;
2. lit le cookie de session ShopAI ;
3. transfère la requête à un webhook externe configuré par `STUDIO_LLM_WEBHOOK_URL` ;
4. revalide strictement la réponse ;
5. ré-audite le projet persistant si l'orchestrateur déclare une écriture.

### Configuration

Variables serveur :

- `STUDIO_LLM_WEBHOOK_URL`
- `STUDIO_LLM_WEBHOOK_TIMEOUT_SECONDS`

L'URL du webhook **n'est jamais fournie par le client**, ce qui évite d'ouvrir un vecteur SSRF.

### Authentification

Le backend transmet seulement :

- `X-ShopAI-Session: <session utilisateur>`

Il n'y a **pas de secret partagé** entre backend et orchestrateur.  
Le backend et l'orchestrateur revalident tous deux :

- existence de la session ;
- expiration ;
- accès tenant/projet.

### Contrat backend → orchestrateur

```json
{
  "projectId": "<id>",
  "prompt": "<texte libre>",
  "confirm": false,
  "category": "layout-create",
  "confirmationToken": "<optionnel>"
}
```

### Contrat attendu en retour

```json
{
  "message": "...",
  "requiresConfirmation": true,
  "changed": false,
  "projectId": "<id ou null>",
  "steps": ["..."],
  "confirmationToken": "<opaque>"
}
```

Les champs inconnus sont refusés.  
Une écriture déclarée sans confirmation est refusée.  
Une réponse mal formée remonte en `502`.

### Post-audit obligatoire

Si l'orchestrateur répond :

- `changed: true`
- avec `projectId`

alors le backend relit les fichiers persistés et appelle :

- `studio_assistant.audit_persisted_project(...)`

Conséquence :

- le backend **ne fait jamais confiance** à la seule auto-déclaration de succès de l'agent externe ;
- les anomalies d'audit sont remontées dans `steps`.

---

## 4. Orchestrateur externe fourni dans le dépôt

### Emplacement

- `orchestrator/`

### Entrée HTTP

- `POST /webhook/llm`

### Rôle

L'orchestrateur :

1. lit le projet courant via l'API backend ;
2. construit un contexte borné (projet + bibliothèque mobilier) ;
3. demande un plan au provider configuré ;
4. compile ce plan en opérations REST validées ;
5. retourne un **aperçu** ;
6. n'exécute les écritures qu'après **confirmation explicite**.

### Fichiers clés

- `app/agent.py` : cycle preview/confirm, binding à la session, jetons
- `app/llm.py` : planification provider
- `app/workflow.py` : compilation/validation des opérations
- `app/tools.py` : appels backend authentifiés
- `app/schemas.py` : contrats Pydantic

### Modèle d'exécution

#### Phase 1 — preview

- aucune écriture ;
- lecture projet + mobilier ;
- génération d'un plan borné ;
- compilation en opérations REST ;
- stockage d'un aperçu en mémoire avec expiration.

#### Phase 2 — confirm

- le client renvoie le même `projectId`, `prompt`, `category`, la même session et le `confirmationToken` ;
- l'orchestrateur revalide l'accès et l'empreinte de l'état ;
- les opérations déjà résolues sont exécutées séquentiellement ;
- le LLM **n'est pas rappelé** à la confirmation.

### Jetons de confirmation

Les aperçus sont :

- opaques ;
- signés ;
- à usage unique ;
- valides 10 minutes ;
- liés à `projectId + prompt + category + session`.

La clé de signature est **process-locale**.  
Un redémarrage de l'orchestrateur invalide donc les aperçus en attente.

### Intentions actuellement cadrées

- `layout-create`
- `layout-modify`
- `assortment-full`
- `assortment-modify`
- `freestyle`

Le mode `freestyle` reste borné : il choisit une intention supportée, pas une liberté d'écriture illimitée.

### Écriture et sécurité

- aucune écriture pendant le preview ;
- aucune correction silencieuse ;
- pas de retry automatique sur écriture ;
- les appels REST sont séquentiels, non transactionnels ;
- l'export `retail-layout` est relu en fin d'exécution confirmée.

---

## 5. Pilote Astra (`scripts/astra_build_store.py`)

Le script Astra est le chemin le plus simple pour une automatisation IA **déterministe**.

### Ce qu'il exécute

1. `GET /`
2. `POST /api/cad/projects/`
3. `GET /api/furniture-library/`
4. `PUT /api/cad/projects/{id}/scene/store`
5. `POST /api/cad/projects/{id}/scene/furniture`
6. `POST /api/cad/projects/{id}/catalog/import`
7. `POST /api/cad/projects/{id}/planograms`
8. `GET /api/cad/projects/{id}/export/retail-layout`

### Usage produit

Ce script sert à :

- documenter la séquence correcte d'appels API ;
- fournir un exemple d'agent sans dépendance LLM ;
- établir une baseline stable pour des agents tool-calling.

### Deux modes de layout

- layout généré par le script (`plan_layout`)
- layout fourni par l'utilisateur via `--layout`

---

## 6. Flux de données et persistance

Le workflow IA agit sur les ressources du projet CAD :

- `scene.json`
- `catalog.json`
- `planograms.json`
- `materials.json`
- `settings.json`
- `textures.json`

Le local assistant et le post-audit externe relisent cet état persistant ; ils ne se basent pas seulement sur l'état volatile du frontend.

---

## 7. Séquence recommandée en production

### Cas A — besoin simple et robuste

Utiliser Astra ou un agent REST borné suivant les 8 étapes.

### Cas B — chat assistant dans l'UI

1. configurer `STUDIO_LLM_WEBHOOK_URL` côté backend ;
2. démarrer l'orchestrateur ;
3. configurer le provider LLM dans l'orchestrateur ;
4. laisser le frontend utiliser le prétest `/assistant/llm/status` ;
5. travailler en cycle `preview -> confirm -> post-audit`.

### Cas C — sans LLM externe

Utiliser uniquement `/assistant` pour :

- audit ;
- vérification ;
- recommandations déterministes ;
- création depuis templates supportés.

---

## 8. Comportements importants à connaître

- le frontend ne choisit jamais une URL de webhook ;
- le fallback local est automatique si le chemin LLM n'est pas joignable ;
- la confirmation est obligatoire pour les écritures orchestrées ;
- un projet modifié entre preview et confirm invalide l'aperçu ;
- un succès d'agent externe peut encore être marqué comme douteux si l'audit persistant détecte des anomalies ;
- le workflow complet repose sur l'API backend existante, pas sur des écritures directes en base par le LLM.

---

## 9. Fichiers à lire pour aller plus loin

- `frontend/src/components/StudioAssistant.tsx`
- `frontend/src/api/cad.ts`
- `frontend/src/engine/assistantRouting.ts`
- `backend/api/cad_projects.py`
- `backend/services/studio_assistant.py`
- `backend/services/llm_assistant.py`
- `orchestrator/README.md`
- `orchestrator/app/agent.py`
- `scripts/astra_build_store.py`
- `scripts/README.md`
