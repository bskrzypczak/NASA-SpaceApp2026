import asyncio
import json
import logging
from types import SimpleNamespace

import httpx
import numpy as np
import pytest
from fastapi import HTTPException

from app.heightmap_source import (
    HeightmapOutOfCoverageError,
    _heightmap_export_params,
    _heightmap_from_dem,
)
from app.horizon_source import (
    _horizon_profile_from_dem,
    fetch_horizon,
)
from app.heightmap_source import fetch_lunar_heightmap
from app.sources import (
    DEM_SERVICES,
    PermanentShadowDataError,
    _fetch_dem_sample,
    _fetch_permanent_shadow,
    _get_moon_trek_response,
    MOON_TREK_LANE_LIMITS,
    PARTIAL_RESULT_TTL,
    _sample_dem_window,
    single_flight,
    _get_json,
    _north_polar_stereographic_xy,
    _parse_horizons_response,
    _south_polar_stereographic_xy,
    _slope_from_cardinal_samples,
    fetch_lunar_elevation,
)


def test_upstream_request_failure_logs_original_exception(caplog):
    request = httpx.Request("GET", "https://example.test/data")
    failure = httpx.ConnectError("connection refused", request=request)

    def fail_request(failed_request):
        assert failed_request.url == request.url
        raise failure

    async def fetch():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(fail_request)
        ) as client:
            await _get_json(client, "https://example.test/data", {})

    caplog.set_level(logging.ERROR, logger="app.sources")
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(fetch())

    assert exc_info.value.status_code == 502
    log_record = next(
        record
        for record in caplog.records
        if record.name == "app.sources" and record.exc_info is not None
    )
    assert log_record.exc_info[0] is httpx.ConnectError
    assert log_record.exc_info[1] is failure


@pytest.mark.parametrize(
    "failure_type", [httpx.RemoteProtocolError, httpx.ReadTimeout]
)
def test_moon_trek_retries_transient_connection_failures(failure_type):
    attempts = 0

    async def handle_request(request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise failure_type("connection interrupted", request=request)
        return httpx.Response(200, json={"ok": True})

    async def fetch():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handle_request)
        ) as client:
            return await _get_moon_trek_response(
                client, "https://example.test/data", {}
            )

    response = asyncio.run(fetch())

    assert response.json() == {"ok": True}
    assert attempts == 2


@pytest.mark.parametrize("lane", ["light", "bulk"])
def test_moon_trek_limits_concurrent_requests_per_lane(lane):
    active_requests = 0
    max_active_requests = 0

    async def handle_request(_request):
        nonlocal active_requests, max_active_requests
        active_requests += 1
        max_active_requests = max(max_active_requests, active_requests)
        await asyncio.sleep(0.01)
        active_requests -= 1
        return httpx.Response(200, json={"ok": True})

    async def fetch_all():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handle_request)
        ) as client:
            await asyncio.gather(
                *(
                    _get_moon_trek_response(
                        client, "https://example.test/data", {}, lane=lane
                    )
                    for _ in range(8)
                )
            )

    asyncio.run(fetch_all())

    assert max_active_requests == MOON_TREK_LANE_LIMITS[lane]


def test_bulk_dem_export_does_not_block_light_requests():
    """A slow 38 MB window export must not delay point-elevation requests."""
    order = []

    async def handle_request(request):
        if "bulk" in str(request.url):
            await asyncio.sleep(0.2)
        order.append(str(request.url).rsplit("/", 1)[1])
        return httpx.Response(200, json={"ok": True})

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handle_request)
        ) as client:
            bulk = asyncio.ensure_future(
                _get_moon_trek_response(client, "https://example.test/bulk", {}, lane="bulk")
            )
            await asyncio.sleep(0)
            await _get_moon_trek_response(client, "https://example.test/light", {})
            await bulk

    asyncio.run(run())

    assert order == ["light", "bulk"]


def test_single_flight_shares_one_call_between_concurrent_callers():
    calls = 0

    async def work():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {"value": 42}

    async def run():
        return await asyncio.gather(*(single_flight("k", work) for _ in range(5)))

    results = asyncio.run(run())

    assert calls == 1
    assert all(result == {"value": 42} for result in results)


