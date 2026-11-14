import math
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _SimulationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class SimulationSite(_SimulationModel):
    siteId: str | None = Field(default=None, min_length=1)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=360)


class SimulationHardware(_SimulationModel):
    batteryWh: float = Field(default=20_000, gt=0)
    solarW: float = Field(default=600, ge=0)
    dayLoadW: float = Field(default=300, ge=0)
    nightLoadW: float = Field(default=140, ge=0)
    reservePct: float = Field(default=20, ge=0, le=100)
    panelHeightM: float = Field(default=2, ge=0)
    mastHeightM: float = Field(default=3.5, ge=0)


class SimulationWeights(_SimulationModel):
    power: float = Field(default=0.5, ge=0, le=1)
    comms: float = Field(default=0.3, ge=0, le=1)
    night: float = Field(default=0.2, ge=0, le=1)


class SimulationRequest(_SimulationModel):
    site: SimulationSite
    landingTime: datetime
    missionDays: int = Field(default=14, ge=1, le=30)
    windowDays: int = Field(default=30, ge=1, le=30)
    stepMin: int = Field(default=10, ge=1, le=1440)
    horizonModel: Literal["real", "flat"] = "real"
    hardware: SimulationHardware = Field(default_factory=SimulationHardware)
    weights: SimulationWeights = Field(default_factory=SimulationWeights)
    includeTimeseries: bool = True


SUN_ANGULAR_RADIUS_DEG = 0.266
EARTH_ANGULAR_RADIUS_DEG = 0.95


def interpolate_horizon(profile: dict[str, Any] | None, azimuth_deg: float) -> float:
    if profile is None:
        return 0.0
    azimuths = profile.get("azimuthDeg")
    elevations = profile.get("elevationDeg")
    if (
        not isinstance(azimuths, list)
        or not isinstance(elevations, list)
        or len(azimuths) != len(elevations)
        or not azimuths
    ):
        raise ValueError("The horizon profile has an invalid shape.")
    if len(azimuths) == 1:
        return float(elevations[0])

    step = 360.0 / len(azimuths)
    position = (azimuth_deg % 360.0) / step
    lower = math.floor(position)
    fraction = position - lower
    lower %= len(elevations)
    upper = (lower + 1) % len(elevations)
    lower_elevation = float(elevations[lower])
    upper_elevation = float(elevations[upper])
    if not math.isfinite(lower_elevation) or not math.isfinite(upper_elevation):
        raise ValueError("The horizon profile contains a non-finite elevation.")
    return lower_elevation + (upper_elevation - lower_elevation) * fraction


def sun_visible_fraction(clearance_deg: float) -> float:
    if clearance_deg <= -SUN_ANGULAR_RADIUS_DEG:
        return 0.0
    if clearance_deg >= SUN_ANGULAR_RADIUS_DEG:
        return 1.0
    ratio = clearance_deg / SUN_ANGULAR_RADIUS_DEG
    circle_segment = math.asin(ratio) + ratio * math.sqrt(1 - ratio * ratio)
    return 0.5 + circle_segment / math.pi


def _crossing_fraction(first: float, second: float) -> float:
    denominator = first - second
    if denominator == 0:
        return 0.5
    return min(1.0, max(0.0, first / denominator))


def _visibility_windows(
    clearances: list[float], step_days: float, end_day: float
) -> list[dict[str, float]]:
    windows: list[dict[str, float]] = []
    visible = clearances[0] > 0
    start_day = 0.0 if visible else None

    for index in range(1, len(clearances)):
        next_visible = clearances[index] > 0
        if next_visible == visible:
            continue
        fraction = _crossing_fraction(clearances[index - 1], clearances[index])
        crossing_day = (index - 1 + fraction) * step_days
        if visible and start_day is not None:
            windows.append({"fromDay": start_day, "toDay": crossing_day})
            start_day = None
        else:
            start_day = crossing_day
        visible = next_visible

    if visible and start_day is not None:
        windows.append({"fromDay": start_day, "toDay": end_day})
    return windows


def _longest_gap_hours(
    windows: list[dict[str, float]], duration_days: float
) -> float:
    longest = 0.0
    cursor = 0.0
    for window in windows:
        longest = max(longest, window["fromDay"] - cursor)
        cursor = window["toDay"]
    longest = max(longest, duration_days - cursor)
    return longest * 24


