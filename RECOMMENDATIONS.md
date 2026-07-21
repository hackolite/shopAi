# Recommandations techniques — shopAi

Ce document recense les observations faites lors du nettoyage du code (juillet 2026) et propose des axes d'amélioration pour la suite du projet.

---

## Ce qui a été fait dans ce nettoyage

| Fichier | Changement |
|---|---|
| `store/sceneStore.ts` | Suppression du `console.debug` en production |
| `components/Inspector/index.tsx` | Suppression de 4 appels `console.debug` en production |
| `App.tsx` | `openPlanogram` et `closePlanogram` encapsulés dans `useCallback` ; suppression du commentaire `eslint-disable` |
| `three/SceneEditor.tsx` | Extraction de `getWorldHitPoint` (utilitaire module-level) qui remplace 4 implémentations identiques de `getHitPoint` ; `computedSemiCircleConfig` converti de IIFE en `useMemo` |
| `vite.config.ts` | Code splitting : `vendor-r3f` (three.js + r3f) séparé du chunk applicatif → chunk applicatif réduit de 1 279 kB à 124 kB |

---

## Recommandations futures

### 1. Éclater `SceneEditor.tsx` (priorité haute)

`SceneEditor.tsx` compte **2 145 lignes** et contient 16 composants + plusieurs hooks et utilitaires. C'est contraire aux conventions React qui recommandent un composant par fichier.

**Plan suggéré :**

```
src/three/
  SceneEditor.tsx            ← <SceneEditor> uniquement (~50 lignes)
  SceneContent.tsx           ← <SceneContent> + contextes
  FurnitureMesh.tsx          ← <FurnitureMesh> + <TransformProxy>
  ResizeHandles.tsx          ← <StoreBoundaryResizeHandles> + <FurnitureResizeHandles>
  FloorZone.tsx              ← <FloorZoneMesh> + <FloorZoneResizeHandles> + <FloorZoneLayer>
  MeasureTool.tsx            ← <MeasureTool> + <MeasureLineHit>
  PlanogramFaceOverlay.tsx   ← <PlanogramFaceOverlay>
  CameraUtils.tsx            ← <CameraFlyToFurniture> + <CameraStateSync>
  utils/worldHitPoint.ts     ← getWorldHitPoint (déjà extrait)
```

### 2. Supprimer ou archiver le code legacy

Les fichiers suivants appartiennent à une ancienne architecture (viewer voxel + EAN search) et ne sont **pas référencés** par l'`App` principale. Ils compilent sans erreur mais gonflent la base de code inutilement.

| Fichier | Statut suggéré |
|---|---|
| `src/api/index.ts` | Supprimer si `/api/projects` n'est plus utilisé |
| `src/three/StoreScene.tsx` | Supprimer ou déplacer dans un dossier `_legacy/` |
| `src/three/ProductBlock.tsx` | Supprimer ou déplacer dans un dossier `_legacy/` |
| `src/three/Shelf.tsx` | Supprimer ou déplacer dans un dossier `_legacy/` |
| `src/components/StoreViewer/` | Supprimer ou déplacer dans un dossier `_legacy/` |
| `src/components/SidePanel/` | Supprimer ou déplacer dans un dossier `_legacy/` |
| `src/components/SearchBar/` | Supprimer ou déplacer dans un dossier `_legacy/` |
| `src/components/ProductInfo/` | Supprimer ou déplacer dans un dossier `_legacy/` |
| `src/types/index.ts` (sections `Store`, `Voxel`, `SearchResult`…) | Nettoyer une fois les composants legacy retirés |

> ⚠️ Vérifier avant suppression qu'aucune route ou autre entrypoint n'importe ces fichiers.

### 3. Passer `saveProject` à un vrai autosave

La sauvegarde manuelle (`Ctrl+S`) effectue actuellement un aller-retour « no-op » sur `/settings` pour forcer la cohérence backend. C'est fragile et contre-intuitif.

**Recommandation :** utiliser un vrai `autosave` (debounce de 2–3 s) qui appelle un endpoint dédié `/api/cad/projects/{id}/sync` — ou persister tous les changements individuels immédiatement (le code le fait déjà pour les meubles, les planogrammes, etc.).

### 4. Remplacer les `alert()` natifs par un système de notifications

`App.tsx` utilise `alert()` pour les erreurs (import/export, création de projet). Ces boîtes modales bloquantes sont à remplacer par un composant `Toast` ou `Snackbar` non-bloquant.

### 5. Reducer le bundle `vendor-r3f` (priorité basse)

Le chunk `vendor-r3f` reste à **1 154 kB** (316 kB gzip) car three.js ne peut pas être divisé davantage. Pour une application SPA à usage interne, c'est acceptable. Si la performance réseau devient un enjeu :

- Utiliser des **imports dynamiques** (`React.lazy` + `Suspense`) pour charger le `<SceneEditor>` et le `<PlanogramEditor>` uniquement quand ils sont montés.
- Envisager **tree-shaking manuel** de three.js (importer seulement les géométries/matériaux utilisés).

### 6. Backend : CORS en production

`main.py` autorise uniquement `http://localhost:5173` et `http://localhost:3000`. Ajouter les origines de production dans une variable d'environnement avant tout déploiement :

```python
# main.py
import os
ALLOWED_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, ...)
```

### 7. Tests frontend

Il n'existe actuellement des tests unitaires que pour les modules `engine/` (`gondola.test.ts`, `furnitureAnchor.test.ts`). Les composants React principaux (`App`, `SceneEditor`, `Inspector`, `PlanogramEditor`) n'ont pas de tests.

**Recommandation :** ajouter des tests d'intégration avec [React Testing Library](https://testing-library.com/) pour les chemins critiques :
- Chargement d'un projet
- Ajout / déplacement d'un meuble
- Ouverture d'un planogramme
- Import / export ZIP

### 8. Typage strict des contrôles de caméra

`CameraFlyToFurniture` et `StoreScene` utilisent deux `@ts-expect-error` pour accéder à `controls.target` et `controls.update()`. Ces suppressions peuvent masquer des régressions lors de mises à jour de `@react-three/drei`.

**Recommandation :** créer un type local pour l'API OrbitControls :

```ts
interface OrbitControlsRef {
  target?: THREE.Vector3;
  update?: () => void;
}
const ctrl = controls as OrbitControlsRef;
ctrl.target?.copy(target);
ctrl.update?.();
```

---

*Document généré lors du nettoyage du code — juillet 2026.*
