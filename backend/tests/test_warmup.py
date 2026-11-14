import asyncio

import pytest

from scripts import warmup


@pytest.mark.parametrize(
    ("site_id", "expected_horizon", "expected_model"),
    [
        ("connecting-ridge", (2.0, 0.5), "real"),
        ("chandrayaan-3", None, "flat"),
    ],
)
def test_warm_site_preloads_demo_data_and_default_simulation(
    monkeypatch,
    site_id,
    expected_horizon,
    expected_model,
):
    observed = {}

    async def fake_heightmap(lat, lon, size_km, res):
        observed["heightmap"] = (lat, lon, size_km, res)
        return {}

    async def fake_horizon(lat, lon, height_m, bin_deg):
        observed["horizon"] = (height_m, bin_deg)
        return {}

    async def fake_simulation(request):
        observed["request"] = request
        return {"id": "sim_warmup"}

    monkeypatch.setattr(warmup, "fetch_lunar_heightmap", fake_heightmap)
    monkeypatch.setattr(warmup, "fetch_horizon", fake_horizon)
    monkeypatch.setattr(warmup, "create_simulation", fake_simulation)

    asyncio.run(
        warmup._warm_site(site_id, warmup.DEFAULT_LANDING_TIME)
    )

    site = warmup.SITE_BY_ID[site_id]
    assert observed["heightmap"] == (site["lat"], site["lon"], 20, 256)
    assert observed.get("horizon") == expected_horizon
    request = observed["request"]
    assert request.site.siteId == site_id
    assert request.landingTime == warmup.DEFAULT_LANDING_TIME
    assert request.missionDays == 14
    assert request.windowDays == 30
    assert request.stepMin == 10
    assert request.horizonModel == expected_model
    assert request.includeTimeseries is True