def test_terrain_point_keeps_elevation_when_psr_and_neighbours_fail(monkeypatch):
    async def no_window(*_args, **_kwargs):
        return None

    async def sample(_client, _service, lat, lon):
        if (lat, lon) == (-88.1, 21.3):
            return 1500.0
        raise HTTPException(status_code=504, detail={"code": "TIMEOUT"})

    async def failing_shadow(_lat, _lon):
        raise HTTPException(status_code=504, detail={"code": "TIMEOUT"})

    cached = {}
    monkeypatch.setattr("app.dem_window_source.find_cached_dem_window", no_window)
    monkeypatch.setattr("app.sources._fetch_dem_sample", sample)
    monkeypatch.setattr("app.sources._fetch_permanent_shadow", failing_shadow)
    monkeypatch.setattr("app.sources._cache_get", lambda _key: None)
    monkeypatch.setattr(
        "app.sources._cache_set",
        lambda key, value, ttl, **_kwargs: cached.update({"ttl": ttl}),
    )

    result = asyncio.run(fetch_lunar_elevation(-88.1, 21.3))

    assert result["elevationM"] == 1500.0
    assert result["slopeDeg"] is None
    assert result["inPermanentShadow"] is None
    assert result["complete"] is False
    assert cached["ttl"] == PARTIAL_RESULT_TTL


def test_cached_global_window_is_sampled_in_degrees():
    """Regression: global (non-polar) windows were sampled with north-polar metres."""
    np = pytest.importorskip("numpy")
    rasterio = pytest.importorskip("rasterio")
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin

    data = np.arange(100, dtype="float32").reshape(10, 10)
    with MemoryFile() as memory_file:
        with memory_file.open(
            driver="GTiff", width=10, height=10, count=1, dtype="float32",
            transform=from_origin(20.0, 5.0, 1.0, 1.0),
        ) as dataset:
            dataset.write(data, 1)
        content = memory_file.read()

    result = _sample_dem_window(
        content,
        DEM_SERVICES["global"],
        {"center": (0.5, 24.5)},
    )

    assert result["center"] == float(data[4, 4])


def test_slope_uses_central_difference_and_returns_degrees():
    slope = _slope_from_cardinal_samples(
        north_m=20,
        south_m=-20,
        east_m=10,
        west_m=-10,
        north_south_spacing_m=200,
        east_west_spacing_m=200,
    )

    assert round(slope, 3) == 12.604


def test_psr_projection_matches_moon_south_polar_projection():
    x, y = _south_polar_stereographic_xy(-89.45, -137.3)

    assert x == pytest.approx(-11310.3272)
    assert y == pytest.approx(-12256.8842)


@pytest.mark.parametrize(
    ("service_name", "lat", "lon", "expected_x", "expected_y", "expected_sr"),
    [
        ("south-pole", -89.45, -137.3, -11310.3272, -12256.8842, "104903"),
        ("north-pole", 89.45, -137.3, -11310.3272, 12256.8842, "104904"),
        ("global", 10.0, -137.3, -137.3, 10.0, None),
    ],
)
def test_dem_samples_use_native_service_coordinates(
    monkeypatch, service_name, lat, lon, expected_x, expected_y, expected_sr
):
    observed = {}

    async def fake_get_json(_client, url, params, *, moon_trek=False):
        assert moon_trek is True
        observed["url"] = url
        observed["params"] = params
        return {"value": "123.5"}

    monkeypatch.setattr("app.sources._get_json", fake_get_json)

    async def fetch_sample():
        async with httpx.AsyncClient() as client:
            return await _fetch_dem_sample(
                client, DEM_SERVICES[service_name], lat, lon
            )

    result = asyncio.run(fetch_sample())
    geometry = json.loads(observed["params"]["geometry"])

    assert result == 123.5
    assert geometry["x"] == pytest.approx(expected_x)
    assert geometry["y"] == pytest.approx(expected_y)
    assert observed["params"].get("sr") == expected_sr


def test_north_polar_projection_matches_moon_north_polar_projection():
    x, y = _north_polar_stereographic_xy(89.45, -137.3)

    assert x == pytest.approx(-11310.3272)
    assert y == pytest.approx(12256.8842)


