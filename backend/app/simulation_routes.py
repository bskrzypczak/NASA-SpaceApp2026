import asyncio
import hashlib
import json
import logging
import math
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException

from app.api_utils import API_PREFIX, normalize_longitude
from app.horizon_source import fetch_horizon
from app.scenarios import (
    ScenarioCompareRequest,
    choose_recommendation,
    meets_requirements,
)
from app.simulation import SimulationRequest, build_simulation_result
from app.sites import SITE_BY_ID
from app.sources import fetch_ephemeris, fetch_lunar_elevation

logger = logging.getLogger(__name__)
router = APIRouter(prefix=API_PREFIX)
MAX_SIMULATIONS = 256
SIMULATIONS: dict[str, dict] = {}


@router.post("/simulations", status_code=201)
async def create_simulation(request: SimulationRequest) -> dict:
    site_id = request.site.siteId
    has_coordinates = request.site.lat is not None or request.site.lon is not None
    if site_id is not None and has_coordinates:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "site must contain either siteId or lat and lon.",
                "field": "site",
            },
        )
    if site_id is not None:
        source_site = SITE_BY_ID.get(site_id)
        if source_site is None:
            raise HTTPException(status_code=404, detail="Unknown siteId.")
        lat = source_site["lat"]
        lon = normalize_longitude(source_site["lon"])
        site_name = source_site["name"]
    else:
        if request.site.lat is None or request.site.lon is None:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "VALIDATION_ERROR",
                    "message": "site must contain either siteId or both lat and lon.",
                    "field": "site",
                },
            )
        lat = request.site.lat
        lon = normalize_longitude(request.site.lon)
        site_name = "Custom landing site"

    if request.missionDays > request.windowDays:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "missionDays cannot exceed windowDays.",
                "field": "missionDays",
            },
        )
    if (
        request.windowDays * 1440 % request.stepMin != 0
        or request.missionDays * 1440 % request.stepMin != 0
    ):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "stepMin must divide both missionDays and windowDays exactly.",
                "field": "stepMin",
            },
        )
    sample_count = request.windowDays * 1440 // request.stepMin
    if sample_count > 4320:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "The request exceeds the 4320-sample limit.",
                "field": "stepMin",
            },
        )
    if request.landingTime.tzinfo is None or request.landingTime.utcoffset() is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "landingTime must include a UTC offset.",
                "field": "landingTime",
            },
        )
    landing_time = request.landingTime.astimezone(timezone.utc)
    if landing_time.second != 0 or landing_time.microsecond != 0:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "landingTime must be aligned to a whole minute.",
                "field": "landingTime",
            },
        )
    if request.horizonModel == "real" and lat > -80:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OUT_OF_DEM_COVERAGE",
                "message": "Real terrain simulations require latitude at or south of 80°S.",
                "field": "site.lat",
            },
        )

    hardware = request.hardware
    hardware_values = (
        hardware.batteryWh,
        hardware.solarW,
        hardware.dayLoadW,
        hardware.nightLoadW,
        hardware.reservePct,
        hardware.panelHeightM,
        hardware.mastHeightM,
    )
    if any(not math.isfinite(value) for value in hardware_values):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "hardware values must be finite numbers.",
                "field": "hardware",
            },
        )
    weights = {
        key: float(getattr(request.weights, key))
        for key in ("power", "comms", "night")
    }
    if any(not math.isfinite(value) for value in weights.values()):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "weights must be finite numbers.",
                "field": "weights",
            },
        )
    weight_total = sum(weights.values())
    if weight_total <= 0:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "At least one weight must be greater than zero.",
                "field": "weights",
            },
        )
    weights = {key: value / weight_total for key, value in weights.items()}

    input_echo = {
        "site": (
            {"siteId": site_id}
            if site_id is not None
            else {"lat": lat, "lon": lon}
        ),
        "landingTime": landing_time.isoformat().replace("+00:00", "Z"),
        "missionDays": request.missionDays,
        "windowDays": request.windowDays,
        "stepMin": request.stepMin,
        "horizonModel": request.horizonModel,
        "hardware": {
            "batteryWh": hardware.batteryWh,
            "solarW": hardware.solarW,
            "dayLoadW": hardware.dayLoadW,
            "nightLoadW": hardware.nightLoadW,
            "reservePct": hardware.reservePct,
            "panelHeightM": hardware.panelHeightM,
            "mastHeightM": hardware.mastHeightM,
        },
        "weights": weights,
        "includeTimeseries": request.includeTimeseries,
    }
    request_hash = hashlib.sha256(
        json.dumps(input_echo, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    simulation_id = f"sim_{request_hash[:12]}"
    existing = SIMULATIONS.get(simulation_id)
    if existing is not None:
        return existing

    end_time = landing_time + timedelta(days=request.windowDays)
    end_time -= timedelta(minutes=request.stepMin)
    ephemeris, terrain = await asyncio.gather(
        fetch_ephemeris(
            lat,
            lon,
            landing_time,
            end_time,
            request.stepMin,
            {"sun", "earth"},
        ),
        fetch_lunar_elevation(lat, lon),
    )

    sun_horizon = None
    earth_horizon = None
    if request.horizonModel == "real":
        if hardware.panelHeightM == hardware.mastHeightM:
            sun_horizon = await fetch_horizon(
                lat, lon, hardware.panelHeightM, 0.5
            )
            earth_horizon = sun_horizon
        else:
            sun_horizon, earth_horizon = await asyncio.gather(
                fetch_horizon(lat, lon, hardware.panelHeightM, 0.5),
                fetch_horizon(lat, lon, hardware.mastHeightM, 0.5),
            )

    normalized_request = request.model_copy(update={"landingTime": landing_time})
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        result = build_simulation_result(
            request=normalized_request,
            input_echo=input_echo,
            site={
                "name": site_name,
                "lat": lat,
                "lon": lon,
                "elevationM": terrain["elevationM"],
            },
            ephemeris=ephemeris,
            sun_horizon=sun_horizon,
            earth_horizon=earth_horizon,
            simulation_id=simulation_id,
            created_at=created_at,
            weights=weights,
        )
    except ValueError as exc:
        logger.exception("Could not process upstream data for the simulation.")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": "The ephemeris or horizon data could not be processed.",
                "field": None,
                "retryAfterS": 5,
            },
        ) from exc

    if len(SIMULATIONS) >= MAX_SIMULATIONS:
        SIMULATIONS.pop(next(iter(SIMULATIONS)))
    SIMULATIONS[simulation_id] = result
    return result


@router.get("/simulations/{simulation_id}")
async def get_simulation(simulation_id: str) -> dict:
    simulation = SIMULATIONS.get(simulation_id)
    if simulation is None:
        raise HTTPException(status_code=404, detail="Unknown simulationId.")
    return simulation


@router.post("/scenarios/compare")
async def compare_scenarios(request: ScenarioCompareRequest) -> dict:
    simulation_requests = [
        SimulationRequest.model_validate(scenario.model_dump(exclude={"label"}))
        for scenario in request.scenarios
    ]
    simulations = await asyncio.gather(
        *(
            create_simulation(simulation_request)
            for simulation_request in simulation_requests
        )
    )
    results = [
        {
            "label": scenario.label,
            "simulationId": simulation["id"],
            "summary": simulation["summary"],
            "windows": simulation["windows"],
            "meetsRequirements": meets_requirements(
                simulation["summary"], request.requirements
            ),
        }
        for scenario, simulation in zip(request.scenarios, simulations)
    ]
    return {
        "results": results,
        "recommendation": choose_recommendation(request.scenarios, results),
    }
