import asyncio
import math
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.api_utils import API_PREFIX, normalize_longitude
from app.dem_window_source import fetch_dem_window
from app.heightmap_source import fetch_lunar_heightmap
from app.horizon_source import (
    HORIZON_MAX_DISTANCE_KM,
    prepare_horizon_profiles,
)
from app.layer_grid_source import build_slope_grid, fetch_psr_grid
from app.simulation import (
    SimulationHardware,
    SimulationRequest,
    SimulationSite,
    SimulationWeights,
)
from app.simulation_routes import create_simulation

router = APIRouter(prefix=API_PREFIX)
LUNAR_RADIUS_KM = 1737.4
GRID_DIMENSION = 3
GRID_OFFSETS = (-1, 0, 1)
HEIGHTMAP_SIZES_KM = (5, 10, 20, 40)


class NearbyCenter(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=360)


class NearbyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    center: NearbyCenter
    radiusKm: float = Field(gt=0, le=10)
    cellM: float = Field(default=100, gt=0, le=10_000)
    landingTime: datetime
    missionDays: int = Field(default=14, ge=1, le=30)
    goal: Literal["balanced", "power", "comms"] = "balanced"
    maxSlopeDeg: float = Field(default=10, ge=0, le=90)
    top: int = Field(default=3, ge=1, le=3)


def _destination(lat: float, lon: float, east_m: float, north_m: float) -> tuple[float, float]:
    distance_m = math.hypot(east_m, north_m)
    if distance_m == 0:
        return lat, lon

    bearing = math.atan2(east_m, north_m)
    angular_distance = distance_m / (LUNAR_RADIUS_KM * 1000)
    latitude = math.radians(lat)
    destination_latitude = math.asin(
        math.sin(latitude) * math.cos(angular_distance)
        + math.cos(latitude) * math.sin(angular_distance) * math.cos(bearing)
    )
    destination_longitude = math.radians(lon) + math.atan2(
        math.sin(bearing)
        * math.sin(angular_distance)
        * math.cos(latitude),
        math.cos(angular_distance)
        - math.sin(latitude) * math.sin(destination_latitude),
    )
    return (
        math.degrees(destination_latitude),
        normalize_longitude(math.degrees(destination_longitude)),
    )


def _heightmap_size_km(radius_km: float) -> float:
    for size_km in HEIGHTMAP_SIZES_KM:
        if size_km * 7 / 16 >= radius_km:
            return float(size_km)
    raise ValueError("The requested radius exceeds the available heightmap size.")


