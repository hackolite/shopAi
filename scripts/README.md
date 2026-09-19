# Pilote Astra — construction complète d'un magasin via l'API REST

`astra_build_store.py` est le **pilote agent IA** du projet : il exécute la
séquence complète d'appels API nécessaire pour créer un magasin de zéro, sans
modifier le code produit. Il parle uniquement au backend HTTP avec la
bibliothèque standard Python.

Il sert à la fois de :

- **script exécutable** pour construire un magasin de démonstration ;
- **procédure de référence** pour brancher Astra ou tout autre agent LLM ;
- **base de calcul de coût et d'exploitation** pour une création pilotée par IA.

---

## Ce que fait exactement l'agent

Le pipeline couvre la création complète d'un magasin :

1. vérifie que le backend répond ;
2. crée un projet ;
3. lit la bibliothèque de mobilier disponible ;
4. définit les dimensions du magasin ;
5. place le mobilier sans chevauchement ;
6. importe un catalogue produit ;
7. crée les planogrammes face par face ;
8. vérifie le résultat via l'export `retail-layout`.

Le résultat attendu pour la configuration par défaut est un magasin complet avec
mobilier, catalogue et planogrammes prêts à être ouverts dans le frontend.

## Ce que ce pilote ne fait pas

- il **n'appelle aucun provider LLM** lui-même ;
- il **ne gère aucune clé OpenAI / Anthropic / Gemini** dans le dépôt ;
- il **n'ajoute pas d'authentification** au backend ;
- il **ne choisit pas dynamiquement la stratégie merchandising** : le layout et
  les planogrammes par défaut sont déterministes.

Autrement dit, le dépôt fournit le **backend métier** et un **pilote de
référence** ; le choix du modèle, des clés et de l'orchestration agentique reste
à votre charge si vous branchez un LLM externe.

---

## Prérequis

- Python 3.11+
- Backend lancé localement :

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app
```

- Un catalogue JSON, par défaut `assortment.json` à la racine du dépôt.
- Facultatif : frontend lancé pour visualiser la construction en direct.

```bash
cd frontend
npm install
npm run dev
```

- Documentation interactive de l'API : `http://localhost:8000/docs`
- Schéma OpenAPI brut : `http://localhost:8000/openapi.json`

> Côté produit, le flux recommandé reste : **importer les catalogues dans le
> workspace**, puis **sélectionner le catalogue à la création du projet**. Les
> imports catalogue directs dans un projet sont surtout utiles pour
> l'automatisation pilotée par agent.

---

## Démarrage rapide

```bash
# Depuis la racine du dépôt
python scripts/astra_build_store.py \
    --api http://localhost:8000 \
    --name "Magasin Astra" \
    --catalog assortment.json \
    --max-products 200 \
    --pause 0
```

Sortie validée attendue : **28 meubles placés sans collision, 200 produits
importés, 40 planogrammes, 960 slots produits** avec positions absolues en cm,
code de sortie `0`.

---

## Quelle API est utilisée ?

Le pilote utilise **uniquement l'API REST du backend de ce dépôt**.

### Endpoints appelés par le pipeline

| # | Étape | Appel API | Rôle |
|---|---|---|---|
| 1 | Health check | `GET /` | Vérifier que le backend répond |
| 2 | Création du projet | `POST /api/cad/projects/` | Obtenir l'`id` du projet |
| 3 | Bibliothèque mobilier | `GET /api/furniture-library/` | Récupérer les types et dimensions par défaut |
| 4 | Dimensions du magasin | `PUT /api/cad/projects/{id}/scene/store` | Définir largeur / profondeur / hauteur |
| 5 | Placement mobilier | `POST /api/cad/projects/{id}/scene/furniture` | Ajouter chaque meuble |
| 6 | Import catalogue | `POST /api/cad/projects/{id}/catalog/import` | Charger les produits dans le projet |
| 7 | Création planogrammes | `POST /api/cad/projects/{id}/planograms` | Associer des produits aux faces du mobilier |
| 8 | Vérification finale | `GET /api/cad/projects/{id}/export/retail-layout` | Contrôler le résultat consolidé |

