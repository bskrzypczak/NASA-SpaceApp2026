from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
API = "/api/v1"


def test_validation_compares_full_year_at_hourly_steps_and_reports_missing_wac(
    monkeypatch,
):
    seen = {}

    async def fake_ephemeris(lat, lon, start, total_samples, step_min):
        seen["ephemeris"] = (lat, lon, start, total_samples, step_min)
        return {
            "sun": {"azDeg": [0.0] * total_samples, "elDeg": [0.0] * total_samples},
            "earth": {
                "azDeg": [0.0] * total_samples,
                "elDeg": [0.0] * total_samples,
            },
        }

    async def fake_horizon(lat, lon, height_m, bin_deg):
        seen["horizon"] = (lat, lon, height_m, bin_deg)
        return {
            "azimuthDeg": [0.0] * 720,
            "elevationDeg": [0.0] * 720,
            "demVersion": "test-dem",
            "demResolutionM": 100.0,
        }

    async def fake_visibility(layer_id, lat, lon):
        seen.setdefault("visibility", set()).add(layer_id)
        value = 49.5 if layer_id == "illumination" else 98.0
        return {
            "valuePct": value,
            "version": f"test-{layer_id}",
        }

    stored = []
    monkeypatch.setattr(
        "app.validation_routes.fetch_ephemeris_range",
        fake_ephemeris,
    )
    monkeypatch.setattr("app.validation_routes.fetch_horizon", fake_horizon)
    monkeypatch.setattr(
        "app.validation_routes.fetch_visibility_point",
        fake_visibility,
    )
    monkeypatch.setattr(
        "app.validation_routes.get_persisted_cache",
        lambda _key: None,
    )
    monkeypatch.setattr(
        "app.validation_routes.set_persisted_cache",
        lambda key, value, ttl: stored.append((key, value, ttl)),
    )

    response = client.get(
        f"{API}/validation",
        params={"lat": -89.45, "lon": 222.7},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["avgIlluminationPct"] == {
        "horizon": 50.0,
        "pgda": 49.5,
        "lrocWac": None,
    }
    assert result["earthVisibilityPct"] == {
        "horizon": 100.0,
        "pgda": 98.0,
    }
    assert result["deltaMaxPts"] == 2.0
    assert result["withinTolerance"] is True
    assert result["tolerancePts"] == 5.0
    assert result["periodStart"] == "2027-01-01"
    assert result["periodEnd"] == "2028-01-01"
    assert result["periodDays"] == 365
    assert result["samplingStepHours"] == 1.0
    assert result["heightM"] == 0.0
    assert result["lrocWacNote"] == (
        "no full-coverage WAC illumination raster available"
    )
    assert result["horizonDemVersion"] == "test-dem"
    assert result["horizonDemResolutionM"] == 100.0
    ephemeris_call = seen["ephemeris"]
    assert ephemeris_call[:2] == (-89.45, -137.3)
    assert ephemeris_call[2].isoformat() == "2027-01-01T00:00:00+00:00"
    assert ephemeris_call[3:] == (365 * 24 + 1, 60)
    assert seen["horizon"] == (-89.45, -137.3, 0.0, 0.5)
    assert seen["visibility"] == {"illumination", "earth-visibility"}
    assert stored[0][1] == result


def test_validation_handles_missing_pgda_coverage_without_claiming_tolerance(
    monkeypatch,
):
    async def fake_ephemeris(_lat, _lon, _start, total_samples, _step_min):
        return {
            "sun": {"azDeg": [0.0] * total_samples, "elDeg": [0.0] * total_samples},
            "earth": {
                "azDeg": [0.0] * total_samples,
                "elDeg": [0.0] * total_samples,
            },
        }

    async def fake_horizon(_lat, _lon, _height_m, _bin_deg):
        return {
            "azimuthDeg": [0.0] * 720,
            "elevationDeg": [0.0] * 720,
            "demVersion": "test-dem",
            "demResolutionM": 100.0,
        }

    async def fake_visibility(_layer_id, _lat, _lon):
        value = 50.0 if _layer_id == "illumination" else None
        return {"valuePct": value, "version": "test-pgda"}

    monkeypatch.setattr(
        "app.validation_routes.fetch_ephemeris_range",
        fake_ephemeris,
    )
    monkeypatch.setattr("app.validation_routes.fetch_horizon", fake_horizon)
    monkeypatch.setattr(
        "app.validation_routes.fetch_visibility_point",
        fake_visibility,
    )
    monkeypatch.setattr(
        "app.validation_routes.get_persisted_cache",
        lambda _key: None,
    )
    monkeypatch.setattr(
        "app.validation_routes.set_persisted_cache",
        lambda _key, _value, _ttl: None,
    )

    response = client.get(
        f"{API}/validation",
        params={"lat": 80, "lon": 0},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["avgIlluminationPct"]["pgda"] == 50.0
    assert result["earthVisibilityPct"]["pgda"] is None
    assert result["deltaMaxPts"] is None
    assert result["withinTolerance"] is None


def test_validation_rejects_latitudes_outside_pgda_coverage(monkeypatch):
    def unexpected_call(*_args, **_kwargs):
        raise AssertionError("Validation sources must not be queried outside PGDA.")

    monkeypatch.setattr(
        "app.validation_routes.get_persisted_cache",
        lambda _key: None,
    )
    monkeypatch.setattr(
        "app.validation_routes.fetch_ephemeris_range",
        unexpected_call,
    )
    monkeypatch.setattr("app.validation_routes.fetch_horizon", unexpected_call)
    monkeypatch.setattr(
        "app.validation_routes.fetch_visibility_point",
        unexpected_call,
    )

    response = client.get(
        f"{API}/validation",
        params={"lat": 0, "lon": 23.47},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "OUT_OF_PGDA_COVERAGE"
    assert response.json()["error"]["field"] == "lat"


def test_validation_period_covers_leap_year(monkeypatch):
    seen_samples = []

    async def fake_ephemeris(_lat, _lon, _start, total_samples, _step_min):
        seen_samples.append(total_samples)
        return {
            "sun": {"azDeg": [0.0] * total_samples, "elDeg": [0.0] * total_samples},
            "earth": {
                "azDeg": [0.0] * total_samples,
                "elDeg": [0.0] * total_samples,
            },
        }

    async def fake_horizon(_lat, _lon, _height_m, _bin_deg):
        return {
            "azimuthDeg": [0.0] * 720,
            "elevationDeg": [0.0] * 720,
            "demVersion": "test-dem",
            "demResolutionM": 100.0,
        }

    async def fake_visibility(_layer_id, _lat, _lon):
        return {"valuePct": 50.0, "version": "test-pgda"}

    monkeypatch.setattr(
        "app.validation_routes.fetch_ephemeris_range",
        fake_ephemeris,
    )
    monkeypatch.setattr("app.validation_routes.fetch_horizon", fake_horizon)
    monkeypatch.setattr(
        "app.validation_routes.fetch_visibility_point",
        fake_visibility,
    )
    monkeypatch.setattr(
        "app.validation_routes.get_persisted_cache",
        lambda _key: None,
    )
    monkeypatch.setattr(
        "app.validation_routes.set_persisted_cache",
        lambda _key, _value, _ttl: None,
    )

    response = client.get(
        f"{API}/validation",
        params={"lat": -89.45, "lon": -137.3, "start": "2028-01-01"},
    )

    assert response.status_code == 200
    assert seen_samples == [366 * 24 + 1]
    assert response.json()["periodDays"] == 366
    assert response.json()["periodEnd"] == "2029-01-01"
