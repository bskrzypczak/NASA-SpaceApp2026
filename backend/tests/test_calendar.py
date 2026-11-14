import asyncio
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.calendar_routes import _fetch_calendar_ephemeris
from app.main import app

client = TestClient(app)
API = "/api/v1"


def test_calendar_scores_each_landing_day_and_aggregates_months(monkeypatch):
    observed = {}

    async def fake_ephemeris(lat, lon, start, end, step_min, bodies):
        observed.update(
            lat=lat,
            lon=lon,
            start=start,
            end=end,
            step_min=step_min,
            bodies=bodies,
        )
        sample_count = int((end - start).total_seconds() // (step_min * 60)) + 1
        return {
            "sun": {"azDeg": [0.0] * sample_count, "elDeg": [10.0] * sample_count},
            "earth": {
                "azDeg": [180.0] * sample_count,
                "elDeg": [10.0] * sample_count,
            },
        }

    async def fail_horizon(*_args):
        raise AssertionError("flat model uses no DEM")

    monkeypatch.setattr("app.ephemeris_sampling.fetch_ephemeris", fake_ephemeris)
    monkeypatch.setattr("app.calendar_routes.fetch_horizon", fail_horizon)
    response = client.post(
        f"{API}/calendar",
        json={
            "site": {"siteId": "connecting-ridge"},
            "from": "2027-01-31",
            "to": "2027-02-01",
            "landingTimeOfDay": "06:00Z",
            "missionDays": 1,
            "horizonModel": "flat",
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert [day["date"] for day in result["days"]] == ["2027-01-31", "2027-02-01"]
    assert all(day["successPct"] == 97 for day in result["days"])
    assert result["best"] == {"date": "2027-01-31", "successPct": 97}
    assert result["months"] == [
        {"month": "2027-01", "goodDays": 1, "bestPct": 97},
        {"month": "2027-02", "goodDays": 1, "bestPct": 97},
    ]
    assert observed["lon"] == -137.3
    assert observed["step_min"] == 60
    assert observed["bodies"] == {"sun", "earth"}
    assert (observed["end"] - observed["start"]) == timedelta(hours=47)


def test_calendar_fetches_separate_real_masks_for_panel_and_mast(monkeypatch):
    requested_heights = []

    async def fake_ephemeris(_lat, _lon, start, end, step_min, _bodies):
        sample_count = int((end - start).total_seconds() // (step_min * 60)) + 1
        return {
            "sun": {"azDeg": [0.0] * sample_count, "elDeg": [1.0] * sample_count},
            "earth": {
                "azDeg": [90.0] * sample_count,
                "elDeg": [2.0] * sample_count,
            },
        }

    async def fake_horizon(_lat, _lon, height_m, bin_deg):
        requested_heights.append((height_m, bin_deg))
        return {
            "azimuthDeg": [0.0, 90.0, 180.0, 270.0],
            "elevationDeg": [height_m] * 4,
        }

    monkeypatch.setattr("app.ephemeris_sampling.fetch_ephemeris", fake_ephemeris)
    monkeypatch.setattr("app.calendar_routes.fetch_horizon", fake_horizon)
    response = client.post(
        f"{API}/calendar",
        json={
            "site": {"lat": 0.0, "lon": -137.3},
            "from": "2027-03-14",
            "to": "2027-03-14",
            "missionDays": 1,
            "hardware": {"panelHeightM": 2, "mastHeightM": 3.5},
        },
    )

    assert response.status_code == 200
    assert requested_heights == [(2.0, 0.5), (3.5, 0.5)]
    assert len(response.json()["days"]) == 1


def test_calendar_rejects_reversed_and_excessive_date_ranges():
    reversed_range = client.post(
        f"{API}/calendar",
        json={
            "site": {"siteId": "connecting-ridge"},
            "from": "2027-02-01",
            "to": "2027-01-31",
            "horizonModel": "flat",
        },
    )
    assert reversed_range.status_code == 400
    assert reversed_range.json()["error"]["field"] == "to"

    excessive_range = client.post(
        f"{API}/calendar",
        json={
            "site": {"siteId": "connecting-ridge"},
            "from": "2027-01-01",
            "to": "2028-01-02",
            "horizonModel": "flat",
        },
    )
    assert excessive_range.status_code == 400
    assert excessive_range.json()["error"]["field"] == "to"


def test_calendar_supports_full_year_across_horizons_chunks(monkeypatch):
    chunk_sizes = []

    async def fake_ephemeris(_lat, _lon, start, end, step_min, _bodies):
        sample_count = int((end - start).total_seconds() // (step_min * 60)) + 1
        chunk_sizes.append(sample_count)
        return {
            "sun": {
                "azDeg": [0.0] * sample_count,
                "elDeg": [10.0] * sample_count,
            },
            "earth": {
                "azDeg": [180.0] * sample_count,
                "elDeg": [10.0] * sample_count,
            },
        }

    monkeypatch.setattr("app.ephemeris_sampling.fetch_ephemeris", fake_ephemeris)
    response = client.post(
        f"{API}/calendar",
        json={
            "site": {"siteId": "connecting-ridge"},
            "from": "2027-01-01",
            "to": "2027-12-31",
            "missionDays": 1,
            "horizonModel": "flat",
        },
    )

    assert response.status_code == 200
    assert chunk_sizes == [4320, 4320, 122]
    assert len(response.json()["days"]) == 365
    assert len(response.json()["months"]) == 12


def test_calendar_ephemeris_chunks_preserve_hourly_sample_alignment(monkeypatch):
    start = datetime(2027, 1, 1, tzinfo=timezone.utc)
    calls = []

    async def fake_ephemeris(_lat, _lon, chunk_start, chunk_end, step_min, _bodies):
        first_index = int((chunk_start - start).total_seconds() // (step_min * 60))
        sample_count = int(
            (chunk_end - chunk_start).total_seconds() // (step_min * 60)
        ) + 1
        calls.append(sample_count)
        values = [float(first_index + index) for index in range(sample_count)]
        return {
            "sun": {"azDeg": values, "elDeg": values},
            "earth": {"azDeg": values, "elDeg": values},
        }

    monkeypatch.setattr("app.ephemeris_sampling.fetch_ephemeris", fake_ephemeris)
    result = asyncio.run(
        _fetch_calendar_ephemeris(
            -89.45,
            -137.3,
            start,
            total_samples=9000,
            step_min=60,
        )
    )

    assert len(calls) == 3
    assert max(calls) == 4320
    assert len(result["sun"]["azDeg"]) == 9000
    for index in (0, 4319, 4320, 8638, 8639, 8999):
        assert result["sun"]["azDeg"][index] == index