def test_heightmap_uses_local_north_up_grid_relative_to_origin():
    dem = np.fromfunction(lambda row, _col: 1000 - row, (300, 300), dtype=float)
    heightmap = _heightmap_from_dem(
        dem,
        transform=SimpleNamespace(a=0.001, c=-0.15, e=-0.001, f=0.15),
        nodata=None,
        lat=0.0,
        lon=0.0,
        size_km=1,
        res=4,
        projection="geographic",
        dem_version="test-dem",
        dem_resolution_m=100,
    )

    assert heightmap["originElevationM"] == pytest.approx(850.5)
    assert heightmap["heightsM"][2][2] == 0
    assert heightmap["heightsM"][0][2] > heightmap["heightsM"][3][2]
    assert heightmap["northUp"] is True
    assert heightmap["minElevationM"] == min(map(min, heightmap["heightsM"]))
    assert heightmap["maxElevationM"] == max(map(max, heightmap["heightsM"]))


def test_heightmap_rejects_nodata_inside_requested_area():
    dem = np.ones((300, 300), dtype=np.float32)
    dem[149:151, 149:151] = -9999
    with pytest.raises(HeightmapOutOfCoverageError):
        _heightmap_from_dem(
            dem,
            transform=SimpleNamespace(a=0.001, c=-0.15, e=-0.001, f=0.15),
            nodata=-9999,
            lat=0.0,
            lon=0.0,
            size_km=1,
            res=4,
            projection="geographic",
            dem_version="test-dem",
            dem_resolution_m=100,
        )


def test_heightmap_rejects_unmarked_float32_nodata():
    dem = np.ones((300, 300), dtype=np.float32)
    dem[149:151, 149:151] = np.finfo(np.float32).min
    with pytest.raises(HeightmapOutOfCoverageError):
        _heightmap_from_dem(
            dem,
            transform=SimpleNamespace(a=0.001, c=-0.15, e=-0.001, f=0.15),
            nodata=None,
            lat=0.0,
            lon=0.0,
            size_km=1,
            res=4,
            projection="geographic",
            dem_version="test-dem",
            dem_resolution_m=100,
        )


def test_heightmap_export_uses_polar_projection_and_covers_local_square():
    params = _heightmap_export_params(
        -89.45, -137.3, 20, 256, DEM_SERVICES["south-pole"]
    )

    assert "bboxSR" not in params
    assert "imageSR" not in params
    assert "interpolation" not in params
    assert params["format"] == "tiff"
    assert params["pixelType"] == "F32"
    left, bottom, right, top = map(float, params["bbox"].split(","))
    assert right > left
    assert top > bottom
    assert max(map(int, params["size"].split(","))) <= 1024


def test_horizon_profile_accounts_for_curvature_and_directional_ridge():
    dem = np.zeros((12, 12), dtype=np.float32)
    parameters = {
        "left": -550.0,
        "top": 550.0,
        "pixel_width": 100.0,
        "pixel_height": 100.0,
        "nodata": None,
        "center_x": 0.0,
        "center_y": 0.0,
        "lat": -90.0,
        "lon": 0.0,
        "height_m": 2.0,
        "bin_deg": 90.0,
        "max_distance_m": 500.0,
    }

    azimuths, flat_horizon = _horizon_profile_from_dem(dem, **parameters)

    assert azimuths == [0.0, 90.0, 180.0, 270.0]
    assert flat_horizon == [-0.237, -0.237, -0.237, -0.237]

    dem[3, 5] = 100.0
    _, ridge_horizon = _horizon_profile_from_dem(dem, **parameters)

    assert ridge_horizon[0] > 25.0
    assert ridge_horizon[1:] == flat_horizon[1:]


