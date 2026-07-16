from __future__ import annotations

from services.planogram_loader import load_json


def search_ean(project_id: str, ean: str) -> dict | None:
    """
    Look up all physical instances for a given EAN.

    Returns:
        {
          "ean": str,
          "product": {...},
          "instances": [...],
          "total_facings": int,
          "analytics_summary": {...}   # aggregated from analytics.json
        }
    """
    products: list[dict] = load_json(project_id, "products.json") or []
    ean_index: dict = load_json(project_id, "ean_index.json") or {}
    analytics: dict = load_json(project_id, "analytics.json") or {}

    product = next((p for p in products if p["ean"] == ean), None)
    if not product:
        return None

    occurrences = ean_index.get(ean, [])
    if not occurrences:
        return None

    total_facings = sum(o.get("facings", 1) for o in occurrences)

    # Aggregate analytics across all instances of this EAN
    total_passes = 0
    total_views = 0
    total_attention = 0
    count_with_data = 0

    for occ in occurrences:
        iid = occ["instance_id"]
        if iid in analytics:
            t = analytics[iid].get("traffic", {})
            total_passes += t.get("passes", 0)
            total_views += t.get("views", 0)
            total_attention += t.get("attention_seconds", 0)
            count_with_data += 1

    avg_attention = (
        round(total_attention / count_with_data, 1) if count_with_data else None
    )

    return {
        "ean": ean,
        "product": product,
        "instances": occurrences,
        "total_positions": len(occurrences),
        "total_facings": total_facings,
        "analytics_summary": {
            "total_passes": total_passes,
            "total_views": total_views,
            "avg_attention_seconds": avg_attention,
            "data_available": count_with_data > 0,
        },
    }
