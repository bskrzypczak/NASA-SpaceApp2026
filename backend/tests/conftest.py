import pytest

from app import persistent_cache


@pytest.fixture(autouse=True)
def isolate_persistent_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(
        persistent_cache,
        "CACHE_DB_PATH",
        tmp_path / "backend-cache.sqlite3",
    )
