import asyncio

import numpy as np
import pytest
from fastapi import HTTPException

from app.sources import (
    PermanentShadowDataError,
    _fetch_permanent_shadow,
    _horizon_profile_from_dem,
    _parse_horizons_response,
    _south_polar_stereographic_xy,
    _slope_from_cardinal_samples,
    fetch_lunar_elevation,
)


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


def test_horizon_profile_accounts_for_curvature_and_directional_ridge():
    dem = np.zeros((12, 12), dtype=np.float32)
    parameters = {
        "left_m": -550.0,
        "top_m": 550.0,
        "pixel_width_m": 100.0,
        "pixel_height_m": 100.0,
        "nodata": None,
        "center_x_m": 0.0,
        "center_y_m": 0.0,
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
        left_m=-150.0,
        top_m=150.0,
        pixel_width_m=100.0,
        pixel_height_m=100.0,
        nodata=None,
        center_x_m=0.0,
        center_y_m=0.0,
        lat=-90.0,
        lon=0.0,
        height_m=2.0,
        bin_deg=bin_deg,
        max_distance_m=100.0,
    )

    assert len(azimuths) == expected_count
    assert len(elevations) == expected_count
    assert azimuths[-1] == pytest.approx(360.0 - bin_deg)


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
