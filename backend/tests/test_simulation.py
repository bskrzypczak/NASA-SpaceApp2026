from datetime import datetime, timezone

import pytest

from app.simulation import (
    SimulationRequest,
    _score_summary,
    build_simulation_result,
    interpolate_horizon,
    sun_visible_fraction,
)


def test_solar_disk_visibility_fraction_has_tangent_endpoints():
    assert sun_visible_fraction(-0.266) == 0
    assert sun_visible_fraction(0) == 0.5
    assert sun_visible_fraction(0.266) == 1


def test_success_score_uses_conventional_half_up_rounding():
    success_pct, _, _ = _score_summary(
        min_soc_pct=25.3,
        earth_visible_pct=25,
        longest_night_h=120,
        weights={"power": 0.5, "comms": 0.3, "night": 0.2},
    )

    assert success_pct == 51


def test_horizon_interpolation_wraps_from_last_azimuth_to_north():
    profile = {
        "azimuthDeg": [0.0, 90.0, 180.0, 270.0],
        "elevationDeg": [10.0, 20.0, 30.0, 40.0],
    }

    assert interpolate_horizon(profile, 90.0) == 20.0
    assert interpolate_horizon(profile, 315.0) == 25.0


def test_simulation_calculates_windows_events_battery_and_score():
    request = SimulationRequest(
        site={"lat": 0.0, "lon": 0.0},
        landingTime=datetime(2027, 3, 14, 6, tzinfo=timezone.utc),
        missionDays=1,
        windowDays=1,
        stepMin=720,
        horizonModel="flat",
        hardware={
            "batteryWh": 1000,
            "solarW": 0,
            "dayLoadW": 0,
            "nightLoadW": 100,
            "reservePct": 20,
        },
    )
    ephemeris = {
        "sun": {"azDeg": [0.0, 180.0], "elDeg": [-90.0, -90.0]},
        "earth": {"azDeg": [0.0, 180.0], "elDeg": [-1.95, 0.05]},
    }

    result = build_simulation_result(
        request=request,
        input_echo={},
        site={"name": "Test site", "lat": 0.0, "lon": 0.0, "elevationM": 0.0},
        ephemeris=ephemeris,
        sun_horizon=None,
        earth_horizon=None,
        simulation_id="sim_test",
        created_at="2027-03-14T06:00:00Z",
        weights={"power": 0.5, "comms": 0.3, "night": 0.2},
    )

    assert result["summary"]["successPct"] == 50
    assert result["summary"]["verdict"] == "RISKY"
    assert result["summary"]["earthVisiblePct"] == 75
    assert result["summary"]["longestNightH"] == 24
    assert result["summary"]["minSocPct"] == 0
    assert result["summary"]["firstEarthsetDay"] is None
    assert result["windows"]["earth"] == [{"fromDay": 0.25, "toDay": 1.0}]
    assert result["timeseries"]["socPct"] == [100.0, 0.0]
    assert [event["type"] for event in result["events"]] == [
        "EARTHRISE",
        "BATTERY_LOW",
        "MISSION_END",
    ]


def test_simulation_rejects_malformed_horizon_profile():
    with pytest.raises(ValueError, match="invalid shape"):
        interpolate_horizon(
            {"azimuthDeg": [0.0, 90.0], "elevationDeg": [0.0]},
            20.0,
        )
