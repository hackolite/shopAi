# Workflow AI ShopAI

Ce document résume le workflow IA recommandé pour automatiser la création d'un
projet retail dans ShopAI.

## Objectif

Construire un projet complet (implantation + assortiment) en pilotant l'API
ShopAI via un agent, avec un flux reproductible et auditable.

## Les 3 modes disponibles

1. **Assistant local (`/assistant`)**  
   Assistant déterministe intégré au studio 3D (pas de provider LLM externe).

2. **Webhook LLM (`/assistant/llm`)**  
   Le frontend envoie un prompt au backend, qui relaye vers votre orchestrateur
   externe (config serveur via `STUDIO_LLM_WEBHOOK_URL`).

3. **Pilote Astra (`scripts/astra_build_store.py`)**  
   Script de référence qui exécute une séquence API complète en 8 étapes.

---

## Workflow recommandé de bout en bout

### Étape 1 — Préparer les données workspace

1. Importer le catalogue JSON dans **Catalogues**.
2. (Optionnel) Importer une implantation existante dans **Implantations**.
3. Créer un projet en sélectionnant les ressources workspace nécessaires.

### Étape 2 — Choisir le niveau d'automatisation IA

- **Rapide et stable** : lancer le pilote Astra directement.
- **Flexible et agentique** : brancher un orchestrateur LLM sur
  `/assistant/llm` ou appeler l'API REST via OpenAPI.

### Étape 3 — Exécuter le pipeline métier (8 étapes)

Le workflow IA complet suit ce cycle :

1. Vérifier la disponibilité du backend.
2. Créer un projet.
3. Récupérer la bibliothèque mobilier.
4. Définir les dimensions du magasin.
5. Placer le mobilier sans chevauchement.
6. Importer le catalogue.
7. Générer les planogrammes.
8. Vérifier le résultat via l'export `retail-layout`.

### Étape 4 — Contrôler et itérer

1. Ouvrir le projet dans le studio 3D.
2. Vérifier implantation, planogrammes et cohérence merchandising.
3. Relancer une consigne ciblée (`Modifier implantation:`, `Modifier assortiment:`)
   si des ajustements sont nécessaires.

---

## Exemple rapide (pilote Astra)

```bash
python scripts/astra_build_store.py \
  --api http://localhost:8000 \
  --name "Magasin Astra" \
  --catalog assortment.json
```

## Bonnes pratiques

- Garder les clés provider LLM hors du dépôt (variables d'environnement/secret manager).
- Séparer l'auth utilisateur ShopAI et les credentials du provider LLM.
- Conserver un ordre d'exécution stable pour limiter les erreurs (`409`/`422`).
- Valider systématiquement l'état final via l'export `retail-layout`.

## Mode UI-only (création/modification côté client)

Si vous voulez un usage 100% interface utilisateur :

1. L'utilisateur ouvre le studio 3D puis le panneau **Assistant**.
2. Il choisit une catégorie et envoie son prompt.
3. Le backend traite en local (`/assistant`) ou via agent externe (`/assistant/llm`).
4. Le résultat est appliqué/rechargé dans l'UI si un projet est créé ou modifié.

Pré-requis dev :

- Configurer `STUDIO_LLM_WEBHOOK_URL` côté serveur pour activer l'agent externe.
- Aucun secret partagé entre backend et orchestrateur : la session ShopAI est
  transmise automatiquement via `X-ShopAI-Session`. Le backend vérifie la session
  en base (expiration comprise) et l'accès au projet/tenant avant la planification LLM.
  Les clés du fournisseur restent nécessaires uniquement dans l'orchestrateur.
- Implémenter le webhook orchestrateur avec le contrat d'entrée/sortie attendu.
- Transmettre la `category` choisie et conserver le `confirmationToken` de l'aperçu
  jusqu'à la confirmation. Changer de catégorie ou de mode annule cet aperçu.
- Enregistrer les modifications manuelles avant la demande : l'agent travaille sur
  l'état persistant et refuse une confirmation si cet état a changé entre-temps.
- Garder les clés provider en variables d'environnement/secret manager uniquement.

Les catégories LLM ne changent pas les capacités de l'assistant **local**, qui
reste déterministe. Un échec de fournisseur n'est pas une autorisation d'exécuter
un autre plan. Après une interruption, des écritures partielles peuvent subsister :
vérifier le projet signalé et demander un nouvel aperçu, plutôt que relancer
aveuglément la confirmation. Consulter aussi les limites de l'orchestrateur dans
[`orchestrator/README.md`](orchestrator/README.md).

Le [lancement PowerShell](orchestrator/README.md#lancement-simple-sous-powershell)
ne nécessite aucun script auxiliaire. Les logs INFO montrent lectures autorisées,
planification, aperçu, confirmation et audit, avec statuts/durées, sans contenu sensible.
Une session expirée (401) exige une reconnexion; un accès refusé (403), le bon compte/projet;
un service indisponible (503), la vérification des processus backend/orchestrateur.

Providers avec offre gratuite pour tests (quotas variables) :

- Groq
- Google AI Studio (Gemini API)
- OpenRouter

## Références

- Guide détaillé Astra : [`scripts/README.md`](scripts/README.md)
- Documentation principale : [`README.md`](README.md)
