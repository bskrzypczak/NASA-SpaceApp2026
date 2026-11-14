from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
API = "/api/v1"


def test_health_endpoint():
    assert client.get(f"{API}/health").json() == {"status": "ok"}


def test_catalog_returns_frontend_sites_and_featured_subset():
    response = client.get(f"{API}/sites")
    assert response.status_code == 200
    assert response.json()["total"] == 19
    assert response.json()["items"][0]["id"] == "connecting-ridge"
    assert response.json()["items"][0]["coordsVerified"] is False
    assert response.json()["items"][0]["precomputed"] is False

    featured = client.get(f"{API}/sites", params={"featured": "true"}).json()
    assert featured["total"] == 5


def test_site_details_include_terrain_data(monkeypatch):
    async def fake_terrain(lat, lon):
        return {
            "elevationM": 1318.0,
            "slopeDeg": None,
            "demCoverage": True,
            "demResolutionM": 100.0,
            "inPermanentShadow": True,
            "demVersion": "LRO_LOLA_DEM_SPole45_100mp_v04",
            "source": "NASA Moon Trek LRO LOLA ImageServer",
        }

    monkeypatch.setattr("app.main.fetch_lunar_elevation", fake_terrain)
    response = client.get(f"{API}/sites/connecting-ridge")
    assert response.status_code == 200
    assert response.json()["demCoverage"] is True
    assert response.json()["elevationM"] == 1318.0
    assert response.json()["inPermanentShadow"] is True
    assert "NASA GSFC PGDA LPSR PSR map" in response.json()["sources"]


def test_catalog_filters_by_group_region_and_query():
    response = client.get(
        f"{API}/sites",
        params={"group": "CLPS", "region": "South pole", "q": "athena"},
    )
    assert response.status_code == 200
    assert [site["id"] for site in response.json()["items"]] == ["mons-mouton"]


def test_terrain_point_normalizes_longitude_and_returns_nearest_site(monkeypatch):
    async def fake_terrain(lat, lon):
        return {
            "elevationM": 1318.0,
            "slopeDeg": None,
            "demCoverage": True,
            "demResolutionM": 100.0,
            "inPermanentShadow": False,
            "demVersion": "LRO_LOLA_DEM_SPole45_100mp_v04",
            "source": "NASA Moon Trek LRO LOLA ImageServer",
        }

    monkeypatch.setattr("app.main.fetch_lunar_elevation", fake_terrain)
    response = client.get(
        f"{API}/terrain/point",
        params={"lat": -89.45, "lon": 222.7},
    )
    assert response.status_code == 200
    assert response.json()["lon"] == -137.3
    assert response.json()["nearestSite"] == {
        "id": "connecting-ridge",
        "distanceKm": 0.0,
    }
    assert response.json()["elevationM"] == 1318.0
    assert response.json()["demCoverage"] is True
    assert response.json()["demResolutionM"] == 100.0
    assert response.json()["inPermanentShadow"] is False


def test_heightmap_json_returns_local_grid_and_normalizes_longitude(monkeypatch):
    observed = {}

    async def fake_heightmap(lat, lon, size_km, res):
        observed.update(lat=lat, lon=lon, size_km=size_km, res=res)
        return {
            "lat": lat,
            "lon": lon,
            "sizeKm": size_km,
            "res": res,
            "originElevationM": 1956.0,
            "minElevationM": -2.0,
            "maxElevationM": 2.0,
            "heightsM": [[0.0] * res for _ in range(res)],
            "northUp": True,
            "demVersion": "LRO_LOLA_DEM_SPole45_100mp_v04",
            "demResolutionM": 100.0,
        }

    monkeypatch.setattr("app.main.fetch_lunar_heightmap", fake_heightmap)
    response = client.get(
        f"{API}/terrain/heightmap",
        params={"lat": -89.45, "lon": 222.7, "sizeKm": 10, "res": 16},
    )

    assert response.status_code == 200
    assert observed == {
        "lat": -89.45,
        "lon": -137.3,
        "size_km": 10,
        "res": 16,
    }
    assert response.json()["originElevationM"] == 1956.0
    assert len(response.json()["heightsM"]) == 16
    assert response.json()["northUp"] is True