def _window_percent(windows: list[dict[str, float]], duration_days: float) -> float:
    visible_days = sum(window["toDay"] - window["fromDay"] for window in windows)
    return visible_days / duration_days * 100


def _interpolate_angle(first: float, second: float, fraction: float) -> float:
    delta = (second - first + 180) % 360 - 180
    return (first + delta * fraction) % 360


def _timestamp_at_day(landing_time: datetime, day: float) -> str:
    timestamp = landing_time + timedelta(days=day)
    return timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _transition_events(
    body: str,
    clearances: list[float],
    azimuths: list[float],
    elevations: list[float],
    step_days: float,
    landing_time: datetime,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for index in range(1, len(clearances)):
        was_visible = clearances[index - 1] > 0
        is_visible = clearances[index] > 0
        if was_visible == is_visible:
            continue
        fraction = _crossing_fraction(clearances[index - 1], clearances[index])
        day = (index - 1 + fraction) * step_days
        events.append(
            {
                "type": f"{body}{'RISE' if is_visible else 'SET'}",
                "time": _timestamp_at_day(landing_time, day),
                "day": round(day, 4),
                "azDeg": round(
                    _interpolate_angle(
                        azimuths[index - 1], azimuths[index], fraction
                    ),
                    2,
                ),
                "elDeg": round(
                    elevations[index - 1]
                    + (elevations[index] - elevations[index - 1]) * fraction,
                    2,
                ),
            }
        )
    return events


def _battery_history(
    sun_visible_fractions: list[float],
    hardware: SimulationHardware,
    step_hours: float,
) -> tuple[list[float], float]:
    energy = hardware.batteryWh
    soc = [100.0]
    for visible_fraction in sun_visible_fractions[:-1]:
        if visible_fraction > 0:
            net_power = (
                hardware.solarW * visible_fraction - hardware.dayLoadW
            )
        else:
            net_power = -hardware.nightLoadW
        energy = min(
            hardware.batteryWh,
            max(0.0, energy + net_power * step_hours),
        )
        soc.append(energy / hardware.batteryWh * 100)

    last_fraction = sun_visible_fractions[-1]
    if last_fraction > 0:
        net_power = hardware.solarW * last_fraction - hardware.dayLoadW
    else:
        net_power = -hardware.nightLoadW
    final_energy = min(
        hardware.batteryWh,
        max(0.0, energy + net_power * step_hours),
    )
    return soc, final_energy / hardware.batteryWh * 100


def _battery_low_event(
    soc: list[float],
    final_soc: float,
    reserve_pct: float,
    step_days: float,
    end_day: float,
    landing_time: datetime,
) -> dict[str, Any] | None:
    for index in range(1, len(soc)):
        if soc[index - 1] > reserve_pct >= soc[index]:
            fraction = _crossing_fraction(
                soc[index - 1] - reserve_pct, soc[index] - reserve_pct
            )
            day = (index - 1 + fraction) * step_days
            return {
                "type": "BATTERY_LOW",
                "time": _timestamp_at_day(landing_time, day),
                "day": round(day, 4),
            }
    if soc[-1] > reserve_pct >= final_soc:
        fraction = _crossing_fraction(soc[-1] - reserve_pct, final_soc - reserve_pct)
        day = (len(soc) - 1 + fraction) * step_days
        day = min(day, end_day)
        return {
            "type": "BATTERY_LOW",
            "time": _timestamp_at_day(landing_time, day),
            "day": round(day, 4),
        }
    return None


def _score_summary(
    min_soc_pct: float,
    earth_visible_pct: float,
    longest_night_h: float,
    weights: dict[str, float],
) -> tuple[int, str, list[dict[str, Any]]]:
    scores = {
        "power": min(1.0, max(0.0, (min_soc_pct - 10) / 30)),
        "comms": min(1.0, max(0.0, earth_visible_pct / 50)),
        "night": min(1.0, max(0.0, 1 - (longest_night_h - 72) / 96)),
    }
    metrics = {
        "power": ("minSocPct", min_soc_pct),
        "comms": ("earthVisiblePct", earth_visible_pct),
        "night": ("longestNightH", longest_night_h),
    }
    factors = []
    for key in ("power", "comms", "night"):
        metric, value = metrics[key]
        factors.append(
            {
                "key": key,
                "metric": metric,
                "value": round(value, 2),
                "score": round(scores[key], 3),
                "weight": round(weights[key], 3),
                "points": round(scores[key] * weights[key] * 100, 1),
                "ok": scores[key] >= 0.6,
            }
        )

    weighted_score = sum(weights[key] * scores[key] for key in scores)
    success_pct = math.floor(min(97.0, max(5.0, 100 * weighted_score)) + 0.5)
    verdict = "LIKELY" if success_pct >= 80 else "POSSIBLE" if success_pct >= 60 else "RISKY"
    return success_pct, verdict, factors


def _calculate_case(
    *,
    request: SimulationRequest,
    landing_time: datetime,
    days: list[float],
    sun_azimuths: list[float],
    sun_elevations: list[float],
    earth_azimuths: list[float],
    earth_elevations: list[float],
    sun_masks: list[float],
    earth_masks: list[float],
    weights: dict[str, float],
) -> dict[str, Any]:
    sun_clearances = [
        elevation - mask + SUN_ANGULAR_RADIUS_DEG
        for elevation, mask in zip(sun_elevations, sun_masks)
    ]
    earth_clearances = [
        elevation - mask + EARTH_ANGULAR_RADIUS_DEG
        for elevation, mask in zip(earth_elevations, earth_masks)
    ]
    sun_visible_fractions = [
        sun_visible_fraction(elevation - mask)
        for elevation, mask in zip(sun_elevations, sun_masks)
    ]
    sun_windows = _visibility_windows(
        sun_clearances, request.stepMin / 1440, request.windowDays
    )
    earth_windows = _visibility_windows(
        earth_clearances, request.stepMin / 1440, request.windowDays
    )
    both_clearances = [
        min(sun, earth) for sun, earth in zip(sun_clearances, earth_clearances)
    ]
    both_windows = _visibility_windows(
        both_clearances, request.stepMin / 1440, request.windowDays
    )

    mission_sample_count = request.missionDays * 1440 // request.stepMin
    mission_sun_windows = _visibility_windows(
        sun_clearances[:mission_sample_count],
        request.stepMin / 1440,
        request.missionDays,
    )
    mission_earth_windows = _visibility_windows(
        earth_clearances[:mission_sample_count],
        request.stepMin / 1440,
        request.missionDays,
    )
    mission_both_windows = _visibility_windows(
        both_clearances[:mission_sample_count],
        request.stepMin / 1440,
        request.missionDays,
    )
    step_days = request.stepMin / 1440
    step_hours = request.stepMin / 60
    soc, final_soc = _battery_history(
        sun_visible_fractions, request.hardware, step_hours
    )
    mission_soc = [
        (days[index], value)
        for index, value in enumerate(soc)
        if days[index] <= request.missionDays
    ]
    if request.missionDays == request.windowDays:
        mission_soc.append((request.windowDays, final_soc))
    min_soc_day, min_soc_pct = min(mission_soc, key=lambda value: value[1])
    sunlit_pct = _window_percent(mission_sun_windows, request.missionDays)
    earth_visible_pct = _window_percent(mission_earth_windows, request.missionDays)
    both_pct = _window_percent(mission_both_windows, request.missionDays)
    longest_night_h = _longest_gap_hours(
        mission_sun_windows, request.missionDays
    )
    longest_comms_gap_h = _longest_gap_hours(
        mission_earth_windows, request.missionDays
    )
    success_pct, verdict, factors = _score_summary(
        min_soc_pct, earth_visible_pct, longest_night_h, weights
    )

    events = _transition_events(
        "SUN",
        sun_clearances,
        sun_azimuths,
        sun_elevations,
        step_days,
        landing_time,
    )
    events.extend(
        _transition_events(
            "EARTH",
            earth_clearances,
            earth_azimuths,
            earth_elevations,
            step_days,
            landing_time,
        )
    )
    battery_event = _battery_low_event(
        soc,
        final_soc,
        request.hardware.reservePct,
        step_days,
        request.windowDays,
        landing_time,
    )
    if battery_event is not None:
        events.append(battery_event)
    events.append(
        {
            "type": "MISSION_END",
            "time": _timestamp_at_day(landing_time, request.missionDays),
            "day": float(request.missionDays),
        }
    )
    events.sort(key=lambda event: (event["day"], event["type"]))

    summary = {
        "successPct": success_pct,
        "verdict": verdict,
        "sunlitPct": round(sunlit_pct, 2),
        "earthVisiblePct": round(earth_visible_pct, 2),
        "bothPct": round(both_pct, 2),
        "minSocPct": round(min_soc_pct, 2),
        "minSocAtDay": round(min_soc_day, 4),
        "longestNightH": round(longest_night_h, 2),
        "longestCommsGapH": round(longest_comms_gap_h, 2),
        "firstSunsetDay": next(
            (event["day"] for event in events if event["type"] == "SUNSET"),
            None,
        ),
        "firstEarthsetDay": next(
            (event["day"] for event in events if event["type"] == "EARTHSET"),
            None,
        ),
    }
    timeseries = {
        "stepMin": request.stepMin,
        "day": [round(day, 6) for day in days],
        "sunAzDeg": [round(value, 3) for value in sun_azimuths],
        "sunElDeg": [round(value, 3) for value in sun_elevations],
        "sunMaskElDeg": [round(value, 3) for value in sun_masks],
        "sunVisibleFrac": [round(value, 4) for value in sun_visible_fractions],
        "earthAzDeg": [round(value, 3) for value in earth_azimuths],
        "earthElDeg": [round(value, 3) for value in earth_elevations],
        "earthMaskElDeg": [round(value, 3) for value in earth_masks],
        "earthVisible": [clearance > 0 for clearance in earth_clearances],
        "socPct": [round(value, 2) for value in soc],
    }
    return {
        "summary": summary,
        "factors": factors,
        "events": events,
        "windows": {
            "sun": sun_windows,
            "earth": earth_windows,
            "both": both_windows,
        },
        "timeseries": timeseries,
    }


def build_simulation_result(
    *,
    request: SimulationRequest,
    input_echo: dict[str, Any],
    site: dict[str, Any],
    ephemeris: dict[str, Any],
    sun_horizon: dict[str, Any] | None,
    earth_horizon: dict[str, Any] | None,
    simulation_id: str,
    created_at: str,
    weights: dict[str, float],
) -> dict[str, Any]:
    expected_samples = request.windowDays * 1440 // request.stepMin
    days = [
        index * request.stepMin / 1440
        for index in range(expected_samples)
    ]
    try:
        sun = ephemeris["sun"]
        earth = ephemeris["earth"]
        sun_azimuths = [float(value) for value in sun["azDeg"]]
        sun_elevations = [float(value) for value in sun["elDeg"]]
        earth_azimuths = [float(value) for value in earth["azDeg"]]
        earth_elevations = [float(value) for value in earth["elDeg"]]
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Horizons returned an incomplete ephemeris.") from exc

    all_series = (sun_azimuths, sun_elevations, earth_azimuths, earth_elevations)
    if any(len(series) != expected_samples for series in all_series):
        raise ValueError("Horizons returned an unexpected number of samples.")
    if any(not math.isfinite(value) for series in all_series for value in series):
        raise ValueError("Horizons returned non-finite ephemeris values.")

    sun_masks = [
        interpolate_horizon(sun_horizon, azimuth) for azimuth in sun_azimuths
    ]
    earth_masks = [
        interpolate_horizon(earth_horizon, azimuth) for azimuth in earth_azimuths
    ]
    actual_sun_masks = sun_masks if request.horizonModel == "real" else [0.0] * len(days)
    actual_earth_masks = (
        earth_masks if request.horizonModel == "real" else [0.0] * len(days)
    )
    actual = _calculate_case(
        request=request,
        landing_time=request.landingTime.astimezone(timezone.utc),
        days=days,
        sun_azimuths=sun_azimuths,
        sun_elevations=sun_elevations,
        earth_azimuths=earth_azimuths,
        earth_elevations=earth_elevations,
        sun_masks=actual_sun_masks,
        earth_masks=actual_earth_masks,
        weights=weights,
    )
    flat = _calculate_case(
        request=request,
        landing_time=request.landingTime.astimezone(timezone.utc),
        days=days,
        sun_azimuths=sun_azimuths,
        sun_elevations=sun_elevations,
        earth_azimuths=earth_azimuths,
        earth_elevations=earth_elevations,
        sun_masks=[0.0] * len(days),
        earth_masks=[0.0] * len(days),
        weights=weights,
    )
    actual["summary"]["flatHorizonSuccessPct"] = flat["summary"]["successPct"]

    result = {
        "id": simulation_id,
        "createdAt": created_at,
        "input": input_echo,
        "site": site,
        **actual,
    }
    if not request.includeTimeseries:
        result.pop("timeseries")
    return result
