# Pilote Astra — construction d'un magasin de zéro via l'API REST

`astra_build_store.py` est le **pilote agent IA** du projet : il exécute, dans l'ordre
et sans erreur, la séquence exacte d'appels API qu'Astra (ou n'importe quel LLM avec
tool calling) doit suivre pour créer un magasin complet — dimensions, mobilier,
catalogue produit et planogrammes — à partir d'un catalogue fourni.

Il ne modifie **aucun code produit** : il dialogue uniquement avec le backend via
HTTP, en utilisant exclusivement la bibliothèque standard Python (aucune dépendance
supplémentaire).

---

## Prérequis

- Python 3.11+
- Le backend en cours d'exécution :

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app          # écoute sur http://localhost:8000
```

- Un catalogue produit JSON (par défaut `assortment.json` à la racine du dépôt).

## Utilisation

```bash
# Depuis la racine du dépôt
python scripts/astra_build_store.py \
    --api http://localhost:8000 \
    --name "Magasin Astra" \
    --catalog assortment.json \
    --max-products 200 \
    --pause 0
```

Sortie attendue (résultat validé) : **28 meubles placés sans collision, 200 produits
importés, 40 planogrammes, 960 slots produits** avec positions absolues en cm, code
de sortie `0`.

### Options

| Option | Défaut | Description |
|---|---|---|
| `--api` | `http://localhost:8000` | URL de base du backend |
| `--name` | `Magasin Astra` | Nom du projet créé |
| `--catalog` | `assortment.json` | Chemin du catalogue produit fourni (JSON) |
| `--max-products` | `200` | Nombre de produits importés depuis le catalogue |
| `--pause` | `0` | Secondes d'attente entre chaque étape (visualisation / capture vidéo) |

---

## Le pipeline en 8 étapes

Chaque étape est loggée sur stdout au format `[n/8 étape] message`.

| # | Étape | Appel API |
|---|---|---|
| 1 | Health check | `GET /` |
| 2 | Création du projet | `POST /api/cad/projects/` |
| 3 | Dimensions du magasin (3000×2000×400 cm) | `PUT /api/cad/projects/{id}/scene/store` |
| 4 | Lecture de la bibliothèque mobilier | `GET /api/furniture-library/` |
| 5 | Placement du mobilier (sans chevauchement) | `POST /api/cad/projects/{id}/scene/furniture` |
| 6 | Import du catalogue produit | `POST /api/cad/projects/{id}/catalog/import` |
| 7 | Création des planogrammes par face | `POST /api/cad/projects/{id}/planograms` |
| 8 | Vérification finale | `GET /api/cad/projects/{id}/export/retail-layout` |

Toutes les coordonnées sont en **cm**, origine au **coin bas-gauche** du magasin.

### Plan d'implantation (étape 5)

Le layout est calculé sur une grille déterministe (`plan_layout`) pour ne jamais
déclencher la garde anti-chevauchement du backend :

- **Mur du fond** : 6 frigos verticaux côte à côte ;
- **Allées centrales** : 3 rangées de 5 gondoles doubles, allées de 180 cm ;
- **Mur gauche** : 4 gondoles simples murales ;
- **Entrée (avant droit)** : 3 caisses.

Les dimensions proviennent toujours des `defaultDimensions` de la bibliothèque
mobilier — jamais inventées.

### Mapping catalogue (étape 6)

`map_assortment_to_products` convertit le format externe (`assortment.json`) vers le
schéma `Product` du backend :

| Champ externe | Champ `Product` |
|---|---|
| `barcode` | `ean` |
| `product_name` | `name` |
| `brand` | `brand` |
| `category_id` / `subcategory_id` | `category` / `subcategory` |
| `cost_price_eur` | `priceBuyEur` |
| `suggested_price_eur` | `priceSellEur` |
| `margin_rate_pct` | `marginPct` |
| `image_url` | `imageUrl` |

Le catalogue externe ne portant pas de dimensions physiques, des dimensions par
défaut sont appliquées **par catégorie** (`_CATEGORY_DIMENSIONS`). Les doublons
d'EAN et les entrées sans EAN/nom sont ignorés.

### Planogrammes (étape 7)

`_FACEABLE_TYPES` définit les faces recevant un planogramme : `front` pour les
gondoles simples et frigos, `front` + `back` pour les gondoles doubles. Chaque
planogramme fait 4 lignes × 6 colonnes ; un curseur parcourt le catalogue pour que
chaque planogramme reçoive des produits différents. Le backend lie automatiquement
la face du meuble au planogramme créé.

### Vérification (étape 8)

L'export retail-layout renvoie `furniture[].placements[].slots[]` : chaque slot
porte l'EAN et sa **position absolue en cm** dans le magasin. Le script compte les
slots et confirme la construction.

---

## Gestion des erreurs (conformité garantie par le serveur)

Le backend valide tout ; l'agent ne peut pas contourner les règles :

- **HTTP 409 — chevauchement mobilier** : le script réessaie une fois avec un
  décalage de +20 cm en x. La stratégie principale reste de calculer un layout qui
  ne déclenche jamais le 409.
- **HTTP 422 — payload invalide** (produit, planogramme, meuble) : erreur explicite
  du backend avec l'index et l'EAN fautif ; le script s'arrête avec le détail.
- **Backend injoignable** : message indiquant comment démarrer le serveur, code de
  sortie `1`.

---

## Visualiser la construction en vidéo

1. Lancez le frontend (`cd frontend && npm run dev`) et gardez le navigateur ouvert.
2. Lancez le script avec `--pause 2` (ou plus) : chaque étape est espacée, la
   construction devient filmable.
3. Enregistrez l'écran (OBS, capture d'onglet Chrome). Rechargez le projet dans le
   frontend pendant la capture pour voir la scène évoluer (le frontend ne rafraîchit
   pas encore la scène automatiquement).

---

## Brancher Astra (ou tout autre agent)

Le script sert de **référence exécutable** de la procédure sans erreur. Pour un
branchement agent :

- **Tool calling direct** : donner à l'agent le schéma OpenAPI auto-généré par
  FastAPI (`GET /openapi.json`, Swagger sur `/docs`) comme définition d'outils, et
  la séquence des 8 étapes ci-dessus comme procédure.
- **Serveur MCP façade** (hors produit) : exposer chaque endpoint REST comme outil
  MCP ; l'agent dialogue avec le MCP, le MCP appelle l'API HTTP.
- Dans les deux cas, la boucle d'auto-correction est la même : réagir aux 409/422 et
  vérifier via `export/retail-layout` (et éventuellement `simulation/run`).
