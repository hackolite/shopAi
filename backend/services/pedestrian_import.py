"""Parsing and validation of the pedestrian/basket CSV import.

Expected columns: ``pedestrian_id, start_unix_ts, speed_mps, profile_json, ean``.
One row per (pedestrian, product) pair; a pedestrian who buys nothing is
represented by a single row with an empty ``ean``. ``profile_json`` may be
empty (defaults to ``{}``) or a JSON object with free-form traveler traits
(e.g. ``{"type": "business"}``).

Rows that fail validation are skipped and reported as anomalies instead of
raising, so a single malformed line never aborts the whole import.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from models.project import PedestrianImportAnomaly, PedestrianRecord

REQUIRED_COLUMNS = ("pedestrian_id", "start_unix_ts", "speed_mps")
OPTIONAL_COLUMNS = ("profile_json", "ean")

# Realistic human walking/running pace range for an in-store pedestrian.
MIN_SPEED_MPS = 0.1
MAX_SPEED_MPS = 3.0


def parse_pedestrian_csv(
    csv_text: str,
) -> tuple[dict[int, PedestrianRecord], list[PedestrianImportAnomaly]]:
    """Parse and aggregate the pedestrian CSV.

    Returns a mapping ``pedestrian_id -> PedestrianRecord`` (rows for the same
    pedestrian are merged into one record with a combined ``wantedProducts``
    list) together with the list of anomalies encountered along the way.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    anomalies: list[PedestrianImportAnomaly] = []

    if reader.fieldnames is None:
        anomalies.append(PedestrianImportAnomaly(reason="Empty CSV file"))
        return {}, anomalies

    missing = [column for column in REQUIRED_COLUMNS if column not in reader.fieldnames]
    if missing:
        anomalies.append(
            PedestrianImportAnomaly(reason=f"Missing required column(s): {', '.join(missing)}")
        )
        return {}, anomalies

    records: dict[int, PedestrianRecord] = {}

    for row_number, row in enumerate(reader, start=2):  # header is line 1
        pedestrian_id, speed_mps, start_unix_ts, error = _validate_row(row)
        if error is not None:
            anomalies.append(
                PedestrianImportAnomaly(rowNumber=row_number, pedestrianId=pedestrian_id, reason=error)
            )
            continue

        profile, profile_error = _parse_profile(row.get("profile_json"))
        if profile_error is not None:
            anomalies.append(
                PedestrianImportAnomaly(
                    rowNumber=row_number,
                    pedestrianId=pedestrian_id,
                    reason=profile_error,
                )
            )

        record = records.get(pedestrian_id)
        if record is None:
            record = PedestrianRecord(
                pedestrianId=pedestrian_id,
                startUnixTs=start_unix_ts,
                speedMps=speed_mps,
                profile=profile,
            )
            records[pedestrian_id] = record

        ean = (row.get("ean") or "").strip()
        if ean:
            record.wantedProducts.append(ean)

    return records, anomalies


def _validate_row(row: dict[str, Any]) -> tuple[int, float, int, str | None]:
    """Validate the mandatory columns of one CSV row.

    Returns ``(pedestrian_id, speed_mps, start_unix_ts, error)``; ``error`` is
    ``None`` on success. On failure, best-effort values are still returned so
    the anomaly can reference the offending pedestrian id when parseable.
    """
    raw_pedestrian_id = (row.get("pedestrian_id") or "").strip()
    try:
        pedestrian_id = int(raw_pedestrian_id)
    except (TypeError, ValueError):
        return 0, 0.0, 0, f"Invalid pedestrian_id: {raw_pedestrian_id!r}"

    raw_start_ts = (row.get("start_unix_ts") or "").strip()
    try:
        start_unix_ts = int(raw_start_ts)
    except (TypeError, ValueError):
        return pedestrian_id, 0.0, 0, f"Invalid start_unix_ts: {raw_start_ts!r}"

    raw_speed = (row.get("speed_mps") or "").strip()
    try:
        speed_mps = float(raw_speed)
    except (TypeError, ValueError):
        return pedestrian_id, 0.0, start_unix_ts, f"Invalid speed_mps: {raw_speed!r}"

    if not (MIN_SPEED_MPS <= speed_mps <= MAX_SPEED_MPS):
        return (
            pedestrian_id,
            speed_mps,
            start_unix_ts,
            f"speed_mps {speed_mps} out of realistic range [{MIN_SPEED_MPS}, {MAX_SPEED_MPS}]",
        )

    return pedestrian_id, speed_mps, start_unix_ts, None


def _parse_profile(raw_profile_json: str | None) -> tuple[dict[str, Any], str | None]:
    text = (raw_profile_json or "").strip()
    if not text:
        return {}, None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {}, f"Invalid profile_json: {text!r} (falling back to {{}})"
    if not isinstance(parsed, dict):
        return {}, f"profile_json must be a JSON object: {text!r} (falling back to {{}})"
    return parsed, None
