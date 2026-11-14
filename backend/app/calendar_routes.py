import asyncio
import logging
from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, HTTPException

from app.api_utils import API_PREFIX, normalize_longitude
from app.calendar import (
    CALENDAR_STEP_MIN,
    MAX_CALENDAR_DAYS,
    MAX_EPHEMERIS_SAMPLES,
    CalendarRequest,
    build_calendar_result,
)
from app.horizon_source import fetch_horizon
from app.sites import SITE_BY_ID
from app.sources import fetch_ephemeris

logger = logging.getLogger(__name__)
router = APIRouter(prefix=API_PREFIX)


async def _fetch_calendar_ephemeris(
    lat: float,
    lon: float,
    start: datetime,
    total_samples: int,
    step_min: int,
) -> dict[str, dict[str, list[float]]]:
    step = timedelta(minutes=step_min)
    chunks = []
    start_index = 0
    while start_index < total_samples:
        end_index = min(
            start_index + MAX_EPHEMERIS_SAMPLES - 1,
            total_samples - 1,
        )
        chunks.append((start_index, end_index))
        if end_index == total_samples - 1:
            break
        start_index = end_index

    responses = await asyncio.gather(
        *(
            fetch_ephemeris(
                lat,
                lon,
                start + step * start_index,
                start + step * end_index,
                step_min,
                {"sun", "earth"},
            )
            for start_index, end_index in chunks
        )
    )
    merged = {
        body: {"azDeg": [], "elDeg": []}
        for body in ("sun", "earth")
    }
    for chunk_index, ((start_index, end_index), response) in enumerate(
        zip(chunks, responses)
    ):
        expected_count = end_index - start_index + 1
        skip_first = 1 if chunk_index else 0
        for body in ("sun", "earth"):
            for field in ("azDeg", "elDeg"):
                try:
                    values = response[body][field]
                except (KeyError, TypeError) as exc:
                    logger.exception("JPL Horizons returned incomplete calendar data.")
                    raise HTTPException(
                        status_code=502,
                        detail={
                            "code": "UPSTREAM_ERROR",
                            "message": "JPL Horizons returned incomplete calendar data.",
                            "field": None,
                            "retryAfterS": 5,
                        },
                    ) from exc
                if len(values) != expected_count:
                    logger.error(
                        "JPL Horizons returned an unexpected calendar sample count "
                        "for %s.%s: expected %s, received %s.",
                        body,
                        field,
                        expected_count,
                        len(values),
                    )
                    raise HTTPException(
                        status_code=502,
                        detail={
                            "code": "UPSTREAM_ERROR",
                            "message": "JPL Horizons returned an unexpected calendar sample count.",
                            "field": None,
                            "retryAfterS": 5,
                        },
                    )
                merged[body][field].extend(values[skip_first:])
    if any(
        len(merged[body][field]) != total_samples
        for body in ("sun", "earth")
        for field in ("azDeg", "elDeg")
    ):
        logger.error(
            "JPL Horizons returned an incomplete calendar range: expected %s samples.",
            total_samples,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": "JPL Horizons returned an incomplete calendar range.",
                "field": None,
                "retryAfterS": 5,
            },
        )
    return merged


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

    if request.horizonModel == "real" and lat > -80:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OUT_OF_DEM_COVERAGE",
                "message": "Real terrain calendars require latitude at or south of 80°S.",
                "field": "site.lat",
            },
        )

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