@pytest.mark.parametrize(
    ("bin_deg", "expected_count"),
    [(0.5, 720), (0.1, 3600)],
)
def test_horizon_profile_returns_all_requested_azimuth_bins(
    bin_deg, expected_count
):
    dem = np.zeros((4, 4), dtype=np.float32)
    azimuths, elevations = _horizon_profile_from_dem(
        dem,
        left=-150.0,
        top=150.0,
        pixel_width=100.0,
        pixel_height=100.0,
        nodata=None,
        center_x=0.0,
        center_y=0.0,
        lat=-90.0,
        lon=0.0,
        height_m=2.0,
        bin_deg=bin_deg,
        max_distance_m=100.0,
    )

    assert len(azimuths) == expected_count
    assert len(elevations) == expected_count
    assert azimuths[-1] == pytest.approx(360.0 - bin_deg)


def test_horizon_profile_supports_geographic_dem_coordinates():
    dem = np.zeros((7, 7), dtype=np.float32)
    azimuths, elevations = _horizon_profile_from_dem(
        dem,
        left=-0.175,
        top=0.175,
        pixel_width=0.05,
        pixel_height=0.05,
        nodata=None,
        center_x=0.0,
        center_y=0.0,
        lat=0.0,
        lon=0.0,
        height_m=2.0,
        bin_deg=90.0,
        projection="geographic",
        max_distance_m=100.0,
    )

    assert azimuths == [0.0, 90.0, 180.0, 270.0]
    assert elevations == pytest.approx([-1.148] * 4, abs=0.001)


@pytest.mark.parametrize(
    ("lat", "service_name", "projection", "resolution_m"),
    [
        (-89.45, "south-pole", "south-polar", 100.0),
        (0.0, "global", "geographic", 118.5),
        (89.45, "north-pole", "north-polar", 100.0),
    ],
)
def test_fetch_horizon_selects_dem_service_and_reports_its_metadata(
    monkeypatch, lat, service_name, projection, resolution_m
):
    observed = {}
    async def fake_dem_window(used_lat, used_lon, used_service):
        observed["service"] = used_service
        return SimpleNamespace(content=b"test-window")

    def fake_profiles(_raster_bytes, requests, used_projection):
        observed["projection"] = used_projection
        observed["requests"] = requests
        return [([0.0], [0.0])]

    monkeypatch.setattr(
        "app.dem_window_source.fetch_dem_window", fake_dem_window
    )
    monkeypatch.setattr(
        "app.horizon_source._horizon_profiles_from_tiff", fake_profiles
    )
    monkeypatch.setattr("app.horizon_source._cache_get", lambda _key: None)
    monkeypatch.setattr("app.horizon_source._cache_set", lambda *_args, **_kwargs: None)

    result = asyncio.run(fetch_horizon(lat, 12.0, 2.0, 0.5))
    service = DEM_SERVICES[service_name]
    assert observed["service"] == service
    assert observed["projection"] == projection
    assert observed["requests"] == [(lat, 12.0, 2.0, 0.5)]
    assert result["demVersion"] == service["version"]
    assert result["demResolutionM"] == resolution_m


def test_psr_map_values_become_booleans_and_nodata_stays_unknown(monkeypatch):
    monkeypatch.setattr("app.sources._read_psr_raster_value", lambda _lat, _lon: 1.0)
    assert asyncio.run(_fetch_permanent_shadow(-88.0, 0.0)) is True

    monkeypatch.setattr("app.sources._read_psr_raster_value", lambda _lat, _lon: 0.0)
    assert asyncio.run(_fetch_permanent_shadow(-88.0, 0.0)) is False

    monkeypatch.setattr(
        "app.sources._read_psr_raster_value", lambda _lat, _lon: float("nan")
    )
    assert asyncio.run(_fetch_permanent_shadow(-88.0, 0.0)) is None


def test_psr_outside_map_coverage_is_unknown_without_reading(monkeypatch):
    def fail_if_read(_lat, _lon):
        raise AssertionError("The PSR raster should not be read outside its coverage.")

    monkeypatch.setattr("app.sources._read_psr_raster_value", fail_if_read)
    assert asyncio.run(_fetch_permanent_shadow(-79.9, 0.0)) is None


def test_psr_read_failure_is_reported_instead_of_returning_false(monkeypatch):
    def fail_read(_lat, _lon):
        raise PermanentShadowDataError("upstream read failed")

    monkeypatch.setattr("app.sources._read_psr_raster_value", fail_read)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_fetch_permanent_shadow(-88.0, 0.0))

    assert exc_info.value.status_code == 502


