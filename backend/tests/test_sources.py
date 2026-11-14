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
    _horizon_export_params,
    _horizon_profile_from_dem,
    fetch_horizon,
)
from app.sources import (
    DEM_SERVICES,
    PermanentShadowDataError,
    _fetch_dem_sample,
    _fetch_permanent_shadow,
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

    async def fake_get_json(_client, url, params):
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
    real_async_client = httpx.AsyncClient

    async def serve_image(request):
        observed["url"] = str(request.url.copy_with(query=None))
        observed["params"] = dict(request.url.params)
        return httpx.Response(200, content=b"II*\x00")

    def async_client(*args, **kwargs):
        return real_async_client(
            *args,
            transport=httpx.MockTransport(serve_image),
            **kwargs,
        )

    def fake_profile(_raster_bytes, _lat, _lon, _height, _bin, used_projection):
        observed["projection"] = used_projection
        return [0.0], [0.0]

    monkeypatch.setattr("app.horizon_source.httpx.AsyncClient", async_client)
    monkeypatch.setattr(
        "app.horizon_source._horizon_profile_from_tiff", fake_profile
    )

    result = asyncio.run(fetch_horizon(lat, 12.0, 2.0, 0.5))
    service = DEM_SERVICES[service_name]
    expected_url = service["url"].rsplit("/", 1)[0] + "/exportImage"

    assert observed["url"] == expected_url
    assert observed["projection"] == projection
    assert result["demVersion"] == service["version"]
    assert result["demResolutionM"] == resolution_m
    assert observed["params"]["format"] == "tiff"
    assert observed["params"]["pixelType"] == "F32"


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
