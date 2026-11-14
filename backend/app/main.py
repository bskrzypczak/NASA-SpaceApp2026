import asyncio
import hashlib
import json
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.simulation import SimulationRequest, build_simulation_result
from app.sites import FEATURED_IDS, SITE_BY_ID, SITES
from app.sources import fetch_ephemeris, fetch_horizon, fetch_lunar_elevation

API_PREFIX = "/api/v1"
LUNAR_RADIUS_KM = 1737.4
MAX_SIMULATIONS = 256
SIMULATIONS: dict[str, dict] = {}
SiteGroup = Literal["Artemis III", "CLPS", "Commercial", "Other nations", "Apollo"]
Region = Literal["South pole", "Near side", "Far side"]

app = FastAPI(
    title="HORIZON API",
    description="Backend API for the HORIZON lunar landing site planner.",
    version="0.1.0",
)

origins = [
    origin.strip()
    for origin in os.getenv("FRONTEND_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    errors = exc.errors()
    first_error = errors[0] if errors else {}
    location = first_error.get("loc", ())
    field = str(location[-1]) if location else None
    message = first_error.get("msg", "Invalid request.")
    return JSONResponse(
        status_code=400,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": message,
                "field": field,
            }
        },
    )


@app.exception_handler(HTTPException)
async def http_error_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict):
        error = exc.detail
    else:
        error = {
            "code": "NOT_FOUND" if exc.status_code == 404 else "HTTP_ERROR",
            "message": str(exc.detail),
            "field": None,
        }
    return JSONResponse(status_code=exc.status_code, content={"error": error})


def normalize_longitude(lon: float) -> float:
    """Convert accepted 0..360 longitudes into the API's -180..180 range."""
    normalized = (lon + 180.0) % 360.0 - 180.0
    return 180.0 if normalized == -180.0 and lon > 0 else normalized


def lunar_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat1_rad, lat2_rad = math.radians(lat1), math.radians(lat2)
    delta_lat = lat2_rad - lat1_rad
    delta_lon = math.radians(lon2 - lon1)
    haversine = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    )
    central_angle = 2 * math.asin(math.sqrt(min(1.0, haversine)))
    return LUNAR_RADIUS_KM * central_angle


def public_site(site: dict) -> dict:
    return {
        **site,
        "coordsVerified": False,
        "precomputed": False,
    }


@app.get("/health")
@app.get(f"{API_PREFIX}/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get(f"{API_PREFIX}/sites")
async def list_sites(
    group: SiteGroup | None = None,
    region: Region | None = None,
    q: str | None = Query(default=None, max_length=100),
    featured: bool = False,
) -> dict:
    items = SITES
    if group:
        items = [site for site in items if site["group"] == group]
    if region:
        items = [site for site in items if site["region"] == region]
    if q:
        query = q.casefold()
        items = [
            site
            for site in items
            if query
            in " ".join(
                (site["name"], site["program"], site["group"], site["status"])
            ).casefold()
        ]
    if featured:
        items = [site for site in items if site["id"] in FEATURED_IDS]
    return {"items": [public_site(site) for site in items], "total": len(items)}


@app.get(f"{API_PREFIX}/sites/{{site_id}}")
async def get_site(site_id: str) -> dict:
    site = SITE_BY_ID.get(site_id)
    if site is None:
        raise HTTPException(status_code=404, detail="Unknown siteId.")
    terrain = await fetch_lunar_elevation(site["lat"], site["lon"])
    sources = [terrain["source"]]
    if terrain["inPermanentShadow"] is not None:
        sources.append("NASA GSFC PGDA LPSR PSR map")
    return {
        **public_site(site),
        "description": None,
        "elevationM": terrain["elevationM"],
        "slopeDeg": terrain["slopeDeg"],
        "demCoverage": terrain["demCoverage"],
        "demResolutionM": terrain["demResolutionM"],
        "inPermanentShadow": terrain["inPermanentShadow"],
        "demVersion": terrain["demVersion"],
        "sources": sources,
    }


@app.get(f"{API_PREFIX}/terrain/point")
async def get_terrain_point(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=360),
) -> dict:
    normalized_lon = normalize_longitude(lon)
    terrain = await fetch_lunar_elevation(lat, normalized_lon)
    nearest = min(
        SITES,
        key=lambda site: lunar_distance_km(
            lat, normalized_lon, site["lat"], site["lon"]
        ),
    )
    return {
        "lat": lat,
        "lon": normalized_lon,
        **terrain,
        "nearestSite": {
            "id": nearest["id"],
            "distanceKm": round(
                lunar_distance_km(lat, normalized_lon, nearest["lat"], nearest["lon"]),
                3,
            ),
        },
    }