### Combien d'appels API faut-il prévoir ?

Le coût technique côté backend est simple à estimer :

- **4 appels fixes** au début (`/`, création projet, bibliothèque, store) ;
- **1 appel par meuble** placé ;
- **1 appel** pour l'import catalogue ;
- **1 appel par planogramme** créé ;
- **1 appel final** de vérification.

Formule générale :

`total = 4 + nb_meubles + 1 + nb_planogrammes + 1`

Configuration par défaut du pilote :

- `28` meubles ;
- `40` planogrammes ;
- donc **74 requêtes HTTP** au total.

---

## Comment brancher un agent ?

Il y a deux façons réalistes de se plugger.

### Option 1 — Utiliser directement le script de référence

C'est l'option la plus simple si vous voulez un résultat fiable immédiatement.
Votre agent n'a qu'à lancer le script avec les bons paramètres.

**Avantages :**
- très peu de logique côté agent ;
- comportement stable et reproductible ;
- coût LLM minimal.

**Limites :**
- stratégie fixe ;
- pas de raisonnement dynamique sur le merchandising.

### Option 2 — Tool calling direct sur l'API REST

Exposez à votre agent le schéma `openapi.json` comme définition d'outils. L'agent
appelle alors directement les endpoints REST dans l'ordre des 8 étapes.

**À donner à l'agent :**
- URL du backend ;
- schéma OpenAPI ;
- ordre strict des étapes ;
- règle de vérification finale via `export/retail-layout` ;
- politique de traitement des erreurs `409` et `422`.

**Quand choisir cette option :**
- vous voulez que l'agent décide du layout ;
- vous voulez brancher plusieurs modèles ;
- vous voulez journaliser précisément tous les appels.

## Préfixes de demandes conseillés pour un agent externe

Quand vous stockez une demande agent dans l'interface ShopAI, utilisez des
préfixes simples et stables :

- `Créer implantation:` pour générer un layout à partir d'un besoin métier ;
- `Modifier implantation:` pour changer la grille, les dimensions ou le
  mobilier ;
- `Créer assortiment:` pour remplir les rayons à partir du catalogue projet et
  de règles merchandising ;
- `Modifier assortiment:` pour corriger un assortiment existant ;
- `Projet complet:` pour enchaîner implantation + assortiment.

Exemples :

- `Créer implantation: supérette urbaine 400 m², parcours rapide, 1 zone frais en fond.`
- `Modifier implantation: passe la grille à 50 cm, ajoute 2 meubles promo et élargis l'allée centrale.`
- `Créer assortiment: utilise le catalogue du projet, mets les promotions sur les têtes de gondole et garde les frais près des frigos.`
- `Projet complet: à partir du catalogue du projet, crée un magasin orienté déjeuner du midi.`

## Authentification, clés API et sécurité

### Ce que fait le dépôt aujourd'hui

Le pilote Astra continue de parler directement à l'API CAD du dépôt. En local,
il peut toujours fonctionner sans session applicative si vous l'appelez sur un
backend ouvert. En parallèle, la plateforme expose désormais un vrai parcours
OAuth Google/GitHub côté interface et un guide REST/OpenAPI pour brancher un agent.

### Donc, quelles clés dois-je gérer ?

Si vous utilisez un agent externe, il faut distinguer **deux couches** :

1. **API métier du dépôt** : pas de clé native dans l'état actuel du code.
2. **Provider LLM / orchestrateur** : vos propres clés, selon votre infra.

Exemples de clés qui peuvent exister **chez vous**, mais **pas dans ce dépôt** :
- clé du provider LLM ;
- clé d'un proxy d'observabilité ;
- jeton d'un backend exposé publiquement derrière une gateway.

### Bonnes pratiques de gestion des clés

- ne mettez jamais de clé dans `README.md`, dans le code, ni dans un JSON de test ;
- injectez les secrets via variables d'environnement ou secret manager ;
- séparez les clés par environnement (`dev`, `staging`, `prod`) ;
- activez rotation et révocation ;
- loggez les IDs de requêtes, jamais les secrets ;
- si vous exposez le backend sur Internet, ajoutez une couche d'authentification
  et de rate limiting **en dehors de ce dépôt** (reverse proxy, API gateway,
  auth middleware maison, etc.).

