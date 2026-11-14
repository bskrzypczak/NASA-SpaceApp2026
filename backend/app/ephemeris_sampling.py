import asyncio
import logging
from datetime import datetime, timedelta

from fastapi import HTTPException

from app.calendar import MAX_EPHEMERIS_SAMPLES
from app.sources import fetch_ephemeris

logger = logging.getLogger(__name__)


async def fetch_ephemeris_range(
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
                    logger.exception("JPL Horizons returned incomplete ephemeris data.")
                    raise HTTPException(
                        status_code=502,
                        detail={
                            "code": "UPSTREAM_ERROR",
                            "message": "JPL Horizons returned incomplete ephemeris data.",
                            "field": None,
                            "retryAfterS": 5,
                        },
                    ) from exc
                if len(values) != expected_count:
                    logger.error(
                        "JPL Horizons returned an unexpected sample count for "
                        "%s.%s: expected %s, received %s.",
                        body,
                        field,
                        expected_count,
                        len(values),
                    )
                    raise HTTPException(
                        status_code=502,
                        detail={
                            "code": "UPSTREAM_ERROR",
                            "message": "JPL Horizons returned an unexpected ephemeris sample count.",
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
            "JPL Horizons returned an incomplete ephemeris range: expected %s samples.",
            total_samples,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": "JPL Horizons returned an incomplete ephemeris range.",
                "field": None,
                "retryAfterS": 5,
            },
        )
    return merged
