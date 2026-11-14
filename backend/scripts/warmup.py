import argparse
import asyncio
import logging
from datetime import datetime, timezone

from app.horizon_source import fetch_horizon
from app.heightmap_source import fetch_lunar_heightmap
from app.simulation import SimulationRequest
from app.simulation_routes import create_simulation
from app.sites import SITE_BY_ID

DEFAULT_SITE_IDS = (
    "connecting-ridge",
    "shackleton-rim",
    "mons-mouton",
    "chandrayaan-3",
)
DEFAULT_LANDING_TIME = datetime(2027, 3, 14, 6, tzinfo=timezone.utc)
HEIGHTMAP_SIZE_KM = 20
HEIGHTMAP_RESOLUTION = 256

logger = logging.getLogger("warmup")


def _parse_landing_time(value: str) -> datetime:
    try:
        landing_time = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "landing time must be an ISO 8601 timestamp"
        ) from exc
    if landing_time.tzinfo is None or landing_time.utcoffset() is None:
        raise argparse.ArgumentTypeError(
            "landing time must include a UTC offset"
        )
    return landing_time


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Preload DEM, horizon and simulation caches for demo sites."
    )
    parser.add_argument(
        "--site",
        dest="site_ids",
        action="append",
        choices=sorted(SITE_BY_ID),
        help="site ID to warm; repeat to select multiple sites",
    )
    parser.add_argument(
        "--landing-time",
        type=_parse_landing_time,
        default=DEFAULT_LANDING_TIME,
        help=(
            "ISO 8601 timestamp with timezone; defaults to the frontend's "
            "initial selection"
        ),
    )
    return parser.parse_args()


async def _warm_site(site_id: str, landing_time: datetime) -> None:
    site = SITE_BY_ID[site_id]
    lat = site["lat"]
    lon = site["lon"]
    logger.info("Warming %s (%s)", site["name"], site_id)

    await fetch_lunar_heightmap(lat, lon, HEIGHTMAP_SIZE_KM, HEIGHTMAP_RESOLUTION)
    if lat <= -80:
        await fetch_horizon(lat, lon, 2.0, 0.5)

    request = SimulationRequest(
        site={"siteId": site_id},
        landingTime=landing_time,
        missionDays=14,
        windowDays=30,
        stepMin=10,
        horizonModel="real" if lat <= -80 else "flat",
        includeTimeseries=True,
    )
    result = await create_simulation(request)
    logger.info("Ready %s: %s", site["name"], result["id"])


async def _run(site_ids: list[str], landing_time: datetime) -> None:
    for site_id in site_ids:
        await _warm_site(site_id, landing_time)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    args = _parse_args()
    site_ids = args.site_ids or list(DEFAULT_SITE_IDS)
    asyncio.run(_run(site_ids, args.landing_time))


if __name__ == "__main__":
    main()