### Réponse courte à la question “où renseigner ma clé ?”

- **Pour le backend de ce dépôt** : renseignez éventuellement
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI` si vous
  activez le vrai OAuth de la plateforme. Le pilote Astra n'en dépend pas
  directement.
- **Pour votre agent LLM** : dans votre orchestrateur, vos variables
  d'environnement — pas dans le dépôt.

### Connexion type à un provider API

Exemple minimal :

1. votre utilisateur se connecte à ShopAI via GitHub ou Google dans
   l'interface ;
2. votre orchestrateur récupère le cookie de session ShopAI ;
3. vous fournissez à l'agent :
   - l'URL du backend ShopAI ;
   - `/openapi.json` ;
   - vos variables de provider LLM (OpenAI, Anthropic, etc.) côté infra ;
4. l'agent appelle ensuite l'API REST ShopAI en session authentifiée.

Autrement dit :

- **auth utilisateur ShopAI** = accès à l'API métier du produit ;
- **clé provider LLM** = accès à votre modèle d'agent ;
- ces deux couches doivent rester séparées.

## Exemple pédagogique — assortiment avec layout déjà fourni

Vous avez déjà un layout valide et vous voulez uniquement automatiser
l'assortiment.

1. Importez le layout dans `Implantations`.
2. Importez le fichier assortiment JSON dans `Catalogues`.
3. Créez un nouveau projet en choisissant ce layout et ce catalogue.
4. Envoyez une demande agent telle que :

   `Créer assortiment: le layout est déjà fourni, utilise le catalogue du projet, place les meilleures marges à hauteur des yeux, réserve les têtes de gondole aux promotions et limite les doublons par allée.`

5. L'agent n'a alors plus à recalculer la géométrie : il peut se focaliser sur
   les règles de placement produit et les planogrammes.

---

## Coût API pendant la création d'un magasin

### Coût du backend de ce dépôt

Le backend lui-même **n'appelle aucun service IA payant** pendant la création.
Les requêtes REST du pipeline ne génèrent donc **aucun coût API externe imposé
par ce dépôt**.

En local, le coût direct est essentiellement :
- votre CPU / RAM ;
- le temps de traitement ;
- éventuellement votre hébergement si le backend tourne sur une machine distante.

### Coût côté agent / LLM

Si vous branchez Astra ou un autre LLM, le coût vient de votre provider :
- prompt système et consignes ;
- lecture éventuelle du schéma OpenAPI ;
- traces des tool calls ;
- éventuelles boucles de correction après erreur `409` ou `422`.

### Comment limiter le coût LLM

- utilisez le **script direct** si vous n'avez pas besoin de raisonnement libre ;
- gardez le pipeline en **8 étapes strictes** au lieu d'une exploration ouverte ;
- réduisez `--max-products` pendant les essais ;
- fournissez un layout utilisateur avec `--layout` pour éviter les itérations ;
- évitez de redonner tout `openapi.json` à chaque run si votre orchestrateur peut
  le mettre en cache.

### Estimation pratique

Pour la configuration par défaut, le backend reçoit environ **74 requêtes HTTP**.
Si vous passez par un LLM, vos coûts seront surtout corrélés :
- au nombre de tours agentiques ;
- à la taille du contexte ;
- au nombre de corrections après erreur.

Le dépôt ne peut pas annoncer un prix en euros universel, car cela dépend
entièrement du modèle et de votre fournisseur.

---

## Options du script

| Option | Défaut | Description | Impact pratique |
|---|---|---|---|
| `--api` | `http://localhost:8000` | URL de base du backend | pointer vers local, staging ou prod |
| `--name` | `Magasin Astra` | Nom du projet créé | utile pour distinguer les runs |
| `--catalog` | `assortment.json` | Chemin du catalogue JSON fourni | change la base produit importée |
| `--max-products` | `200` | Nombre max de produits importés | réduit charge et coût de test |
| `--layout` | *(aucun)* | Plan d'implantation JSON fourni par l'utilisateur | remplace le layout généré |
| `--pause` | `0` | Attente entre étapes | utile pour debug, démonstration, vidéo |

