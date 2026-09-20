# ShopAI Orchestrator (microservice séparé)

Service FastAPI indépendant du backend métier ShopAI.
Il prépare un plan borné via OpenAI, Anthropic, xAI ou OpenRouter, puis exécute
uniquement les écritures REST annoncées et confirmées. Le mode `LLM_PROVIDER=none`
est explicitement déterministe; il ne sait pas interpréter des modifications libres.

## Architecture

```
orchestrator/
  app/
    main.py      # API FastAPI + webhook /webhook/llm
    agent.py     # orchestration pipeline + gestion confirm
    tools.py     # callbacks authentifiés, retries des lectures uniquement
    workflow.py  # validation et résolution des opérations avant confirmation
    llm.py       # planification provider, sans fallback en cas d'erreur
    prompts.py   # system prompt + spec outil build_store_plan
    schemas.py   # modèles Pydantic webhook/plan
    config.py    # variables d'environnement
  .env.example
  requirements.txt
  README.md
```

## Contrat webhook

### Entrée (`POST /webhook/llm`)

```json
{
  "projectId": "<id projet studio courant>",
  "prompt": "Créer implantation: supermarché de 400m²",
  "confirm": false,
  "category": "layout-create"
}
```

### Sortie (compatible backend `/assistant/llm`)

```json
{
  "message": "...",
  "requiresConfirmation": true,
  "changed": false,
  "projectId": "...",
  "steps": ["..."],
  "confirmationToken": "<jeton opaque retourné par l'aperçu>"
}
```

## Installation

```bash
cd /home/runner/work/shopAi/shopAi/orchestrator
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Lancement

```bash
cd /home/runner/work/shopAi/shopAi/orchestrator
source .venv/bin/activate
set -a; source .env; set +a
uvicorn app.main:app --host 0.0.0.0 --port 8010 --reload
```

Health check orchestrateur:

```bash
curl http://localhost:8010/
```

## Connexion avec le backend ShopAI

Dans le process backend (`/home/runner/work/shopAi/shopAi/backend`), configure:

```bash
export STUDIO_LLM_WEBHOOK_URL="http://localhost:8010/webhook/llm"
export STUDIO_LLM_WEBHOOK_TOKEN="change-me"
```

Puis dans l'orchestrateur (`.env`):

```bash
WEBHOOK_AUTH_TOKEN=change-me
BACKEND_BASE_URL=http://localhost:8000
```

Le backend transmet aussi `X-ShopAI-Session` au webhook. Chaque callback reprend cette
session **et** le secret `WEBHOOK_AUTH_TOKEN` dans le header `Authorization`. Les deux valeurs
sont obligatoires; sans secret configuré, le webhook refuse les requêtes.

### Intentions prises en charge

- `layout-create`: nouveau projet et implantation, sans produits. Le catalogue
  initial fourni par le backend est vidé; cette opération figure dans l'aperçu.
- `layout-modify`: dimensions, ajout/déplacement/redimensionnement/suppression de
  mobilier dans le projet courant. Une suppression annonce ses planogrammes associés.
- `assortment-full`: catalogue fusionné par EAN et grilles complètes sur le mobilier
  existant. Les faces déjà équipées sont mises à jour, sans duplication.
- `assortment-modify`: produits et grilles explicitement ciblés; les autres données
  sont conservées. Une grille ciblée est remplacée en entier.
- `freestyle` ou catégorie absente: le LLM choisit une intention bornée; une demande
  explicite de magasin complet peut créer un nouveau projet avec implantation et
  assortiment (`build_complete_store`, compatibilité historique).
  Dans ce nouveau projet seulement, le catalogue initial du backend est remplacé
  par le nombre exact de produits annoncé dans l'aperçu.

Le LLM reçoit le contexte existant et la bibliothèque de mobilier. Les dimensions,
rotations, collisions, IDs, EAN, coordonnées et limites de volume sont validés avant
l'aperçu. Aucune correction silencieuse ni écriture n'est faite pendant l'aperçu.
Sans produits explicites, l'assortiment complet utilise le catalogue courant ou
`CATALOG_JSON_PATH`/`assortment.json`; aucun produit fictif n'est généré.
Un catalogue courant plus grand que la limite du plan (200 par défaut, 500 maximum)
est refusé explicitement: il n'est jamais tronqué silencieusement. Une sélection
partielle doit être fournie explicitement par le plan et son volume apparaît dans
l'aperçu; le reste du catalogue est conservé.

### Confirmation

Renvoyer exactement `projectId`, `prompt`, `category`, la même session et le
`confirmationToken` reçu, avec `confirm=true`. L'orchestrateur réutilise les
opérations résolues (IDs, produits, coordonnées), sans rappeler le LLM. Un projet
modifié entre-temps exige un nouvel aperçu.

Les jetons signés sont opaques, à usage unique et valables dix minutes. Ils ne
contiennent ni secret ni session. Les plans sont conservés en mémoire (128 maximum):
utiliser un seul worker, ou une affinité de routage. Un redémarrage/autre worker
invalide l'aperçu et impose d'en générer un nouveau; il ne relance jamais le plan.

## Exemples d'appel

Dans ces exemples, `AUTHORIZATION_HEADER` contient la valeur complète du header
d'authentification, construite avec le secret partagé.

### Preview (sans écriture)

```bash
curl -X POST http://localhost:8010/webhook/llm \
  -H 'Content-Type: application/json' \
  -H "Authorization: $AUTHORIZATION_HEADER" \
  -H 'X-ShopAI-Session: <session-cookie-value>' \
  -d '{
    "projectId": "demo",
    "prompt": "Projet complet: supermarché 400 m²",
    "confirm": false
  }'
```

### Exécution pipeline complet

```bash
curl -X POST http://localhost:8010/webhook/llm \
  -H 'Content-Type: application/json' \
  -H "Authorization: $AUTHORIZATION_HEADER" \
  -H 'X-ShopAI-Session: <session-cookie-value>' \
  -d '{
    "projectId": "demo",
    "prompt": "Projet complet: supermarché 400 m²",
    "confirm": true,
    "confirmationToken": "<jeton reçu lors de cet aperçu>"
  }'
```

## Notes d'erreurs

- **409/422**: arrêt sans décalage, remplacement de paramètres ni répétition.
- **timeouts/réseau**: lectures réessayées de manière bornée; aucune écriture
  réessayée, même après une réponse perdue.
- **Échec partiel**: les étapes réussies, le projet réellement créé/modifié et
  `changed=true` sont conservés. Une écriture de résultat incertain est signalée
  comme potentiellement appliquée. Vérifier avant de refaire un aperçu.
- Les écritures REST sont séquentielles, pas transactionnelles; une erreur
  n'annule pas les étapes précédentes. La relecture avant confirmation détecte
  les modifications antérieures, mais ne remplace pas un verrou distribué.
- Une panne fournisseur, une clé absente ou un plan invalide ne bascule jamais
  vers un magasin générique.

## Variables d'environnement

- `BACKEND_BASE_URL`
- `LLM_PROVIDER` (`none`, `openai`, `anthropic`, `xai`, `openrouter`)
- `OPENAI_API_KEY`, `OPENAI_MODEL`
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- `XAI_API_KEY`, `XAI_MODEL`
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`
- `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_TITLE` (optionnels)
- `WEBHOOK_AUTH_TOKEN`
- `REQUEST_TIMEOUT_SECONDS`
- `MAX_RETRIES`
- `COLLISION_MAX_RETRIES`, `COLLISION_OFFSET_CM` (compatibilité de configuration;
  les écritures confirmées ne sont plus déplacées/réessayées)
- `CATALOG_JSON_PATH`