@app.get(f"{API_PREFIX}/horizon")
async def get_horizon(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=360),
    height_m: float = Query(default=2, alias="heightM", ge=0),
    bin_deg: float = Query(default=0.5, alias="binDeg"),
) -> dict:
    if not math.isfinite(height_m):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "heightM must be a finite number.",
                "field": "heightM",
            },
        )
    if bin_deg not in {0.1, 0.5}:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "binDeg must be 0.1 or 0.5.",
                "field": "binDeg",
            },
        )
    if lat > -80:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OUT_OF_DEM_COVERAGE",
                "message": "Terrain-based results require latitude at or south of 80°S.",
                "field": "lat",
            },
        )
    return await fetch_horizon(
        lat,
        normalize_longitude(lon),
        height_m,
        bin_deg,
    )


@app.get(f"{API_PREFIX}/ephemeris")
async def get_ephemeris(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=360),
    start: datetime = Query(...),
    end: datetime = Query(...),
    step_min: int = Query(default=10, alias="stepMin", ge=1, le=1440),
    bodies: str = "sun,earth",
) -> dict:
    normalized_lon = normalize_longitude(lon)
    if start.tzinfo is None or start.utcoffset() is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "Timestamp must include a UTC offset.",
                "field": "start",
            },
        )
    if end.tzinfo is None or end.utcoffset() is None:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "Timestamp must include a UTC offset.",
                "field": "end",
            },
        )

    start_utc = start.astimezone(timezone.utc)
    end_utc = end.astimezone(timezone.utc)
    duration_seconds = (end_utc - start_utc).total_seconds()
    if duration_seconds <= 0:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "end must be later than start.",
                "field": "end",
            },
        )
    step_seconds = step_min * 60
    sample_count = duration_seconds / step_seconds + 1
    if duration_seconds % step_seconds != 0:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "The time range must be divisible by stepMin.",
                "field": "stepMin",
            },
        )
    if sample_count > 4320:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "The request exceeds the 4320-sample limit.",
                "field": "stepMin",
            },
        )

    requested_bodies = {body.strip().lower() for body in bodies.split(",") if body.strip()}
    if not requested_bodies or not requested_bodies <= {"sun", "earth"}:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "bodies must contain sun, earth, or both.",
                "field": "bodies",
            },
        )
    return await fetch_ephemeris(
        lat,
        normalized_lon,
        start_utc,
        end_utc,
        step_min,
        requested_bodies,
    )


@app.post(f"{API_PREFIX}/simulations", status_code=201)
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


@app.get(f"{API_PREFIX}/simulations/{{simulation_id}}")
async def get_simulation(simulation_id: str) -> dict:
    simulation = SIMULATIONS.get(simulation_id)
    if simulation is None:
        raise HTTPException(status_code=404, detail="Unknown simulationId.")
    return simulation


@app.get(f"{API_PREFIX}/meta/sources")
async def get_sources() -> dict:
    return {
        "ephemeris": {
            "name": "JPL Horizons API",
            "version": "response signature 1.2; API documentation 1.3",
            "model": "DE441 (reported by Horizons)",
            "url": "https://ssd.jpl.nasa.gov/api/horizons.api",
        },
        "terrain": {
            "name": "LRO LOLA DEM via NASA Moon Trek ImageServer",
            "southPoleNorthPoleResolutionM": 100,
            "globalResolutionPxPerDegree": 256,
            "note": "The available Moon Trek services are not the 5 m/px PGDA tiles described in the draft spec.",
            "url": "https://trek.nasa.gov/moon/",
        },
        "permanentShadow": {
            "name": "LOLA Permanently Shadowed Regions map",
            "resolutionM": 20,
            "coverage": "80-90 degrees south",
            "url": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF",
        },
    }
