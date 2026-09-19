from __future__ import annotations

SYSTEM_PROMPT = """
Tu es l'orchestrateur ShopAI.
Tu dois extraire un plan d'exécution structuré depuis la demande utilisateur,
et préparer les paramètres du pipeline backend (nom projet, dimensions magasin, volume catalogue).

Tu dois renvoyer l'appel d'outil `build_store_plan` avec un JSON valide.
""".strip()


TOOL_SPEC = {
    "name": "build_store_plan",
    "description": "Construire le plan d'exécution du magasin complet.",
    "parameters": {
        "type": "object",
        "properties": {
            "intent": {"type": "string", "enum": ["build_complete_store", "other"]},
            "project_name": {"type": "string"},
            "store": {
                "type": "object",
                "properties": {
                    "width": {"type": "number"},
                    "depth": {"type": "number"},
                    "height": {"type": "number"},
                },
                "required": ["width", "depth", "height"],
            },
            "max_products": {"type": "integer", "minimum": 1, "maximum": 3000},
        },
        "required": ["intent", "project_name", "store", "max_products"],
    },
}