def _grid_index(
    east_m: float, north_m: float, cell_size_m: float, res: int
) -> tuple[int, int]:
    col = round(res // 2 + east_m / cell_size_m)
    row = round(res // 2 - north_m / cell_size_m)
    return row, col


def _metric_reasons(
    center_summary: dict[str, Any],
    candidate_summary: dict[str, Any],
    mission_days: int,
) -> list[str]:
    reasons = []
    sunlight_days = (
        candidate_summary["sunlitPct"] - center_summary["sunlitPct"]
    ) * mission_days / 100
    if abs(sunlight_days) >= 0.1:
        reasons.append(f"{sunlight_days:+.1f} days of sunlight")

    battery_delta = (
        candidate_summary["minSocPct"] - center_summary["minSocPct"]
    )
    if abs(battery_delta) >= 1:
        reasons.append(f"{battery_delta:+.1f} pp minimum battery charge")

    earth_delta = (
        candidate_summary["earthVisiblePct"]
        - center_summary["earthVisiblePct"]
    )
    if abs(earth_delta) >= 1:
        reasons.append(f"{earth_delta:+.1f} pp Earth visibility")
    return reasons or ["Higher weighted mission score for the selected goal."]


def _goal_weights(goal: str) -> SimulationWeights:
    if goal == "power":
        return SimulationWeights(power=0.7, comms=0.15, night=0.15)
    if goal == "comms":
        return SimulationWeights(power=0.2, comms=0.6, night=0.2)
    return SimulationWeights()


@router.post("/nearby")
async def find_nearby(request: NearbyRequest) -> dict[str, Any]:
    if request.landingTime.tzinfo is None or request.landingTime.utcoffset() is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "landingTime must include a UTC offset.",
                "field": "landingTime",
            },
        )

    center_lat = request.center.lat
    center_lon = normalize_longitude(request.center.lon)
    radius_m = request.radiusKm * 1000
    offsets = [
        (east_index * radius_m, north_index * radius_m)
        for north_index in GRID_OFFSETS
        for east_index in GRID_OFFSETS
    ]
    coordinates = [
        _destination(center_lat, center_lon, east_m, north_m)
        for east_m, north_m in offsets
    ]
    excluded = [[True] * GRID_DIMENSION for _ in range(GRID_DIMENSION)]
    success_grid: list[list[int | None]] = [
        [None] * GRID_DIMENSION for _ in range(GRID_DIMENSION)
    ]

    size_km = _heightmap_size_km(request.radiusKm)
    await fetch_dem_window(
        center_lat,
        center_lon,
        required_margin_m=HORIZON_MAX_DISTANCE_KM * 1000 + radius_m,
    )
    heightmap, psr_grid = await asyncio.gather(
        fetch_lunar_heightmap(center_lat, center_lon, size_km, 16),
        fetch_psr_grid(center_lat, center_lon, size_km, 16),
    )
    slope_grid = build_slope_grid(heightmap)
    cell_size_m = size_km * 1000 / 16
    candidates: list[tuple[int, int, float, float, float]] = []

    for index, ((east_m, north_m), (lat, lon)) in enumerate(
        zip(offsets, coordinates)
    ):
        row, col = divmod(index, GRID_DIMENSION)
        distance_km = math.hypot(east_m, north_m) / 1000
        if distance_km > request.radiusKm + 1e-9:
            continue

        source_row, source_col = _grid_index(
            east_m, north_m, cell_size_m, 16
        )
        slope = slope_grid["values"][source_row][source_col]
        psr = psr_grid["values"][source_row][source_col]
        is_center = east_m == 0 and north_m == 0
        is_excluded = (
            slope is None
            or slope > request.maxSlopeDeg
            # psr None = outside the PSR map (e.g. north of 80°S): unknown, not unsafe.
            or psr == 1
        )
        excluded[row][col] = is_excluded
        if is_excluded and not is_center:
            continue
        candidates.append((row, col, lat, lon, distance_km))

    weights = _goal_weights(request.goal)
    hardware = SimulationHardware()
    await prepare_horizon_profiles(
        center_lat,
        center_lon,
        [(candidate[2], candidate[3]) for candidate in candidates],
        (hardware.panelHeightM, hardware.mastHeightM),
        neighborhood_radius_m=radius_m,
    )

    async def evaluate(
        lat: float, lon: float
    ) -> dict[str, Any]:
        simulation_request = SimulationRequest(
            site=SimulationSite(lat=lat, lon=lon),
            landingTime=request.landingTime,
            missionDays=request.missionDays,
            windowDays=request.missionDays,
            stepMin=60,
            hardware=hardware,
            weights=weights,
            includeTimeseries=False,
        )
        return await create_simulation(simulation_request)

    evaluations = await asyncio.gather(
        *(evaluate(candidate[2], candidate[3]) for candidate in candidates)
    )
    results_by_cell = {
        (candidate[0], candidate[1]): result
        for candidate, result in zip(candidates, evaluations)
    }

    center_cell = (1, 1)
    center_result = results_by_cell.get(center_cell)
    if center_result is None:
        raise RuntimeError("The nearby grid did not evaluate its center.")
    center_summary = center_result["summary"]

    for cell, result in results_by_cell.items():
        row, col = cell
        success_grid[row][col] = result["summary"]["successPct"]

    suggestion_candidates = []
    for row, col, lat, lon, distance_km in candidates:
        if (row, col) == center_cell:
            continue
        result = results_by_cell[(row, col)]
        summary = result["summary"]
        if summary["successPct"] <= center_summary["successPct"]:
            continue
        suggestion_candidates.append(
            {
                "_successPct": summary["successPct"],
                "_distanceKm": distance_km,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "distanceKm": round(distance_km, 3),
                "successPct": summary["successPct"],
                "why": _metric_reasons(
                    center_summary, summary, request.missionDays
                ),
            }
        )
    suggestion_candidates.sort(
        key=lambda item: (-item["_successPct"], item["_distanceKm"])
    )
    suggestions = []
    for index, item in enumerate(suggestion_candidates[: request.top]):
        suggestions.append(
            {
                "rank": chr(ord("A") + index),
                "lat": item["lat"],
                "lon": item["lon"],
                "distanceKm": item["distanceKm"],
                "successPct": item["successPct"],
                "why": item["why"],
            }
        )

    north_west = _destination(center_lat, center_lon, -radius_m, radius_m)
    return {
        "grid": {
            "originLat": round(north_west[0], 6),
            "originLon": round(north_west[1], 6),
            "cellM": round(radius_m, 1),
            "cols": GRID_DIMENSION,
            "rows": GRID_DIMENSION,
            "successPct": success_grid,
            "excluded": excluded,
        },
        "center": {"successPct": center_summary["successPct"]},
        "suggestions": suggestions,
    }
