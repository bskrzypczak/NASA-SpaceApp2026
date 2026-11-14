from datetime import datetime

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
API = "/api/v1"


def _scenario(label: str, landing_time: str) -> dict:
    return {
        "label": label,
        "site": {"siteId": "connecting-ridge"},
        "landingTime": landing_time,
        "missionDays": 14,
        "windowDays": 14,
        "stepMin": 720,
        "horizonModel": "flat",
    }


def test_scenario_compare_returns_summaries_and_prefers_baseline_within_three_points(
    monkeypatch,
):
    seen_requests = []

    async def fake_create_simulation(request):
        seen_requests.append(request)
        date = request.landingTime.date().isoformat()
        score = 84 if date == "2027-03-14" else 86
        return {
            "id": f"sim-{date}",
            "summary": {
                "successPct": score,
                "minSocPct": 70.0,
                "earthVisiblePct": 60.0,
            },
            "windows": {"sun": [], "earth": [], "both": []},
        }

    monkeypatch.setattr("app.simulation_routes.create_simulation", fake_create_simulation)
    response = client.post(
        f"{API}/scenarios/compare",
        json={
            "scenarios": [
                _scenario("Baseline", "2027-03-14T06:00:00Z"),
                _scenario("Slip +2 weeks", "2027-03-28T06:00:00Z"),
            ],
            "requirements": {"minSocPct": 20, "minEarthVisiblePct": 50},
        },
    )

    assert response.status_code == 200
    result = response.json()
    assert [item["label"] for item in result["results"]] == [
        "Baseline",
        "Slip +2 weeks",
    ]
    assert [item["meetsRequirements"] for item in result["results"]] == [True, True]
    assert result["results"][0]["simulationId"] == "sim-2027-03-14"
    assert result["recommendation"] == {
        "label": "Baseline",
        "reason": "Scores 84% on the baseline date — no launch slip needed.",
    }
    assert len(seen_requests) == 2
    assert all(request.includeTimeseries is False for request in seen_requests)
    assert all(
        isinstance(request.landingTime, datetime) for request in seen_requests
    )


def test_scenario_compare_returns_no_recommendation_when_requirements_fail(
    monkeypatch,
):
    async def fake_create_simulation(_request):
        return {
            "id": "sim-low",
            "summary": {
                "successPct": 40,
                "minSocPct": 10.0,
                "earthVisiblePct": 20.0,
            },
            "windows": {"sun": [], "earth": [], "both": []},
        }

    monkeypatch.setattr("app.simulation_routes.create_simulation", fake_create_simulation)
    response = client.post(
        f"{API}/scenarios/compare",
        json={
            "scenarios": [
                _scenario("A", "2027-03-14T06:00:00Z"),
                _scenario("B", "2027-03-28T06:00:00Z"),
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["recommendation"] is None
    assert all(
        not result["meetsRequirements"] for result in response.json()["results"]
    )


def test_scenario_compare_validates_count_and_excludes_timeseries():
    too_few = client.post(
        f"{API}/scenarios/compare",
        json={"scenarios": [_scenario("Only", "2027-03-14T06:00:00Z")]},
    )
    assert too_few.status_code == 400
    assert too_few.json()["error"]["field"] == "scenarios"

    too_many = client.post(
        f"{API}/scenarios/compare",
        json={
            "scenarios": [
                _scenario(str(index), f"2027-03-{14 + index:02d}T06:00:00Z")
                for index in range(5)
            ],
        },
    )
    assert too_many.status_code == 400

    with_timeseries = client.post(
        f"{API}/scenarios/compare",
        json={
            "scenarios": [
                {
                    **_scenario("A", "2027-03-14T06:00:00Z"),
                    "includeTimeseries": True,
                },
                _scenario("B", "2027-03-28T06:00:00Z"),
            ],
        },
    )
    assert with_timeseries.status_code == 400