### Recommandations d'usage des options

- **POC rapide** : `--max-products 50 --pause 0`
- **Démo filmée** : `--pause 2`
- **Intégration orchestrée** : `--api <backend distant>`
- **Layout maîtrisé** : `--layout plan.json`

---

## Deux modes de création du layout

### Mode 1 — Layout généré par l'agent (défaut)

Le script utilise `plan_layout` pour produire un layout déterministe qui ne doit
pas déclencher la garde anti-chevauchement du backend.

Composition par défaut :
- **mur du fond** : 6 frigos verticaux ;
- **allées centrales** : 3 rangées de 5 gondoles doubles ;
- **mur gauche** : 4 gondoles simples ;
- **entrée avant-droite** : 3 caisses.

Dimensions magasin par défaut :
- largeur `3000 cm`
- profondeur `2000 cm`
- hauteur `400 cm`

Toutes les coordonnées sont exprimées en **cm**, origine au **coin bas-gauche**
du magasin.

### Mode 2 — Layout fourni par l'utilisateur

Le script accepte `--layout plan.json` pour injecter un plan externe.

Format recommandé :

```json
{
  "store": { "width": 1500, "depth": 1000, "height": 350 },
  "furniture": [
    { "libraryId": "gondola_double", "name": "Gondole centrale 1", "position": [300, 0, 400] },
    { "libraryId": "fridge", "name": "Frigo fond", "position": [100, 0, 850] },
    { "libraryId": "register", "name": "Caisse 1", "position": [1200, 0, 100] }
  ]
}
```

Règles importantes :
- `libraryId` et `position` `[x, y, z]` sont obligatoires ;
- `name`, `rotation`, `dimensions`, `materialId` sont optionnels ;
- les dimensions manquantes sont complétées depuis la bibliothèque mobilier ;
- un tableau JSON nu de meubles est aussi accepté ;
- un `libraryId` inconnu échoue explicitement ;
- un plan en chevauchement reste **rejeté par le backend** en `HTTP 409`.

### Quels types de mobilier sont disponibles ?

La bibliothèque contient notamment :
- `gondola_single`
- `gondola_double`
- `pallet`
- `fridge`
- `fridge_horizontal`
- `display`
- `register`
- `wall`
- `partition`
- `floor_grid`

Le pilote par défaut ne planogramme automatiquement que :
- `gondola_single` → face `front`
- `gondola_double` → faces `front` et `back`
- `fridge` → face `front`

Si vous utilisez d'autres types via un layout fourni, ils peuvent être placés,
mais ne recevront pas automatiquement de planogramme via ce pilote sauf si vous
étendez sa logique.

---

## Catalogue produit : quel format fournir ?

Le pilote accepte un JSON externe puis le convertit vers le schéma `Product` du
backend.

### Champs minimums vraiment nécessaires

En pratique, pour qu'une entrée soit retenue par le mapping du pilote, il faut :
- un identifiant produit (`barcode` ou `ean`) ;
- un nom (`product_name` ou `name`).

Sans cela, l'entrée est ignorée.

### Mapping effectué par le pilote

| Champ externe | Champ backend `Product` |
|---|---|
| `barcode` | `ean` |
| `product_name` | `name` |
| `brand` | `brand` |
| `category_id` / `category` | `category` |
| `subcategory_id` | `subcategory` |
| `cost_price_eur` | `priceBuyEur` |
| `suggested_price_eur` | `priceSellEur` |
| `margin_rate_pct` | `marginPct` |
| `image_url` | `imageUrl` |

### Dimensions produit

Si votre catalogue externe ne fournit pas les dimensions physiques, le script
applique des dimensions par défaut par catégorie (`fruits_vegetables`, `dairy`,
`beverages`, `grocery`, `frozen`, `hygiene`) puis un fallback générique.