def test_terrain_result_includes_psr_value(monkeypatch):
    async def fake_dem_sample(_client, _service, _lat, _lon):
        return 100.0

    monkeypatch.setattr("app.sources._fetch_dem_sample", fake_dem_sample)
    monkeypatch.setattr("app.sources._read_psr_raster_value", lambda _lat, _lon: 1.0)

    result = asyncio.run(fetch_lunar_elevation(-88.1, 21.3))

    assert result["inPermanentShadow"] is True


def test_terrain_point_samples_cached_dem_window_without_moon_trek_calls(
    monkeypatch,
):
    observed = {}

    async def fake_window(lat, lon, service, **_kwargs):
        observed["window"] = (lat, lon, service)
        return SimpleNamespace(content=b"cached-dem")

    def fake_sample(_content, _service, sample_points):
        observed["sample_points"] = sample_points
        return {
            "center": 100.0,
            "north": 101.0,
            "south": 99.0,
            "east": 102.0,
            "west": 98.0,
        }

    async def fake_shadow(_lat, _lon):
        return False

    async def unexpected_sample(*_args):
        raise AssertionError("A cached DEM window should avoid identify calls.")

    monkeypatch.setattr("app.dem_window_source.find_cached_dem_window", fake_window)
    monkeypatch.setattr("app.sources._sample_dem_window", fake_sample)
    monkeypatch.setattr("app.sources._fetch_permanent_shadow", fake_shadow)
    monkeypatch.setattr("app.sources._fetch_dem_sample", unexpected_sample)
    monkeypatch.setattr("app.sources._cache_get", lambda _key: None)
    monkeypatch.setattr("app.sources._cache_set", lambda *_args, **_kwargs: None)

    result = asyncio.run(fetch_lunar_elevation(-88.1, 21.3))

    assert result["elevationM"] == 100.0
    assert result["slopeDeg"] == pytest.approx(1.281)
    assert result["inPermanentShadow"] is False
    assert set(observed["sample_points"]) == {
        "center",
        "north",
        "south",
        "east",
        "west",
    }


def test_heightmap_reuses_cached_dem_window(monkeypatch):
    observed = {}
    heightmap = {
        "lat": -89.45,
        "lon": -137.3,
        "sizeKm": 10,
        "res": 16,
        "heightsM": [[0.0] * 16 for _ in range(16)],
    }

    async def fake_window(lat, lon, service, **_kwargs):
        observed["window"] = (lat, lon, service)
        return SimpleNamespace(content=b"cached-dem")

    def fake_heightmap(
        content, lat, lon, size_km, res, service
    ):
        observed["heightmap"] = (content, lat, lon, size_km, res, service)
        return heightmap

    monkeypatch.setattr(
        "app.dem_window_source.find_cached_dem_window", fake_window
    )
    monkeypatch.setattr(
        "app.heightmap_source._heightmap_from_tiff", fake_heightmap
    )
    monkeypatch.setattr("app.heightmap_source._cache_get", lambda _key: None)
    monkeypatch.setattr(
        "app.heightmap_source._cache_set", lambda *_args, **_kwargs: None
    )

    result = asyncio.run(fetch_lunar_heightmap(-89.45, -137.3, 10, 16))

    assert result is heightmap
    assert observed["heightmap"][0] == b"cached-dem"


def test_parse_horizons_csv_table_and_de441_model():
    payload = {
        "signature": {"version": "1.2"},
        "result": """
Target body name: Sun (10) {source: DE441}
$$SOE
 2027-Mar-14 06:00, ,i, 241.197254, -1.097653, 0.99326490005374, 1.3845965,
 2027-Mar-14 06:10, ,i, 241.112614, -1.098538, 0.99327045428997, 1.3850763,
$$EOE
""",
    }

    result = _parse_horizons_response(payload)

    assert result["version"] == "1.2"
    assert result["model"] == "DE441"
    assert result["samples"][0]["time"] == "2027-03-14T06:00:00Z"
    assert result["samples"][0]["azDeg"] == 241.197254
    assert result["samples"][0]["elDeg"] == -1.097653
    assert result["samples"][0]["distanceKm"] > 140_000_000
