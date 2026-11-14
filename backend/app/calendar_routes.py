import asyncio
import logging
from datetime import datetime, time, timezone

from fastapi import APIRouter, HTTPException

from app.api_utils import API_PREFIX, normalize_longitude
from app.calendar import (
    CALENDAR_STEP_MIN,
    MAX_CALENDAR_DAYS,
    CalendarRequest,
    build_calendar_result,
)
from app.ephemeris_sampling import fetch_ephemeris_range as _fetch_calendar_ephemeris
from app.horizon_source import fetch_horizon
from app.sites import SITE_BY_ID

logger = logging.getLogger(__name__)
router = APIRouter(prefix=API_PREFIX)


@router.post("/calendar")
async def create_calendar(request: CalendarRequest) -> dict:
    if request.to_date < request.from_date:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "to must be on or after from.",
                "field": "to",
            },
        )
    date_count = (request.to_date - request.from_date).days + 1
    if date_count > MAX_CALENDAR_DAYS:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "VALIDATION_ERROR",
                "message": f"The calendar range cannot exceed {MAX_CALENDAR_DAYS} days.",
                "field": "to",
            },
        )

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

    landing_time_of_day = time.fromisoformat(request.landingTimeOfDay[:-1])
    start = datetime.combine(
        request.from_date,
        landing_time_of_day,
        tzinfo=timezone.utc,
    )
    total_samples = (
        (date_count - 1 + request.missionDays)
        * 1440
        // CALENDAR_STEP_MIN
    )
    if request.horizonModel == "real":
        observer_heights = list(
            dict.fromkeys(
                (
                    request.hardware.panelHeightM,
                    request.hardware.mastHeightM,
                )
            )
        )
        results = await asyncio.gather(
            _fetch_calendar_ephemeris(
                lat, lon, start, total_samples, CALENDAR_STEP_MIN
            ),
            *(
                fetch_horizon(lat, lon, height_m, 0.5)
                for height_m in observer_heights
            ),
        )
        ephemeris = results[0]
        horizon_by_height = dict(zip(observer_heights, results[1:]))
        sun_horizon = horizon_by_height[request.hardware.panelHeightM]
        earth_horizon = horizon_by_height[request.hardware.mastHeightM]
    else:
        ephemeris = await _fetch_calendar_ephemeris(
            lat, lon, start, total_samples, CALENDAR_STEP_MIN
        )
        sun_horizon = None
        earth_horizon = None

    try:
        return build_calendar_result(
            request=request,
            lat=lat,
            lon=lon,
            site_name=site_name,
            landing_time_of_day=landing_time_of_day,
            step_min=CALENDAR_STEP_MIN,
            ephemeris=ephemeris,
            sun_horizon=sun_horizon,
            earth_horizon=earth_horizon,
        )
    except (KeyError, TypeError, ValueError) as exc:
        logger.exception("Could not process upstream data for the calendar.")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": "The ephemeris or horizon data could not be processed for the calendar.",
                "field": None,
                "retryAfterS": 5,
            },
        ) from exc