### Exemple minimal d'entrée source

```json
[
  {
    "barcode": "3760000000001",
    "product_name": "Pâtes penne bio 500g",
    "brand": "Barilla",
    "category_id": "grocery",
    "cost_price_eur": 0.91,
    "suggested_price_eur": 1.89,
    "margin_rate_pct": 51.8,
    "image_url": "https://example.com/penne.jpg"
  }
]
```

### Nettoyage appliqué

- doublons d'EAN ignorés ;
- produits sans EAN ou sans nom ignorés ;
- import limité à `--max-products` produits retenus.

---

## Comment sont créés les planogrammes ?

Le pilote crée automatiquement des planogrammes simples :
- **4 lignes × 6 colonnes** par face planogrammée ;
- remplissage systématique de toutes les cellules ;
- parcours circulaire du catalogue pour varier les produits par planogramme.

Ce mécanisme est utile pour :
- valider le pipeline bout en bout ;
- générer un magasin complet rapidement ;
- fournir un jeu de données cohérent au frontend et à l'export.

Ce n'est **pas** un moteur avancé d'optimisation merchandising.

---

## Vérification finale et contrôle qualité

L'étape finale lit `GET /api/cad/projects/{id}/export/retail-layout`.

Cette vérification confirme que :
- le mobilier existe bien dans le projet ;
- les planogrammes ont été rattachés aux bonnes faces ;
- l'export consolidé contient `furniture[].placements[].slots[]` ;
- chaque slot produit porte une position absolue en cm.

Si vous branchez un agent externe, c'est **l'appel à conserver absolument** pour
valider qu'une création de magasin est réellement terminée.

---

## Gestion des erreurs et questions fréquentes

### “Comment savoir si mon backend est bien branché ?”

Test minimal :

```bash
curl http://localhost:8000/
```

Vous devez obtenir un JSON de santé. Sinon, l'agent ne pourra rien créer.

### “Pourquoi j'ai une erreur 409 ?”

Cela signifie généralement un **chevauchement de mobilier** ou un doublon d'ID.
Le pilote de référence décale une fois de `+20 cm` en `x` en cas de 409 sur le
placement mobilier, mais la vraie stratégie reste de produire un layout propre.

### “Pourquoi j'ai une erreur 422 ?”

Le payload envoyé ne respecte pas le schéma backend :
- produit invalide ;
- planogramme invalide ;
- meuble invalide ;
- dimensions ou triplets mal formés.

### “Dois-je mettre ma clé fournisseur dans ce dépôt ?”

Non. Jamais. Gérez-la hors dépôt, via environnement ou secret manager.

### “Le backend facture-t-il des appels pendant la création ?”

Non, pas par lui-même. Le coût payant éventuel vient de votre fournisseur LLM ou
de votre hébergement, pas du pipeline REST du dépôt.

### “Puis-je créer un magasin sans LLM ?”

Oui. Le script `astra_build_store.py` permet justement de construire un magasin
complet sans appeler de modèle externe.

### “Puis-je utiliser mon propre layout ?”

Oui, avec `--layout`. C'est le meilleur moyen de maîtriser exactement le
positionnement.

---

## Visualiser la construction en vidéo

1. Lancez le frontend et gardez le projet ouvert dans le navigateur.
2. Lancez le script avec `--pause 2` ou plus.
3. Rechargez le projet pendant la capture pour voir la scène évoluer.

---

## Recommandation de mise en production

Si vous voulez industrialiser la création agentique d'un magasin :

1. gardez ce pilote comme **oracle de référence** ;
2. placez votre agent derrière un orchestrateur outillé en REST/OpenAPI ;
3. stockez les clés LLM hors dépôt ;
4. protégez le backend exposé par une gateway ;
5. conservez `export/retail-layout` comme validation finale obligatoire ;
6. faites varier progressivement `layout`, `catalog` et `max-products` avant de
   laisser plus d'autonomie à l'agent.

Cette approche vous donne un chemin clair : **script fiable pour le runbook,
agent externe pour l'intelligence, backend du dépôt pour l'exécution métier**.
