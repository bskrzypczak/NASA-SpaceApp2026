import math
from dataclasses import dataclass
from typing import Any

import httpx

from app.dem_window_cache import read_dem_window, write_dem_window
from app.sources import (
    MOON_RADIUS_M,
    _dem_service_for_latitude,
    _get_moon_trek_response,
    _north_polar_stereographic_xy,
    _south_polar_stereographic_xy,
    _upstream_error,
)

DEM_WINDOW_TILE_SIZE_M = 10_000
DEM_WINDOW_TILE_SIZE_DEG = math.degrees(
    DEM_WINDOW_TILE_SIZE_M / MOON_RADIUS_M
)
DEM_WINDOW_HALF_SIZE_M = 170_000
DEM_WINDOW_IMAGE_SIZE_PX = 3041
GLOBAL_DEM_PIXELS_PER_DEGREE = 256


@dataclass(frozen=True)
class DemWindow:
    key: str
    content: bytes
    center_x: float
    center_y: float
    half_size_m: float


def _projected_coordinates(
    lat: float, lon: float, projection: str
) -> tuple[float, float]:
    if projection == "south-polar":
        return _south_polar_stereographic_xy(lat, lon)
    if projection == "north-polar":
        return _north_polar_stereographic_xy(lat, lon)
    if projection == "geographic":
        return lon, lat
    raise ValueError(f"Unsupported DEM window projection: {projection}.")


def _window_key(service: dict[str, Any], tile_x: int, tile_y: int) -> str:
    return f"{service['version']}-{tile_x}-{tile_y}"


def _candidate_tiles(
    tile_x: int, tile_y: int, radius: int
) -> list[tuple[int, int]]:
    return sorted(
        (
            (tile_x + dx, tile_y + dy)
            for dx in range(-radius, radius + 1)
            for dy in range(-radius, radius + 1)
        ),
        key=lambda tile: (tile[0] - tile_x) ** 2 + (tile[1] - tile_y) ** 2,
    )


def _offset_from_window_center_m(
    lat: float,
    projected_x: float,
    projected_y: float,
    center_x: float,
    center_y: float,
    projection: str,
) -> float:
    if projection == "geographic":
        meters_per_degree = MOON_RADIUS_M * math.pi / 180
        east_m = (
            (projected_x - center_x)
            * math.cos(math.radians(lat))
            * meters_per_degree
        )
        north_m = (projected_y - center_y) * meters_per_degree
        return math.hypot(east_m, north_m)
    return math.hypot(projected_x - center_x, projected_y - center_y)


async def find_cached_dem_window(
    lat: float,
    lon: float,
    service: dict[str, Any] | None = None,
    *,
    required_margin_m: float = 0.0,
) -> DemWindow | None:
    selected_service = service or _dem_service_for_latitude(lat)
    projection = selected_service["projection"]
    projected_x, projected_y = _projected_coordinates(lat, lon, projection)
    tile_size = (
        DEM_WINDOW_TILE_SIZE_DEG
        if projection == "geographic"
        else DEM_WINDOW_TILE_SIZE_M
    )
    tile_x = math.floor(projected_x / tile_size)
    tile_y = math.floor(projected_y / tile_size)
    search_radius = 2 if projection == "geographic" else 1

    for candidate_x, candidate_y in _candidate_tiles(
        tile_x, tile_y, search_radius
    ):
        key = _window_key(selected_service, candidate_x, candidate_y)
        content = await read_dem_window(key)
        if content is None:
            continue
        center_x = (candidate_x + 0.5) * tile_size
        center_y = (candidate_y + 0.5) * tile_size
        offset_m = _offset_from_window_center_m(
            lat,
            projected_x,
            projected_y,
            center_x,
            center_y,
            projection,
        )
        if DEM_WINDOW_HALF_SIZE_M - offset_m < required_margin_m:
            continue
        return DemWindow(
            key=key,
            content=content,
            center_x=center_x,
            center_y=center_y,
            half_size_m=DEM_WINDOW_HALF_SIZE_M,
        )
    return None


async def fetch_dem_window(
    lat: float,
    lon: float,
    service: dict[str, Any] | None = None,
    *,
    required_margin_m: float = 150_000.0,
) -> DemWindow:
    selected_service = service or _dem_service_for_latitude(lat)
    projection = selected_service["projection"]
    cached = await find_cached_dem_window(
        lat,
        lon,
        selected_service,
        required_margin_m=required_margin_m,
    )
    if cached is not None:
        return cached

    projected_x, projected_y = _projected_coordinates(lat, lon, projection)
    tile_size = (
        DEM_WINDOW_TILE_SIZE_DEG
        if projection == "geographic"
        else DEM_WINDOW_TILE_SIZE_M
    )
    tile_x = math.floor(projected_x / tile_size)
    tile_y = math.floor(projected_y / tile_size)
    key = _window_key(selected_service, tile_x, tile_y)
    center_x = (tile_x + 0.5) * tile_size
    center_y = (tile_y + 0.5) * tile_size
    half_size = DEM_WINDOW_HALF_SIZE_M

    if projection == "geographic":
        latitude_radius = math.degrees(half_size / MOON_RADIUS_M)
        longitude_radius = latitude_radius / max(
            abs(math.cos(math.radians(center_y))), 1e-6
        )
        padding = 2 / GLOBAL_DEM_PIXELS_PER_DEGREE
        left = center_x - longitude_radius - padding
        right = center_x + longitude_radius + padding
        bottom = center_y - latitude_radius - padding
        top = center_y + latitude_radius + padding
        width = min(
            4096,
            math.ceil((right - left) * GLOBAL_DEM_PIXELS_PER_DEGREE),
        )
        height = min(
            4096,
            math.ceil((top - bottom) * GLOBAL_DEM_PIXELS_PER_DEGREE),
        )
        image_size = f"{width},{height}"
    else:
        left = center_x - half_size
        right = center_x + half_size
        bottom = center_y - half_size
        top = center_y + half_size
        image_size = f"{DEM_WINDOW_IMAGE_SIZE_PX},{DEM_WINDOW_IMAGE_SIZE_PX}"

    params = {
        "bbox": f"{left},{bottom},{right},{top}",
        "size": image_size,
        "format": "tiff",
        "pixelType": "F32",
        "f": "image",
    }
    export_url = selected_service["url"].rsplit("/", 1)[0] + "/exportImage"
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(90.0, connect=15.0)
    ) as client:
        response = await _get_moon_trek_response(client, export_url, params)

    if not response.content.startswith((b"II*\x00", b"MM\x00*")):
        raise _upstream_error("The lunar DEM service returned an invalid TIFF.")
    await write_dem_window(key, response.content)
    return DemWindow(
        key=key,
        content=response.content,
        center_x=center_x,
        center_y=center_y,
        half_size_m=half_size,
    )
