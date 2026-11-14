import io
import math
import os
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from app.api_utils import API_PREFIX, normalize_longitude
from app.calendar_routes import router as calendar_router
from app.heightmap_source import fetch_lunar_heightmap
from app.horizon_source import fetch_horizon
from app.layer_grid_source import (
    LayerGridDataError,
    build_slope_grid,
    fetch_psr_grid,
)
from app.nearby_routes import router as nearby_router
from app.simulation_routes import router as simulation_router
from app.sites import FEATURED_IDS, SITE_BY_ID, SITES
from app.sources import fetch_ephemeris, fetch_lunar_elevation
from app.visibility_grid_source import fetch_visibility_grid

LUNAR_RADIUS_KM = 1737.4
SiteGroup = Literal["Artemis III", "CLPS", "Commercial", "Other nations", "Apollo"]
Region = Literal["South pole", "Near side", "Far side"]
LAYER_CATALOG = [
    {
        "id": "illumination",
        "name": "Sunlight (avg.)",
        "source": "PGDA",
        "tileUrl": None,
    },
    {
        "id": "earth-visibility",
        "name": "Earth visibility",
        "source": "PGDA",
        "tileUrl": None,
    },
    {
        "id": "psr",
        "name": "Permanent shadow",
        "source": "PGDA",
        "tileUrl": None,
    },
    {
        "id": "slope",
        "name": "Slope > 10°",
        "source": "LOLA",
        "tileUrl": None,
    },
]

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
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    errors = exc.errors()
    first_error = errors[0] if errors else {}
    location = first_error.get("loc", ())
    field = str(location[-1]) if location else None
    message = first_error.get("msg", "Invalid request.")
    status_code = (
        422
        if request.url.path.startswith(f"{API_PREFIX}/layers/")
        and request.url.path.endswith("/grid")
        else 400
    )
    return JSONResponse(
        status_code=status_code,
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


def _heightmap_png16(heightmap: dict) -> bytes:
    import numpy as np
    from PIL import Image

    heights = np.asarray(heightmap["heightsM"], dtype=np.float64)
    minimum = float(np.min(heights))
    maximum = float(np.max(heights))
    if maximum > minimum:
        pixels = np.rint((heights - minimum) * (65535 / (maximum - minimum)))
    else:
        pixels = np.zeros(heights.shape, dtype=np.float64)
    buffer = io.BytesIO()
    Image.fromarray(np.clip(pixels, 0, 65535).astype(np.uint16)).save(
        buffer, format="PNG"
    )
    return buffer.getvalue()


@app.get(f"{API_PREFIX}/terrain/heightmap", response_model=None)
async def get_terrain_heightmap(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=360),
    size_km: float = Query(default=20, alias="sizeKm"),
    res: int = Query(default=256, ge=16, le=512),
    response_format: Literal["json", "png16"] = Query(
        default="json", alias="format"
    ),
) -> dict | Response:
    if size_km not in {5, 10, 20, 40}:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "sizeKm must be 5, 10, 20, or 40.",
                "field": "sizeKm",
            },
        )
    normalized_lon = normalize_longitude(lon)
    heightmap = await fetch_lunar_heightmap(lat, normalized_lon, size_km, res)
    if response_format == "json":
        return heightmap
    return Response(
        content=_heightmap_png16(heightmap),
        media_type="image/png",
        headers={
            "X-Min-Elevation-M": str(heightmap["minElevationM"]),
            "X-Max-Elevation-M": str(heightmap["maxElevationM"]),
            "X-Origin-Elevation-M": str(heightmap["originElevationM"]),
            "X-Dem-Version": heightmap["demVersion"],
        },
    )


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










app.include_router(simulation_router)
app.include_router(calendar_router)
app.include_router(nearby_router)


@app.get(f"{API_PREFIX}/layers")
async def get_layers() -> dict:
    return {"layers": LAYER_CATALOG}


@app.get(f"{API_PREFIX}/layers/{{layer_id}}/grid")
async def get_layer_grid(
    layer_id: str,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=360),
    size_km: float = Query(default=20, alias="sizeKm"),
    res: int = Query(default=256),
) -> dict:
    layer_ids = {layer["id"] for layer in LAYER_CATALOG}
    if layer_id not in layer_ids:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "LAYER_NOT_FOUND",
                "message": "Unknown layer id.",
                "field": "id",
            },
        )
    if layer_id not in {
        "slope",
        "psr",
        "illumination",
        "earth-visibility",
    }:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "LAYER_GRID_UNAVAILABLE",
                "message": "This layer does not have a grid yet.",
                "field": "id",
            },
        )
    if not math.isfinite(size_km) or size_km not in {5, 10, 20, 40}:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "sizeKm must be 5, 10, 20, or 40.",
                "field": "sizeKm",
            },
        )
    if not 16 <= res <= 512:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "res must be between 16 and 512.",
                "field": "res",
            },
        )

    normalized_lon = normalize_longitude(lon)
    if layer_id in {"illumination", "earth-visibility"}:
        return await fetch_visibility_grid(
            layer_id,
            lat,
            normalized_lon,
            size_km,
            res,
        )
    if layer_id == "slope":
        heightmap = await fetch_lunar_heightmap(
            lat,
            normalized_lon,
            size_km,
            res,
        )
        try:
            return build_slope_grid(heightmap)
        except LayerGridDataError as exc:
            raise HTTPException(
                status_code=502,
                detail={
                    "code": "UPSTREAM_ERROR",
                    "message": "The LOLA DEM grid could not be processed.",
                    "field": None,
                },
            ) from exc
    return await fetch_psr_grid(lat, normalized_lon, size_km, res)


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
        "lunarPolarVisibility": {
            "name": "LOLA Lunar Polar Illumination",
            "source": "NASA GSFC PGDA",
            "averagingPeriodYears": 18.6,
            "coverage": "65-90 degrees north and south",
            "resolutionM": [120, 240],
            "url": "https://pgda.gsfc.nasa.gov/products/69",
        },
    }
