from app import persistent_cache, sources


def test_source_cache_loads_persisted_value_after_memory_is_cleared(
    monkeypatch,
):
    monkeypatch.setattr(sources, "_cache", {})
    key = "horizon:test-site"
    expected = {"elevationDeg": [0.1, 0.2]}

    sources._cache_set(key, expected, 60)
    sources._cache.clear()

    assert sources._cache_get(key) == expected


def test_expired_persistent_cache_entry_is_a_miss():
    persistent_cache.set("dem:test-site", {"elevationM": 100}, 0)

    assert persistent_cache.get("dem:test-site") is None
