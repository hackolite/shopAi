from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path


def configure_file_logging() -> Path | None:
    log_directory = os.environ.get("SHOPAI_LOG_DIR")
    if not log_directory and os.name == "nt":
        log_directory = str(Path(os.environ["LOCALAPPDATA"]) / "ShopAI" / "logs")
    if not log_directory:
        return None

    log_path = Path(log_directory).resolve() / "backend.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    for existing in root.handlers:
        if isinstance(existing, RotatingFileHandler) and existing.baseFilename == str(log_path):
            return log_path

    handler = RotatingFileHandler(
        log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    handler.setLevel(logging.INFO)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root.addHandler(handler)
    if root.level > logging.INFO:
        root.setLevel(logging.INFO)
    # Uvicorn stops propagation at its parent logger.
    logging.getLogger("uvicorn").addHandler(handler)
    return log_path
