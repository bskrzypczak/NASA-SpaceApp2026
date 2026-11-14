import logging
import os
import threading
import time
import uuid
from pathlib import Path

from app import persistent_cache

logger = logging.getLogger(__name__)

DEM_WINDOW_CACHE_TTL = 24 * 60 * 60
DEM_WINDOW_CACHE_MAX_ENTRIES = 4
_memory_cache: dict[Path, tuple[float, bytes]] = {}
_memory_cache_lock = threading.Lock()


def _cache_directory() -> Path:
    return persistent_cache.CACHE_DIRECTORY / "dem-windows"


def _remember(path: Path, content: bytes, modified_at: float) -> None:
    with _memory_cache_lock:
        _memory_cache[path] = (modified_at, content)
        while len(_memory_cache) > 1:
            oldest_path = min(
                _memory_cache,
                key=lambda cached_path: _memory_cache[cached_path][0],
            )
            del _memory_cache[oldest_path]


def _remove(path: Path) -> None:
    with _memory_cache_lock:
        _memory_cache.pop(path, None)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("DEM window cache cleanup failed for %s.", path, exc_info=True)


def _read(path: Path) -> bytes | None:
    try:
        modified_at = path.stat().st_mtime
    except FileNotFoundError:
        return None
    except OSError:
        logger.warning("DEM window cache stat failed for %s.", path, exc_info=True)
        return None

    if time.time() - modified_at >= DEM_WINDOW_CACHE_TTL:
        _remove(path)
        return None

    with _memory_cache_lock:
        cached = _memory_cache.get(path)
        if cached is not None and cached[0] == modified_at:
            return cached[1]

    try:
        content = path.read_bytes()
    except OSError:
        logger.warning("DEM window cache read failed for %s.", path, exc_info=True)
        return None
    if not content.startswith((b"II*\x00", b"MM\x00*")):
        logger.warning("Invalid DEM window cache entry %s; discarding it.", path)
        _remove(path)
        return None

    _remember(path, content, modified_at)
    return content


def _prune_cache(directory: Path) -> None:
    try:
        entries = sorted(
            directory.glob("*.tif"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        logger.warning("DEM window cache listing failed.", exc_info=True)
        return

    now = time.time()
    for path in entries:
        try:
            expired = now - path.stat().st_mtime >= DEM_WINDOW_CACHE_TTL
        except OSError:
            expired = True
        if expired:
            _remove(path)
    for path in entries[DEM_WINDOW_CACHE_MAX_ENTRIES:]:
        _remove(path)


def _write(path: Path, content: bytes) -> None:
    directory = path.parent
    temporary_path = directory / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        temporary_path.write_bytes(content)
        os.replace(temporary_path, path)
        modified_at = path.stat().st_mtime
        _remember(path, content, modified_at)
        _prune_cache(directory)
    except OSError:
        logger.warning("DEM window cache write failed for %s.", path, exc_info=True)
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            logger.warning(
                "DEM window temporary cache cleanup failed for %s.",
                temporary_path,
                exc_info=True,
            )


def _path_for_key(key: str) -> Path:
    return _cache_directory() / f"{key}.tif"


async def read_dem_window(key: str) -> bytes | None:
    import asyncio

    return await asyncio.to_thread(_read, _path_for_key(key))


async def write_dem_window(key: str, content: bytes) -> None:
    import asyncio

    await asyncio.to_thread(_write, _path_for_key(key), content)
