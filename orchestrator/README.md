# ShopAI Orchestrator (microservice séparé)

Service FastAPI indépendant du backend métier ShopAI.
Il reçoit les prompts utilisateur (webhook), prépare un plan d'exécution (heuristique + optional LLM tool-calling), puis exécute le pipeline REST 8 étapes.

## Architecture

```
orchestrator/
  app/
    main.py      # API FastAPI + webhook /webhook/llm
    agent.py     # orchestration pipeline + gestion confirm
    tools.py     # wrappers HTTP backend + retries 409/422
    llm.py       # planification provider (OpenAI/Anthropic/xAI/OpenRouter) + fallback heuristique
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
  "confirm": false
}
```

### Sortie (compatible backend `/assistant/llm`)

```json
{
  "message": "...",
  "requiresConfirmation": true,
  "changed": false,
  "projectId": "...",
  "steps": ["..."]
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

Le backend transmet aussi `X-ShopAI-Session` au webhook; l'orchestrateur le réutilise pour rappeler l'API backend au nom de l'utilisateur.

## Exemples d'appel

### Preview (sans écriture)

```bash
curl -X POST http://localhost:8010/webhook/llm \
  -H 'Content-Type: application/json' \
  -H 'Authorization: ******' \
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
  -H 'Authorization: ******' \
  -H 'X-ShopAI-Session: <session-cookie-value>' \
  -d '{
    "projectId": "demo",
    "prompt": "Projet complet: supermarché 400 m²",
    "confirm": true
  }'
```

## Notes d'erreurs

- **409 collision mobilier**: retry avec décalage progressif X/Z.
- **422 payload invalide**: normalisation/correction puis retry.
- **timeouts/réseau**: retries bornés et message d'échec explicite.

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
- `COLLISION_MAX_RETRIES`
- `COLLISION_OFFSET_CM`
- `CATALOG_JSON_PATH`
