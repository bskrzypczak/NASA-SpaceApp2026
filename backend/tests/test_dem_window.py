import asyncio
from types import SimpleNamespace

import httpx

from app import dem_window_cache
from app.dem_window_source import fetch_dem_window
from app.horizon_source import prepare_horizon_profiles
from app.sources import DEM_SERVICES


def test_dem_window_is_cached_on_disk_and_reused_for_nearby_coordinates(
    monkeypatch, tmp_path
):
    observed = []
    monkeypatch.setattr(
        "app.dem_window_cache.persistent_cache.CACHE_DIRECTORY", tmp_path
    )
    dem_window_cache._memory_cache.clear()

    async def fake_get_response(_client, url, params, **_kwargs):
        observed.append((url, params))
        return httpx.Response(200, content=b"II*\x00valid-window")

    monkeypatch.setattr(
        "app.dem_window_source._get_moon_trek_response", fake_get_response
    )

    first = asyncio.run(
        fetch_dem_window(
            -89.45,
            -137.3,
            required_margin_m=160_000,
        )
    )
    dem_window_cache._memory_cache.clear()
    second = asyncio.run(
        fetch_dem_window(
            -89.45,
            -137.29,
            required_margin_m=160_000,
        )
    )

    assert first.content == second.content == b"II*\x00valid-window"
    assert first.key == second.key
    assert len(observed) == 1
    assert observed[0][0] == (
        DEM_SERVICES["south-pole"]["url"].rsplit("/", 1)[0] + "/exportImage"
    )
    assert observed[0][1]["size"] == "3041,3041"
    left, bottom, right, top = map(
        float, observed[0][1]["bbox"].split(",")
    )
    assert right - left == 340_000
    assert top - bottom == 340_000


def test_horizon_profiles_for_nearby_points_share_one_dem_window(monkeypatch):
    window_requests = []
    profile_batches = []
    cached_profiles = []

    async def fake_get_dem_window(
        lat, lon, service, *, required_margin_m
    ):
        window_requests.append((lat, lon, service, required_margin_m))
        return SimpleNamespace(content=b"shared-window")

    def fake_profiles(content, requests, projection):
        profile_batches.append((content, requests, projection))
        return [([0.0], [1.0]) for _ in requests]

    monkeypatch.setattr(
        "app.dem_window_source.fetch_dem_window", fake_get_dem_window
    )
    monkeypatch.setattr(
        "app.horizon_source._horizon_profiles_from_tiff", fake_profiles
    )
    monkeypatch.setattr("app.horizon_source._cache_get", lambda _key: None)
    monkeypatch.setattr(
        "app.horizon_source._cache_set",
        lambda key, value, _ttl: cached_profiles.append((key, value)),
    )

    asyncio.run(
        prepare_horizon_profiles(
            -89.45,
            -137.3,
            [
                (-89.45, -137.3),
                (-89.44, -137.3),
                (-89.46, -137.3),
            ],
            (2.0, 3.5),
            neighborhood_radius_m=10_000,
        )
    )

    assert len(window_requests) == 1
    assert window_requests[0][3] == 160_000
    assert len(profile_batches) == 1
    assert profile_batches[0][0] == b"shared-window"
    assert len(profile_batches[0][1]) == 6
    assert len(cached_profiles) == 6
