from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
API = "/api/v1"


def _request() -> dict:
    return {
        "center": {"lat": -89.45, "lon": -137.3},
        "radiusKm": 2.5,
        "cellM": 100,
        "landingTime": "2027-03-14T06:00:00Z",
        "missionDays": 14,
        "goal": "balanced",
        "maxSlopeDeg": 10,
        "top": 3,
    }


def test_nearby_evaluates_bounded_safe_grid_and_returns_ranked_suggestions(
    monkeypatch,
):
    evaluated = []

    async def fake_heightmap(lat, lon, size_km, res):
        assert (lat, lon, size_km, res) == (-89.45, -137.3, 10.0, 16)
        return {
            "lat": lat,
            "lon": lon,
            "sizeKm": size_km,
            "res": res,
            "heightsM": [[0.0] * res for _ in range(res)],
            "demVersion": "test-dem",
            "demResolutionM": 100.0,
        }

    async def fake_psr_grid(lat, lon, size_km, res):
        values = [[0] * res for _ in range(res)]
        values[8][12] = 1
        return {"values": values}

    async def fake_create_simulation(request):
        lat = request.site.lat
        lon = request.site.lon
        evaluated.append((lat, lon, request))
        is_north = lat > -89.45
        score = 80 if is_north else 60
        return {
            "summary": {
                "successPct": score,
                "sunlitPct": 20 if not is_north else 40,
                "minSocPct": 30 if not is_north else 35,
                "earthVisiblePct": 10 if not is_north else 15,
            }
        }

    monkeypatch.setattr(
        "app.nearby_routes.fetch_lunar_heightmap", fake_heightmap
    )
    monkeypatch.setattr("app.nearby_routes.fetch_psr_grid", fake_psr_grid)
    monkeypatch.setattr(
        "app.nearby_routes.create_simulation", fake_create_simulation
    )

    response = client.post(f"{API}/nearby", json=_request())

    assert response.status_code == 200
    result = response.json()
    assert result["grid"]["rows"] == result["grid"]["cols"] == 3
    assert result["grid"]["cellM"] == 2500
    assert result["grid"]["successPct"][1][1] == result["center"]["successPct"]
    assert result["grid"]["excluded"][1][2] is True
    assert result["grid"]["successPct"][1][2] is None
    assert len(evaluated) == 4
    assert all(item[2].stepMin == 60 for item in evaluated)
    assert all(item[2].includeTimeseries is False for item in evaluated)
    assert result["suggestions"][0]["rank"] == "A"
    assert result["suggestions"][0]["successPct"] == 80
    assert "+2.8 days of sunlight" in result["suggestions"][0]["why"]


def test_nearby_requires_timezone_aware_landing_time():
    request = _request()
    request["landingTime"] = "2027-03-14T06:00:00"

    response = client.post(f"{API}/nearby", json=request)

    assert response.status_code == 400
    assert response.json()["error"] == {
        "code": "VALIDATION_ERROR",
        "message": "landingTime must include a UTC offset.",
        "field": "landingTime",
    }
