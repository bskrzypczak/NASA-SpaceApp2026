import math

import numpy as np
import pytest
from affine import Affine
from rasterio.io import MemoryFile
from fastapi.testclient import TestClient

from app.layer_grid_source import _sample_psr_dataset, build_slope_grid
from app.main import app

client = TestClient(app)
API = "/api/v1"


def test_slope_grid_uses_horn_gradient_and_marks_unavailable_edges_null():
    cell_size_m = 1.0
    heights = [
        [row * 0.2 + col * 0.1 for col in range(5)]
        for row in range(5)
    ]

    grid = build_slope_grid(
        {
            "lat": -89.45,
            "lon": -137.3,
            "sizeKm": 0.005,
            "res": 5,
            "heightsM": heights,
            "demResolutionM": 100.0,
            "demVersion": "test-dem",
        }
    )

    expected_slope = round(
        math.degrees(math.atan(math.hypot(0.1 / cell_size_m, 0.2 / cell_size_m))),
        3,
    )
    assert grid["kind"] == "continuous"
    assert grid["unit"] == "deg"
    assert grid["source"] == "LOLA DEM 100 m/px"
    assert grid["version"] == "test-dem"
    assert grid["min"] == expected_slope
    assert grid["max"] == expected_slope
    assert grid["values"][0] == [None] * 5
    assert grid["values"][2][2] == expected_slope


def test_slope_grid_returns_null_when_a_neighborhood_contains_nodata():
    heights = [[float(row + col) for col in range(5)] for row in range(5)]
    heights[2][2] = None

    grid = build_slope_grid(
        {
            "lat": -89.45,
            "lon": -137.3,
            "sizeKm": 0.005,
            "res": 5,
            "heightsM": heights,
            "demResolutionM": 100.0,
            "demVersion": "test-dem",
        }
    )

    assert grid["min"] is None
    assert grid["max"] is None
    assert all(value is None for row in grid["values"] for value in row)


def test_psr_grid_sampling_preserves_orientation_and_treats_nodata_inside_map_as_not_psr():
    raster = np.asarray(
        [
            [1, 0, 1],
            [0, -9999, 1],
            [1, 1, 0],
        ],
        dtype=np.float32,
    )
    projected_x = np.asarray([[0.5, 1.5, 1.5, 5.0]])
    projected_y = np.asarray([[2.5, 2.5, 1.5, 2.5]])

    with MemoryFile() as memory_file:
        with memory_file.open(
            driver="GTiff",
            height=3,
            width=3,
            count=1,
            dtype="float32",
            nodata=-9999,
            transform=Affine(1, 0, 0, 0, -1, 3),
        ) as dataset:
            dataset.write(raster, 1)
            values = _sample_psr_dataset(dataset, projected_x, projected_y)

    # NoData inside the raster = not PSR (0); outside the raster extent = unknown (NaN → null).
    np.testing.assert_equal(values, [[1.0, 0.0, 0.0, np.nan]])


def test_slope_grid_endpoint_reuses_heightmap_coordinates_and_resolution(
    monkeypatch,
):
    observed = {}

    async def fake_heightmap(lat, lon, size_km, res):
        observed.update(lat=lat, lon=lon, size_km=size_km, res=res)
        return {
            "lat": lat,
            "lon": lon,
            "sizeKm": size_km,
            "res": res,
            "heightsM": [[0.0] * res for _ in range(res)],
            "demResolutionM": 100.0,
            "demVersion": "test-dem",
        }

    monkeypatch.setattr("app.main.fetch_lunar_heightmap", fake_heightmap)
    response = client.get(
        f"{API}/layers/slope/grid",
        params={"lat": -89.45, "lon": 222.7, "sizeKm": 20, "res": 16},
    )

    assert response.status_code == 200
    assert observed == {
        "lat": -89.45,
        "lon": -137.3,
        "size_km": 20,
        "res": 16,
    }
    grid = response.json()
    assert grid["layerId"] == "slope"
    assert grid["sizeKm"] == 20
    assert grid["res"] == 16
    assert grid["northUp"] is True
    assert len(grid["values"]) == 16
    assert all(len(row) == 16 for row in grid["values"])
    assert grid["values"][0] == [None] * 16
    assert grid["min"] == grid["max"] == 0


def test_psr_grid_endpoint_returns_layer_contract(monkeypatch):
    async def fake_psr_grid(lat, lon, size_km, res):
        assert (lat, lon, size_km, res) == (-89.45, -137.3, 20, 16)
        return {
            "layerId": "psr",
            "lat": lat,
            "lon": lon,
            "sizeKm": size_km,
            "res": res,
            "kind": "mask",
            "unit": None,
            "min": 0,
            "max": 1,
            "values": [[0, 1] + [None] * 14] + [[None] * 16 for _ in range(15)],
            "northUp": True,
            "source": "NASA GSFC PGDA LPSR PSR map",
            "version": "LPSR_80S_20MPP_ADJ",
        }

    monkeypatch.setattr("app.main.fetch_psr_grid", fake_psr_grid)
    response = client.get(
        f"{API}/layers/psr/grid",
        params={"lat": -89.45, "lon": 222.7, "sizeKm": 20, "res": 16},
    )

    assert response.status_code == 200
    assert response.json()["layerId"] == "psr"
    assert response.json()["kind"] == "mask"
    assert response.json()["unit"] is None
    assert response.json()["values"][0][:2] == [0, 1]


@pytest.mark.parametrize(
    ("layer_id", "params", "expected_status", "expected_code"),
    [
        ("not-a-layer", {"lat": 0, "lon": 0}, 404, "LAYER_NOT_FOUND"),
        ("slope", {"lat": 0, "lon": 0, "sizeKm": 15}, 422, "VALIDATION_ERROR"),
        ("psr", {"lat": 0, "lon": 0, "res": 513}, 422, "VALIDATION_ERROR"),
        ("psr", {"lat": 0, "lon": 0, "res": "invalid"}, 422, "VALIDATION_ERROR"),
    ],
)
def test_layer_grid_endpoint_errors(
    layer_id,
    params,
    expected_status,
    expected_code,
):
    response = client.get(f"{API}/layers/{layer_id}/grid", params=params)

    assert response.status_code == expected_status
    assert response.json()["error"]["code"] == expected_code
