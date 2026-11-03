from __future__ import annotations

import logging
from typing import NoReturn

_import_error: ImportError | OSError | None = None

try:
    import jupedsim as jps
except (ImportError, OSError) as exc:
    jps = None
    _import_error = exc


def raise_jupedsim_unavailable() -> NoReturn:
    message = (
        "JuPedSim could not be loaded by the backend. "
        "Check the backend logs for the import error. On Windows, stop ShopAI "
        "and rerun ShopAI-Setup.exe to repair Python dependencies and the "
        "Microsoft Visual C++ x64 runtime."
    )
    if _import_error is not None:
        logging.getLogger(__name__).error(
            "JuPedSim import failed",
            exc_info=(type(_import_error), _import_error, _import_error.__traceback__),
        )
    raise RuntimeError(message) from _import_error