def test_heightmap_png16_scales_single_band_and_includes_elevation_headers(
    monkeypatch,
):
    async def fake_heightmap(lat, lon, size_km, res):
        heights = [
            [row * res + col for col in range(res)]
            for row in range(res)
        ]
        return {
            "lat": lat,
            "lon": lon,
            "sizeKm": size_km,
            "res": res,
            "originElevationM": 100.0,
            "minElevationM": 0.0,
            "maxElevationM": float(res * res - 1),
            "heightsM": heights,
            "northUp": True,
            "demVersion": "test-dem",
        }

    monkeypatch.setattr("app.main.fetch_lunar_heightmap", fake_heightmap)
    response = client.get(
        f"{API}/terrain/heightmap",
        params={"lat": -89.45, "lon": -137.3, "res": 16, "format": "png16"},
    )

    from io import BytesIO
    from PIL import Image

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-min-elevation-m"] == "0.0"
    assert response.headers["x-max-elevation-m"] == "255.0"
    with Image.open(BytesIO(response.content)) as image:
        assert image.mode == "I;16"
        assert image.size == (16, 16)
        assert image.getpixel((0, 0)) == 0
        assert image.getpixel((15, 15)) == 65535


def test_heightmap_png16_encodes_constant_relief_without_dividing_by_zero(
    monkeypatch,
):
    async def fake_heightmap(lat, lon, size_km, res):
        return {
            "lat": lat,
            "lon": lon,
            "sizeKm": size_km,
            "res": res,
            "originElevationM": 100.0,
            "minElevationM": 0.0,
            "maxElevationM": 0.0,
            "heightsM": [[0.0] * res for _ in range(res)],
            "northUp": True,
            "demVersion": "test-dem",
        }

    monkeypatch.setattr("app.main.fetch_lunar_heightmap", fake_heightmap)
    response = client.get(
        f"{API}/terrain/heightmap",
        params={"lat": 0, "lon": 0, "res": 16, "format": "png16"},
    )

    from io import BytesIO
    from PIL import Image

    assert response.status_code == 200
    assert response.headers["x-min-elevation-m"] == "0.0"
    assert response.headers["x-max-elevation-m"] == "0.0"
    with Image.open(BytesIO(response.content)) as image:
        assert image.getpixel((0, 0)) == 0
        assert image.getpixel((15, 15)) == 0


def test_heightmap_rejects_unsupported_size():
    response = client.get(
        f"{API}/terrain/heightmap",
        params={"lat": -89.45, "lon": -137.3, "sizeKm": 15},
    )

    assert response.status_code == 400
    assert response.json()["error"]["field"] == "sizeKm"


def test_horizon_endpoint_returns_contract_shape_and_normalizes_longitude(
    monkeypatch,
):
    async def fake_horizon(lat, lon, height_m, bin_deg):
        assert lat == -89.45
        assert lon == -137.3
        assert height_m == 2
        assert bin_deg == 0.5
        return {
            "lat": lat,
            "lon": lon,
            "heightM": height_m,
            "binDeg": bin_deg,
            "maxDistanceKm": 150.0,
            "azimuthDeg": [0.0, 0.5, 1.0],
            "elevationDeg": [0.35, 0.36, 0.38],
            "features": [],
            "demVersion": "LRO_LOLA_DEM_SPole45_100mp_v04",
            "demResolutionM": 100.0,
        }

    monkeypatch.setattr("app.main.fetch_horizon", fake_horizon)
    response = client.get(
        f"{API}/horizon",
        params={"lat": -89.45, "lon": 222.7},
    )

    assert response.status_code == 200
    assert response.json()["azimuthDeg"] == [0.0, 0.5, 1.0]
    assert response.json()["elevationDeg"] == [0.35, 0.36, 0.38]


def test_horizon_endpoint_rejects_unsupported_bin_size():
    response = client.get(
        f"{API}/horizon",
        params={"lat": -89.45, "lon": 0, "binDeg": 0.25},
    )

    assert response.status_code == 400
    assert response.json()["error"]["field"] == "binDeg"


