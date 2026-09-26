from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from time import time
from typing import Any
from uuid import uuid4

from models.project import (
    ProjectSettings,
    SensorGpsBounds,
    SensorLiveSettings,
    SensorMetricStats,
    SensorSampleInput,
    SensorSampleRecord,
    SensorSnapshot,
    SensorNormalizedBounds,
)
from services import platform_service
from services import project_manager


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ms() -> int:
    return int(time() * 1000)


class LiveSensorManager:
    def __init__(self) -> None:
        self._events_lock = threading.Lock()
        self._events: dict[str, dict[str, Any]] = {}

    def _load_live_settings(self, project_id: str) -> SensorLiveSettings:
        settings_raw = (
            project_manager.load_project_file(project_id, "settings.json")
            or ProjectSettings().model_dump(mode="json")
        )
        settings = ProjectSettings.model_validate(settings_raw)
        return settings.live

    def _upsert_buffer(
        self,
        conn,
        project_id: str,
        retention_seconds: int,
    ) -> None:
        conn.execute(
            """
            INSERT INTO sensor_live_buffers(project_id, retention_seconds, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                retention_seconds = excluded.retention_seconds,
                updated_at = excluded.updated_at
            """,
            (project_id, retention_seconds, _utc_now()),
        )

    def _purge_expired(
        self,
        conn,
        project_id: str,
        retention_seconds: int,
        reference_ms: int,
    ) -> int:
        threshold_ms = reference_ms - max(1, retention_seconds) * 1000
        result = conn.execute(
            "DELETE FROM sensor_live_samples WHERE project_id = ? AND timestamp_ms < ?",
            (project_id, threshold_ms),
        )
        return int(result.rowcount or 0)

    def _build_snapshot(self, conn, project_id: str, retention_seconds: int) -> SensorSnapshot:
        rows = conn.execute(
            """
            SELECT
                id,
                source_id,
                source_label,
                timestamp_ms,
                coordinate_kind,
                normalized_x,
                normalized_y,
                latitude,
                longitude,
                metrics_json
            FROM sensor_live_samples
            WHERE project_id = ?
            ORDER BY timestamp_ms ASC, id ASC
            """,
            (project_id,),
        ).fetchall()
        metric_acc: dict[str, dict[str, Any]] = {}
        samples: list[SensorSampleRecord] = []
        sources: set[str] = set()
        source_labels: dict[str, str] = {}
        coordinate_kinds: set[str] = set()
        latest_timestamp_ms: int | None = None
        min_x = max_x = min_y = max_y = None
        min_lat = max_lat = min_lon = max_lon = None

        for row in rows:
            coordinate_kind = str(row["coordinate_kind"])
            coordinate_kinds.add(coordinate_kind)
            source_id = str(row["source_id"])
            sources.add(source_id)
            if row["source_label"]:
                source_labels[source_id] = str(row["source_label"])
            timestamp_ms = int(row["timestamp_ms"])
            if latest_timestamp_ms is None or timestamp_ms > latest_timestamp_ms:
                latest_timestamp_ms = timestamp_ms
            metrics = json.loads(row["metrics_json"])
            for metric in metrics:
                name = str(metric["name"])
                value = float(metric["value"])
                current = metric_acc.get(name)
                if current is None:
                    metric_acc[name] = {
                        "name": name,
                        "min": value,
                        "max": value,
                        "unit": metric.get("unit"),
                        "count": 1,
                    }
                else:
                    current["min"] = min(float(current["min"]), value)
                    current["max"] = max(float(current["max"]), value)
                    current["count"] = int(current["count"]) + 1
                    if current.get("unit") is None and metric.get("unit") is not None:
                        current["unit"] = metric.get("unit")
            if coordinate_kind == "normalized":
                x = float(row["normalized_x"])
                y = float(row["normalized_y"])
                min_x = x if min_x is None else min(min_x, x)
                max_x = x if max_x is None else max(max_x, x)
                min_y = y if min_y is None else min(min_y, y)
                max_y = y if max_y is None else max(max_y, y)
                coordinate = {"kind": "normalized", "x": x, "y": y}
            else:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                min_lat = lat if min_lat is None else min(min_lat, lat)
                max_lat = lat if max_lat is None else max(max_lat, lat)
                min_lon = lon if min_lon is None else min(min_lon, lon)
                max_lon = lon if max_lon is None else max(max_lon, lon)
                coordinate = {"kind": "gps", "lat": lat, "lon": lon}
            samples.append(
                SensorSampleRecord.model_validate(
                    {
                        "id": row["id"],
                        "sourceId": source_id,
                        "sourceLabel": row["source_label"],
                        "timestampMs": timestamp_ms,
                        "coordinate": coordinate,
                        "data": metrics,
                    }
                )
            )

        normalized_bounds = None
        if min_x is not None and max_x is not None and min_y is not None and max_y is not None:
            normalized_bounds = SensorNormalizedBounds(
                minX=min_x,
                maxX=max_x,
                minY=min_y,
                maxY=max_y,
            )
        gps_bounds = None
        if min_lat is not None and max_lat is not None and min_lon is not None and max_lon is not None:
            gps_bounds = SensorGpsBounds(
                minLat=min_lat,
                maxLat=max_lat,
                minLon=min_lon,
                maxLon=max_lon,
            )
        return SensorSnapshot(
            retentionSeconds=retention_seconds,
            sampleCount=len(samples),
            samples=samples,
            metrics=[
                SensorMetricStats.model_validate(metric)
                for _, metric in sorted(metric_acc.items(), key=lambda item: item[0].lower())
            ],
            sources=sorted(sources),
            sourceLabels=source_labels,
            latestTimestampMs=latest_timestamp_ms,
            coordinateKinds=sorted(coordinate_kinds),
            normalizedBounds=normalized_bounds,
            gpsBounds=gps_bounds,
        )

    def _publish(self, project_id: str, reason: str) -> None:
        with self._events_lock:
            current = self._events.get(project_id, {"version": 0, "reason": "snapshot"})
            self._events[project_id] = {
                "version": int(current["version"]) + 1,
                "reason": reason,
                "updatedAtMs": _now_ms(),
            }

    def get_event_state(self, project_id: str) -> dict[str, Any]:
        with self._events_lock:
            current = self._events.get(project_id)
            if current is None:
                return {"version": 0, "reason": "snapshot", "updatedAtMs": None}
            return dict(current)

    def ingest(
        self,
        project_id: str,
        samples: list[SensorSampleInput],
        retention_seconds: int | None = None,
    ) -> dict[str, Any]:
        project_manager.ensure_project_exists(project_id)
        platform_service.ensure_platform_schema()
        resolved_retention = int(
            retention_seconds
            if retention_seconds is not None
            else self._load_live_settings(project_id).bufferSeconds
        )
        now_ms = _now_ms()
        with platform_service._connect() as conn:
            self._upsert_buffer(conn, project_id, resolved_retention)
            for sample in samples:
                timestamp_ms = int(sample.timestampMs if sample.timestampMs is not None else now_ms)
                conn.execute(
                    """
                    INSERT INTO sensor_live_samples(
                        id,
                        project_id,
                        source_id,
                        source_label,
                        timestamp_ms,
                        coordinate_kind,
                        normalized_x,
                        normalized_y,
                        latitude,
                        longitude,
                        metrics_json,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid4()),
                        project_id,
                        sample.sourceId,
                        sample.sourceLabel,
                        timestamp_ms,
                        sample.coordinate.kind,
                        sample.coordinate.x,
                        sample.coordinate.y,
                        sample.coordinate.lat,
                        sample.coordinate.lon,
                        json.dumps(
                            [metric.model_dump(mode="json") for metric in sample.data],
                            ensure_ascii=False,
                            allow_nan=False,
                        ),
                        _utc_now(),
                    ),
                )
            purged = self._purge_expired(conn, project_id, resolved_retention, now_ms)
            snapshot = self._build_snapshot(conn, project_id, resolved_retention)
            conn.commit()
        self._publish(project_id, "ingest")
        return {
            "inserted": len(samples),
            "purged": purged,
            "retentionSeconds": resolved_retention,
            "snapshot": snapshot.model_dump(mode="json"),
        }

    def get_snapshot(self, project_id: str) -> SensorSnapshot:
        project_manager.ensure_project_exists(project_id)
        platform_service.ensure_platform_schema()
        resolved_retention = int(self._load_live_settings(project_id).bufferSeconds)
        now_ms = _now_ms()
        with platform_service._connect() as conn:
            self._upsert_buffer(conn, project_id, resolved_retention)
            purged = self._purge_expired(conn, project_id, resolved_retention, now_ms)
            snapshot = self._build_snapshot(conn, project_id, resolved_retention)
            conn.commit()
        if purged:
            self._publish(project_id, "retention")
        return snapshot

    def clear(self, project_id: str) -> dict[str, Any]:
        project_manager.ensure_project_exists(project_id)
        platform_service.ensure_platform_schema()
        with platform_service._connect() as conn:
            deleted = conn.execute(
                "DELETE FROM sensor_live_samples WHERE project_id = ?",
                (project_id,),
            ).rowcount or 0
            conn.commit()
        self._publish(project_id, "clear")
        return {"deleted": int(deleted), "projectId": project_id}


live_sensor_manager = LiveSensorManager()
