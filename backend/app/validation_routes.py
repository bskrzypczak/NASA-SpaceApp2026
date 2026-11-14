import asyncio
import logging
import math
from datetime import date, datetime, time, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.api_utils import API_PREFIX, normalize_longitude
from app.ephemeris_sampling import fetch_ephemeris_range
from app.horizon_source import fetch_horizon
from app.persistent_cache import get as get_persisted_cache
from app.persistent_cache import set as set_persisted_cache
from app.simulation import (
    EARTH_ANGULAR_RADIUS_DEG,
    interpolate_horizon,
    sun_visible_fraction,
)
from app.visibility_grid_source import fetch_visibility_point

logger = logging.getLogger(__name__)
router = APIRouter(prefix=API_PREFIX)

DEFAULT_VALIDATION_START = date(2027, 1, 1)
VALIDATION_STEP_MIN = 60
VALIDATION_HEIGHT_M = 0.0
VALIDATION_TOLERANCE_PTS = 5.0
VALIDATION_CACHE_TTL = 24 * 60 * 60
LROC_WAC_NOTE = "no full-coverage WAC illumination raster available"


def _period_end(period_start: date) -> date:
    if period_start.year >= 9999:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "start must leave room for a full calendar year.",
                "field": "start",
            },
        )
    try:
        return period_start.replace(year=period_start.year + 1)
    except ValueError:
        return date(period_start.year + 1, 3, 1)


def _ephemeris_series(
    ephemeris: dict[str, Any],
    body: str,
    field: str,
    expected_count: int,
) -> list[float]:
    try:
        values = [float(value) for value in ephemeris[body][field]]
    except (KeyError, TypeError, ValueError) as exc:
        logger.exception("JPL Horizons returned invalid validation ephemeris data.")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": "JPL Horizons returned invalid validation ephemeris data.",
                "field": None,
                "retryAfterS": 5,
            },
        ) from exc
    if len(values) != expected_count or not all(
        math.isfinite(value) for value in values
    ):
        logger.error(
            "JPL Horizons returned invalid %s.%s validation samples: "
            "expected %s finite values, received %s.",
            body,
            field,
            expected_count,
            len(values),
        )
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": "JPL Horizons returned an incomplete validation ephemeris.",
                "field": None,
                "retryAfterS": 5,
            },
        )
    return values


def _mean_percent(values: list[float]) -> float:
    return round(math.fsum(values) * 100 / len(values), 2)


@router.get("/validation")
async def get_validation(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=360),
    period_start: date = Query(
        default=DEFAULT_VALIDATION_START,
        alias="start",
    ),
) -> dict[str, Any]:
    if abs(lat) < 65:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OUT_OF_PGDA_COVERAGE",
                "message": (
                    "PGDA lunar polar illumination products cover latitudes "
                    "65–90 degrees north and south."
                ),
                "field": "lat",
            },
        )
    normalized_lon = normalize_longitude(lon)
    start = datetime.combine(period_start, time.min, tzinfo=timezone.utc)
    period_end = _period_end(period_start)
    period_days = (period_end - period_start).days
    sample_count = period_days * 24 + 1
    cache_key = (
        f"validation:v2:{lat:.5f}:{normalized_lon:.5f}:"
        f"{period_start.isoformat()}:{period_days}:"
        f"{VALIDATION_STEP_MIN}:{VALIDATION_HEIGHT_M:g}"
    )
    cached = get_persisted_cache(cache_key)
    if cached is not None:
        return cached[0]

    ephemeris, horizon, pgda_illumination, pgda_earth = await asyncio.gather(
        fetch_ephemeris_range(
            lat,
            normalized_lon,
            start,
            sample_count,
            VALIDATION_STEP_MIN,
        ),
        fetch_horizon(lat, normalized_lon, VALIDATION_HEIGHT_M, 0.5),
        fetch_visibility_point("illumination", lat, normalized_lon),
        fetch_visibility_point("earth-visibility", lat, normalized_lon),
    )
    sun_azimuths = _ephemeris_series(ephemeris, "sun", "azDeg", sample_count)
    sun_elevations = _ephemeris_series(ephemeris, "sun", "elDeg", sample_count)
    earth_azimuths = _ephemeris_series(ephemeris, "earth", "azDeg", sample_count)
    earth_elevations = _ephemeris_series(ephemeris, "earth", "elDeg", sample_count)
    try:
        sun_fractions = [
            sun_visible_fraction(
                elevation - interpolate_horizon(horizon, azimuth)
            )
            for azimuth, elevation in zip(sun_azimuths, sun_elevations)
        ]
        earth_visible = [
            float(
                elevation
                - interpolate_horizon(horizon, azimuth)
                + EARTH_ANGULAR_RADIUS_DEG
                > 0
            )
            for azimuth, elevation in zip(earth_azimuths, earth_elevations)
        ]
    except (TypeError, ValueError) as exc:
        logger.exception("Could not calculate horizon-based validation metrics.")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": "The horizon profile could not be used for validation.",
                "field": None,
                "retryAfterS": 5,
            },
        ) from exc

    horizon_illumination_pct = _mean_percent(sun_fractions)
    horizon_earth_pct = _mean_percent(earth_visible)
    pgda_illumination_pct = pgda_illumination["valuePct"]
    pgda_earth_pct = pgda_earth["valuePct"]
    comparison_deltas = [
        abs(horizon_illumination_pct - pgda_illumination_pct)
        if pgda_illumination_pct is not None
        else None,
        abs(horizon_earth_pct - pgda_earth_pct)
        if pgda_earth_pct is not None
        else None,
    ]
    available_deltas = [
        delta for delta in comparison_deltas if delta is not None
    ]
    delta_max_pts = (
        round(max(available_deltas), 2)
        if len(available_deltas) == len(comparison_deltas)
        else None
    )
    result = {
        "avgIlluminationPct": {
            "horizon": horizon_illumination_pct,
            "pgda": pgda_illumination_pct,
            "lrocWac": None,
        },
        "earthVisibilityPct": {
            "horizon": horizon_earth_pct,
            "pgda": pgda_earth_pct,
        },
        "deltaMaxPts": delta_max_pts,
        "withinTolerance": (
            delta_max_pts <= VALIDATION_TOLERANCE_PTS
            if delta_max_pts is not None
            else None
        ),
        "tolerancePts": VALIDATION_TOLERANCE_PTS,
        "periodStart": period_start.isoformat(),
        "periodEnd": period_end.isoformat(),
        "periodDays": period_days,
        "samplingStepHours": VALIDATION_STEP_MIN / 60,
        "heightM": VALIDATION_HEIGHT_M,
        "lrocWacNote": LROC_WAC_NOTE,
        "horizonDemVersion": horizon["demVersion"],
        "horizonDemResolutionM": horizon["demResolutionM"],
        "pgdaVersion": {
            "illumination": pgda_illumination["version"],
            "earthVisibility": pgda_earth["version"],
        },
    }
    set_persisted_cache(cache_key, result, VALIDATION_CACHE_TTL)
    return result