def test_horizon_endpoint_reports_dem_coverage():
    response = client.get(
        f"{API}/horizon",
        params={"lat": -79.9, "lon": 0},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "OUT_OF_DEM_COVERAGE"


def test_simulation_post_and_get_return_idempotent_contract(monkeypatch):
    async def fake_ephemeris(lat, lon, start, end, step_min, bodies):
        assert lat == -89.45
        assert lon == -137.3
        assert step_min == 720
        assert bodies == {"sun", "earth"}
        return {
            "times": ["2027-03-14T06:00:00Z", "2027-03-14T18:00:00Z"],
            "sun": {"azDeg": [0.0, 180.0], "elDeg": [-90.0, -90.0]},
            "earth": {"azDeg": [0.0, 180.0], "elDeg": [-1.95, 0.05]},
        }

    async def fake_terrain(lat, lon):
        return {"elevationM": 1956.0}

    monkeypatch.setattr("app.simulation_routes.fetch_ephemeris", fake_ephemeris)
    monkeypatch.setattr("app.simulation_routes.fetch_lunar_elevation", fake_terrain)
    monkeypatch.setattr("app.simulation_routes.SIMULATIONS", {})
    response = client.post(
        f"{API}/simulations",
        json={
            "site": {"siteId": "connecting-ridge"},
            "landingTime": "2027-03-14T06:00:00Z",
            "missionDays": 1,
            "windowDays": 1,
            "stepMin": 720,
            "horizonModel": "flat",
        },
    )

    assert response.status_code == 201
    result = response.json()
    assert result["site"] == {
        "name": "Connecting Ridge",
        "lat": -89.45,
        "lon": -137.3,
        "elevationM": 1956.0,
    }
    assert result["input"]["hardware"]["batteryWh"] == 20000
    assert result["summary"]["successPct"] == 97
    assert result["timeseries"]["stepMin"] == 720
    assert client.get(f"{API}/simulations/{result['id']}").json() == result

    repeated = client.post(
        f"{API}/simulations",
        json={
            "site": {"siteId": "connecting-ridge"},
            "landingTime": "2027-03-14T06:00:00Z",
            "missionDays": 1,
            "windowDays": 1,
            "stepMin": 720,
            "horizonModel": "flat",
        },
    )
    assert repeated.json() == result

    without_series = client.post(
        f"{API}/simulations",
        json={
            "site": {"siteId": "connecting-ridge"},
            "landingTime": "2027-03-14T06:00:00Z",
            "missionDays": 1,
            "windowDays": 1,
            "stepMin": 720,
            "horizonModel": "flat",
            "includeTimeseries": False,
        },
    )
    assert without_series.status_code == 201
    assert "timeseries" not in without_series.json()


def test_simulation_real_terrain_uses_separate_observer_heights(monkeypatch):
    requested_heights = []

    async def fake_ephemeris(_lat, _lon, _start, _end, _step_min, _bodies):
        return {
            "times": ["2027-03-14T06:00:00Z", "2027-03-14T18:00:00Z"],
            "sun": {"azDeg": [0.0, 180.0], "elDeg": [1.0, -1.0]},
            "earth": {"azDeg": [90.0, 270.0], "elDeg": [2.0, 2.0]},
        }

    async def fake_terrain(_lat, _lon):
        return {"elevationM": 1956.0}

    async def fake_horizon(_lat, _lon, height_m, bin_deg):
        requested_heights.append((height_m, bin_deg))
        return {
            "azimuthDeg": [0.0, 90.0, 180.0, 270.0],
            "elevationDeg": [height_m, height_m, height_m, height_m],
        }

    monkeypatch.setattr("app.simulation_routes.fetch_ephemeris", fake_ephemeris)
    monkeypatch.setattr("app.simulation_routes.fetch_lunar_elevation", fake_terrain)
    monkeypatch.setattr("app.simulation_routes.fetch_horizon", fake_horizon)
    monkeypatch.setattr("app.simulation_routes.SIMULATIONS", {})

    response = client.post(
        f"{API}/simulations",
        json={
            "site": {"lat": -89.45, "lon": 222.7},
            "landingTime": "2027-03-14T06:00:00Z",
            "missionDays": 1,
            "windowDays": 1,
            "stepMin": 720,
            "hardware": {"panelHeightM": 2, "mastHeightM": 3.5},
        },
    )

    assert response.status_code == 201
    assert requested_heights == [(2.0, 0.5), (3.5, 0.5)]
    assert response.json()["input"]["site"]["lon"] == -137.3
    assert len(response.json()["timeseries"]["day"]) == 2
    assert response.json()["timeseries"]["sunMaskElDeg"] == [2.0, 2.0]
    assert response.json()["timeseries"]["earthMaskElDeg"] == [3.5, 3.5]
    assert (
        response.json()["summary"]["flatHorizonSuccessPct"]
        > response.json()["summary"]["successPct"]
    )


def test_simulation_validates_site_and_sampling_window(monkeypatch):
    monkeypatch.setattr("app.simulation_routes.SIMULATIONS", {})
    missing_site = client.post(
        f"{API}/simulations",
        json={
            "site": {},
            "landingTime": "2027-03-14T06:00:00Z",
            "horizonModel": "flat",
        },
    )
    assert missing_site.status_code == 400
    assert missing_site.json()["error"]["field"] == "site"

    unknown_site = client.post(
        f"{API}/simulations",
        json={
            "site": {"siteId": "not-a-site"},
            "landingTime": "2027-03-14T06:00:00Z",
            "horizonModel": "flat",
        },
    )
    assert unknown_site.status_code == 404

    excessive_samples = client.post(
        f"{API}/simulations",
        json={
            "site": {"siteId": "connecting-ridge"},
            "landingTime": "2027-03-14T06:00:00Z",
            "windowDays": 30,
            "stepMin": 1,
            "horizonModel": "flat",
        },
    )
    assert excessive_samples.status_code == 400
    assert excessive_samples.json()["error"]["field"] == "stepMin"


def test_simulation_accepts_default_30_day_4320_sample_window(monkeypatch):
    async def fake_ephemeris(lat, lon, start, end, step_min, bodies):
        assert (end - start).total_seconds() == 30 * 86400 - 10 * 60
        assert step_min == 10
        sample_count = 30 * 24 * 60 // step_min
        return {
            "times": [""] * sample_count,
            "sun": {
                "azDeg": [0.0] * sample_count,
                "elDeg": [1.0] * sample_count,
            },
            "earth": {
                "azDeg": [180.0] * sample_count,
                "elDeg": [2.0] * sample_count,
            },
        }

    async def fake_terrain(_lat, _lon):
        return {"elevationM": 100.0}

    monkeypatch.setattr("app.simulation_routes.fetch_ephemeris", fake_ephemeris)
    monkeypatch.setattr("app.simulation_routes.fetch_lunar_elevation", fake_terrain)
    monkeypatch.setattr("app.simulation_routes.SIMULATIONS", {})
    response = client.post(
        f"{API}/simulations",
        json={
            "site": {"siteId": "connecting-ridge"},
            "landingTime": "2027-03-14T06:00:00Z",
            "horizonModel": "flat",
        },
    )

    assert response.status_code == 201
    result = response.json()
    assert len(result["timeseries"]["day"]) == 4320
    assert len(result["timeseries"]["socPct"]) == 4320


def test_ephemeris_endpoint_validates_inputs_and_returns_real_source_shape(monkeypatch):
    async def fake_ephemeris(lat, lon, start, end, step_min, bodies):
        assert lat == -89.45
        assert lon == -137.3
        assert step_min == 10
        assert bodies == {"sun", "earth"}
        return {
            "start": "2027-03-14T06:00:00Z",
            "stepMin": 10,
            "times": [
                "2027-03-14T06:00:00Z",
                "2027-03-14T06:10:00Z",
                "2027-03-14T06:20:00Z",
            ],
            "sun": {"azDeg": [241.2, 241.1, 241.0], "elDeg": [-1.1, -1.1, -1.1]},
            "earth": {"azDeg": [132.8, 132.9, 132.9], "elDeg": [5.9, 5.9, 5.9]},
            "source": "JPL Horizons API, observer on body 301, airless, DE441",
        }

    monkeypatch.setattr("app.main.fetch_ephemeris", fake_ephemeris)
    response = client.get(
        f"{API}/ephemeris",
        params={
            "lat": -89.45,
            "lon": 222.7,
            "start": "2027-03-14T06:00:00Z",
            "end": "2027-03-14T06:20:00Z",
            "stepMin": 10,
        },
    )
    assert response.status_code == 200
    assert response.json()["sun"]["elDeg"][0] == -1.1
    assert response.json()["source"].endswith("DE441")


def test_invalid_coordinates_use_documented_error_shape():
    response = client.get(
        f"{API}/terrain/point",
        params={"lat": 91, "lon": 0},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert response.json()["error"]["field"] == "lat"


def test_unknown_site_returns_documented_not_found_shape():
    response = client.get(f"{API}/sites/not-a-site")
    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "NOT_FOUND",
            "message": "Unknown siteId.",
            "field": None,
        }
    }
