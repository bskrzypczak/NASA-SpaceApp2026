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
