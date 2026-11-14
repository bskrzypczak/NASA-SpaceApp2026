import asyncio

import numpy as np
from affine import Affine
from fastapi.testclient import TestClient
from rasterio.io import MemoryFile

from app.main import app
from app.visibility_grid_source import (
    _sample_visibility_dataset,
    fetch_visibility_point,
    _visibility_point_product,
    _visibility_product,
)

client = TestClient(app)
API = "/api/v1"


def test_visibility_grid_applies_raster_scale_and_nodata_mask():
    raster = MemoryFile()
    with raster.open(
        driver="GTiff",
        width=4,
        height=4,
        count=1,
        dtype="int16",
        transform=Affine(1, 0, 0, 0, -1, 4),
        nodata=-32768,
    ) as dataset:
        dataset.write(
            np.array(
                [
                    [10000, 15000, 0, 0],
                    [20000, -32768, 0, 0],
                    [0, 0, 0, 0],
                    [0, 0, 0, 0],
                ],
                dtype=np.int16,
            ),
            1,
        )
        dataset.scales = (0.00004,)
        dataset.offsets = (0.0,)

    with raster.open() as dataset:
        values = _sample_visibility_dataset(
            dataset,
            np.array([[0.5, 1.5], [0.5, 1.5]]),
            np.array([[3.5, 3.5], [2.5, 2.5]]),
        )

    raster.close()
    assert values == [[40.0, 60.0], [80.0, None]]


def test_visibility_product_selects_matching_hemisphere_and_coverage():
    south = _visibility_product("illumination", -80, 20)
    north = _visibility_product("earth-visibility", 80, 20)

    assert south["version"] == "AVGVISIB_75S_120M_201608"
    assert south["projection"] == "south-polar"
    assert north["version"] == "AVGVISIB_75N_120M_201608_EARTH"
    assert north["projection"] == "north-polar"
    assert _visibility_product("illumination", -64, 5) is None


def test_visibility_point_product_uses_grid_product_selection():
    south = _visibility_point_product("illumination", -89.45)
    mid_latitude = _visibility_point_product("earth-visibility", -69.4)

    assert south["version"] == "AVGVISIB_75S_120M_201608"
    assert south["resolutionM"] == 120
    assert mid_latitude["version"] == "AVGVISIB_65S_240M_201608_EARTH"
    assert mid_latitude["resolutionM"] == 240
    assert _visibility_point_product("illumination", 0) is None


def test_visibility_point_reads_the_exact_query_coordinate(monkeypatch):
    seen = []
    stored = []

    def fake_read(lat, lon, size_km, res, product):
        seen.append((lat, lon, size_km, res, product["version"]))
        return [[67.25]]

    monkeypatch.setattr(
        "app.visibility_grid_source.get_persisted_cache",
        lambda _key: None,
    )
    monkeypatch.setattr(
        "app.visibility_grid_source.set_persisted_cache",
        lambda key, value, ttl: stored.append((key, value, ttl)),
    )
    monkeypatch.setattr(
        "app.visibility_grid_source._read_visibility_grid_values",
        fake_read,
    )

    result = asyncio.run(
        fetch_visibility_point("illumination", -89.45, -137.3)
    )

    assert result["valuePct"] == 67.25
    assert result["version"] == "AVGVISIB_75S_120M_201608"
    assert seen == [
        (-89.45, -137.3, 0, 1, "AVGVISIB_75S_120M_201608")
    ]
    assert stored[0][1] == result


def test_visibility_grid_endpoints_share_layer_contract(monkeypatch):
    seen = []

    async def fake_visibility_grid(layer_id, lat, lon, size_km, res):
        seen.append((layer_id, lat, lon, size_km, res))
        return {
            "layerId": layer_id,
            "lat": lat,
            "lon": lon,
            "sizeKm": size_km,
            "res": res,
            "kind": "continuous",
            "unit": "%",
            "min": 25.0,
            "max": 75.0,
            "values": [[50.0] * res for _ in range(res)],
            "northUp": True,
            "source": "NASA GSFC PGDA LOLA Lunar Polar Illumination",
            "version": "test-version",
        }

    monkeypatch.setattr("app.main.fetch_visibility_grid", fake_visibility_grid)

    for layer_id in ("illumination", "earth-visibility"):
        response = client.get(
            f"{API}/layers/{layer_id}/grid",
            params={
                "lat": -89.45,
                "lon": 222.7,
                "sizeKm": 10,
                "res": 16,
            },
        )
        assert response.status_code == 200
        assert response.json()["kind"] == "continuous"
        assert response.json()["unit"] == "%"
        assert len(response.json()["values"]) == 16

    assert seen == [
        ("illumination", -89.45, -137.3, 10.0, 16),
        ("earth-visibility", -89.45, -137.3, 10.0, 16),
    ]


def test_visibility_grid_returns_null_values_outside_polar_coverage(monkeypatch):
    monkeypatch.setattr(
        "app.visibility_grid_source.get_persisted_cache",
        lambda _key: None,
    )
    stored = []
    monkeypatch.setattr(
        "app.visibility_grid_source.set_persisted_cache",
        lambda key, value, ttl: stored.append((key, value, ttl)),
    )

    response = client.get(
        f"{API}/layers/illumination/grid",
        params={"lat": 0, "lon": 0, "sizeKm": 5, "res": 16},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["version"] is None
    assert result["min"] is result["max"] is None
    assert result["values"] == [[None] * 16 for _ in range(16)]
    assert stored[0][1] == result
