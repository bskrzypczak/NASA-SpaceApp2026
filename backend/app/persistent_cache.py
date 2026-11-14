import json
import logging
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_CACHE_DIRECTORY = Path(__file__).resolve().parents[1] / ".cache"
CACHE_DIRECTORY = Path(
    os.getenv("HORIZON_CACHE_DIR") or DEFAULT_CACHE_DIRECTORY
)
CACHE_DB_PATH = CACHE_DIRECTORY / "backend-cache.sqlite3"
MAX_DISK_CACHE_ENTRIES = 1024


def _connect() -> sqlite3.Connection:
    CACHE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(CACHE_DB_PATH, timeout=30)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cache_entries (
            key TEXT PRIMARY KEY,
            expires_at REAL NOT NULL,
            payload TEXT NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    return connection


def get(key: str) -> tuple[dict[str, Any], float] | None:
    try:
        with closing(_connect()) as connection, connection:
            row = connection.execute(
                "SELECT expires_at, payload FROM cache_entries WHERE key = ?",
                (key,),
            ).fetchone()
            if row is None:
                return None

            expires_at, payload = row
            remaining_ttl = expires_at - time.time()
            if remaining_ttl <= 0:
                connection.execute(
                    "DELETE FROM cache_entries WHERE key = ?", (key,)
                )
                return None

            try:
                value = json.loads(payload)
            except json.JSONDecodeError:
                logger.warning(
                    "Persistent cache entry is invalid; discarding it.",
                    exc_info=True,
                )
                connection.execute(
                    "DELETE FROM cache_entries WHERE key = ?", (key,)
                )
                return None
            if not isinstance(value, dict):
                logger.warning(
                    "Persistent cache entry is not an object; discarding it."
                )
                connection.execute(
                    "DELETE FROM cache_entries WHERE key = ?", (key,)
                )
                return None
            return value, remaining_ttl
    except (OSError, sqlite3.Error):
        logger.warning("Persistent cache read failed.", exc_info=True)
        return None


def set(
    key: str,
    value: dict[str, Any],
    ttl: int,
    *,
    prefix_limit: int | None = None,
) -> None:
    now = time.time()
    payload = json.dumps(value, separators=(",", ":"), allow_nan=False)
    try:
        with closing(_connect()) as connection, connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO cache_entries
                    (key, expires_at, payload, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (key, now + ttl, payload, now),
            )
            connection.execute(
                "DELETE FROM cache_entries WHERE expires_at <= ?", (now,)
            )
            if prefix_limit is not None:
                prefix = key.partition(":")[0] + ":"
                connection.execute(
                    """
                    DELETE FROM cache_entries
                    WHERE key IN (
                        SELECT key FROM cache_entries
                        WHERE substr(key, 1, ?) = ?
                        ORDER BY updated_at DESC
                        LIMIT -1 OFFSET ?
                    )
                    """,
                    (len(prefix), prefix, prefix_limit),
                )
            connection.execute(
                """
                DELETE FROM cache_entries
                WHERE key IN (
                    SELECT key FROM cache_entries
                    ORDER BY updated_at DESC
                    LIMIT -1 OFFSET ?
                )
                """,
                (MAX_DISK_CACHE_ENTRIES,),
            )
    except (OSError, sqlite3.Error):
        logger.warning("Persistent cache write failed.", exc_info=True)
