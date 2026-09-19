from __future__ import annotations

from .config import Settings
from .llm import LLMPlanner
from .schemas import WebhookRequest, WebhookResponse
from .tools import BackendApiError, BackendTools


class ShopAIOrchestrator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.planner = LLMPlanner(settings)

    async def run(self, payload: WebhookRequest, session_cookie: str | None = None) -> WebhookResponse:
        plan = await self.planner.build_plan(payload.prompt)

        if plan.intent != "build_complete_store":
            return WebhookResponse(
                message="Demande comprise, mais cette version de l'orchestrateur exécute uniquement la création complète d'un magasin.",
                requiresConfirmation=False,
                changed=False,
                projectId=payload.projectId,
                steps=["Aucune écriture exécutée."],
            )

        preview = [
            "1/8 Health check",
            "2/8 Création projet",
            "3/8 Bibliothèque mobilier",
            "4/8 Dimensions magasin",
            "5/8 Placement mobilier",
            "6/8 Import catalogue",
            "7/8 Création planogrammes",
            "8/8 Vérification retail-layout",
        ]

        if not payload.confirm:
            return WebhookResponse(
                message=(
                    f"Je vais créer un magasin '{plan.project_name}' ({int(plan.store.width)}x{int(plan.store.depth)} cm, "
                    f"{plan.max_products} produits) en suivant le pipeline 8 étapes. Confirme pour lancer."
                ),
                requiresConfirmation=True,
                changed=False,
                projectId=payload.projectId,
                steps=preview,
            )

        tools = BackendTools(self.settings, session_cookie=session_cookie)
        steps: list[str] = []

        try:
            health = await tools.health_check()
            steps.append(f"1/8 backend OK: {health}")

            project = await tools.create_project(plan.project_name)
            project_id = str(project["id"])
            steps.append(f"2/8 projet créé: {project_id}")

            library_response = await tools.get_furniture_library()
            library_items = library_response.get("furniture", [])
            library = {item["id"]: item for item in library_items}
            steps.append(f"3/8 bibliothèque chargée: {len(library)} types")

            await tools.set_store_dimensions(
                project_id,
                plan.project_name,
                {
                    "width": plan.store.width,
                    "depth": plan.store.depth,
                    "height": plan.store.height,
                },
            )
            steps.append(
                f"4/8 dimensions définies: {int(plan.store.width)}x{int(plan.store.depth)}x{int(plan.store.height)} cm"
            )

            planned_furniture = tools.plan_layout(library, plan)
            placed_furniture = []
            for furniture in planned_furniture:
                placed = await tools.place_furniture(project_id, furniture)
                placed_furniture.append(placed)
            steps.append(f"5/8 mobilier placé: {len(placed_furniture)}")

            products = tools.load_products(plan.max_products)
            imported = await tools.import_catalog(project_id, products)
            steps.append(f"6/8 catalogue importé: {imported.get('imported', 0)} produits")

            planograms = tools.build_planograms(placed_furniture, products)
            for payload_item in planograms:
                await tools.create_planogram(project_id, payload_item)
            steps.append(f"7/8 planogrammes créés: {len(planograms)}")

            layout = await tools.export_retail_layout(project_id)
            furniture_count = len(layout.get("furniture", []))
            steps.append(f"8/8 vérification OK: export retail-layout avec {furniture_count} meubles")

            return WebhookResponse(
                message="Création complète du magasin terminée avec succès.",
                requiresConfirmation=False,
                changed=True,
                projectId=project_id,
                steps=steps,
            )
        except BackendApiError as exc:
            steps.append(f"Erreur pipeline: {exc}")
            return WebhookResponse(
                message="La création du magasin a échoué. Consulte les étapes pour corriger la requête.",
                requiresConfirmation=False,
                changed=False,
                projectId=payload.projectId,
                steps=steps,
            )
