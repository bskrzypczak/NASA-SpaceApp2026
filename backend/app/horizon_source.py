import asyncio
import math
from typing import Any

import httpx
from fastapi import HTTPException

from app.sources import (
    MOON_RADIUS_KM,
    MOON_RADIUS_M,
    _cache_get,
    _cache_set,
    _dem_service_for_latitude,
    _north_polar_stereographic_xy,
    _south_polar_stereographic_xy,
    _upstream_error,
)

HORIZON_CACHE_TTL = 24 * 60 * 60
HORIZON_MAX_DISTANCE_KM = 150.0
HORIZON_WINDOW_HALF_SIZE_M = 152_000.0
HORIZON_WINDOW_SIZE_PX = 3041
HORIZON_RAY_STEP_M = 100.0
GLOBAL_DEM_PIXELS_PER_DEGREE = 256
GLOBAL_HORIZON_MAX_IMAGE_SIZE = 4096


class HorizonDataError(RuntimeError):
    pass


class HorizonOutOfCoverageError(RuntimeError):
    pass


def _horizon_profile_from_dem(
    dem: Any,
    *,
    left: float,
    top: float,
    pixel_width: float,
    pixel_height: float,
    nodata: float | None,
    center_x: float,
    center_y: float,
    lat: float,
    lon: float,
    height_m: float,
    bin_deg: float,
    projection: str = "south-polar",
    max_distance_m: float = HORIZON_MAX_DISTANCE_KM * 1000,
) -> tuple[list[float], list[float]]:
    import numpy as np

    if pixel_width <= 0 or pixel_height <= 0:
        raise HorizonDataError("The DEM export has an invalid pixel size.")

    rows_count, cols_count = dem.shape
    center_col = math.floor((center_x - left) / pixel_width)
    center_row = math.floor((top - center_y) / pixel_height)
    if not (0 <= center_row < rows_count and 0 <= center_col < cols_count):
        raise HorizonOutOfCoverageError("The location is outside the DEM export.")

    center_elevation = float(dem[center_row, center_col])
    if not math.isfinite(center_elevation) or (
        nodata is not None and math.isfinite(nodata) and center_elevation == nodata
    ):
        raise HorizonOutOfCoverageError("The location has no valid DEM elevation.")

    azimuth_count = round(360 / bin_deg)
    azimuths = np.arange(azimuth_count, dtype=np.float64) * bin_deg
    distances = np.arange(
        HORIZON_RAY_STEP_M,
        max_distance_m + HORIZON_RAY_STEP_M,
        HORIZON_RAY_STEP_M,
        dtype=np.float64,
    )
    distance_angles = distances[None, :] / MOON_RADIUS_M
    sin_distance = np.sin(distance_angles)
    cos_distance = np.cos(distance_angles)

    latitude = math.radians(lat)
    longitude = math.radians(lon)
    sin_latitude = math.sin(latitude)
    cos_latitude = math.cos(latitude)
    sin_longitude = math.sin(longitude)
    cos_longitude = math.cos(longitude)

    position_x = cos_latitude * cos_longitude
    position_y = cos_latitude * sin_longitude
    position_z = sin_latitude
    north_x = -sin_latitude * cos_longitude
    north_y = -sin_latitude * sin_longitude
    north_z = cos_latitude
    east_x = -sin_longitude
    east_y = cos_longitude

    horizon_elevations: list[float] = []
    observer_elevation = center_elevation + height_m
    for offset in range(0, azimuth_count, 64):
        bearing = np.radians(azimuths[offset : offset + 64])[:, None]
        cos_bearing = np.cos(bearing)
        sin_bearing = np.sin(bearing)
        direction_x = cos_bearing * north_x + sin_bearing * east_x
        direction_y = cos_bearing * north_y + sin_bearing * east_y
        direction_z = cos_bearing * north_z

        destination_x = (
            position_x * cos_distance + direction_x * sin_distance
        )
        destination_y = (
            position_y * cos_distance + direction_y * sin_distance
        )
        destination_z = (
            position_z * cos_distance + direction_z * sin_distance
        )
        destination_lat = np.arcsin(np.clip(destination_z, -1.0, 1.0))
        destination_lon = np.arctan2(destination_y, destination_x)
        if projection == "south-polar":
            rho = 2 * MOON_RADIUS_M * np.tan(
                math.pi / 4 + destination_lat / 2
            )
            projected_x = rho * np.sin(destination_lon)
            projected_y = rho * np.cos(destination_lon)
        elif projection == "north-polar":
            rho = 2 * MOON_RADIUS_M * np.tan(
                math.pi / 4 - destination_lat / 2
            )
            projected_x = rho * np.sin(destination_lon)
            projected_y = -rho * np.cos(destination_lon)
        elif projection == "geographic":
            destination_lon_deg = np.degrees(destination_lon)
            projected_x = lon + (destination_lon_deg - lon + 180) % 360 - 180
            projected_y = np.degrees(destination_lat)
        else:
            raise HorizonDataError(f"Unsupported DEM projection: {projection}.")

        col_indices = np.floor(
            (projected_x - left) / pixel_width
        ).astype(np.int32)
        row_indices = np.floor(
            (top - projected_y) / pixel_height
        ).astype(np.int32)
        in_bounds = (
            (row_indices >= 0)
            & (row_indices < rows_count)
            & (col_indices >= 0)
            & (col_indices < cols_count)
        )
        safe_rows = np.clip(row_indices, 0, rows_count - 1)
        safe_cols = np.clip(col_indices, 0, cols_count - 1)
        elevations = dem[safe_rows, safe_cols]
        valid = in_bounds & np.isfinite(elevations)
        if nodata is not None and math.isfinite(nodata):
            valid &= elevations != nodata
        if not np.all(np.any(valid, axis=1)):
            raise HorizonOutOfCoverageError(
                "The DEM does not cover the full horizon radius."
            )

        angles = np.full(elevations.shape, -np.inf, dtype=np.float64)
        corrected_height = (
            elevations
            - observer_elevation
            - distances[None, :] ** 2 / (2 * MOON_RADIUS_M)
        )
        distance_grid = np.broadcast_to(distances, elevations.shape)
        angles[valid] = np.degrees(
            np.arctan(corrected_height[valid] / distance_grid[valid])
        )
        horizon_elevations.extend(
            float(value) for value in np.max(angles, axis=1)
        )

    return (
        [round(float(value), 3) for value in azimuths],
        [round(value, 3) for value in horizon_elevations],
    )


def _horizon_profile_from_tiff(
    raster_bytes: bytes,
    lat: float,
    lon: float,
    height_m: float,
    bin_deg: float,
    projection: str,
) -> tuple[list[float], list[float]]:
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError as exc:
        raise HorizonDataError(
            "NumPy and Rasterio are required to calculate the horizon."
        ) from exc

    if projection == "south-polar":
        center_x, center_y = _south_polar_stereographic_xy(lat, lon)
    elif projection == "north-polar":
        center_x, center_y = _north_polar_stereographic_xy(lat, lon)
    elif projection == "geographic":
        center_x, center_y = lon, lat
    else:
        raise HorizonDataError(f"Unsupported DEM projection: {projection}.")
    try:
        with MemoryFile(raster_bytes) as memory_file:
            with memory_file.open() as dataset:
                transform = dataset.transform
                return _horizon_profile_from_dem(
                    np.asarray(dataset.read(1)),
                    left=transform.c,
                    top=transform.f,
                    pixel_width=transform.a,
                    pixel_height=-transform.e,
                    nodata=dataset.nodata,
                    center_x=center_x,
                    center_y=center_y,
                    lat=lat,
                    lon=lon,
                    height_m=height_m,
                    bin_deg=bin_deg,
                    projection=projection,
                )
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise HorizonDataError("The DEM export could not be decoded.") from exc


def _horizon_export_params(
    lat: float, lon: float, service: dict[str, Any]
) -> dict[str, str]:
    projection = service["projection"]
    if projection == "geographic":
        latitude_radius_deg = math.degrees(
            HORIZON_MAX_DISTANCE_KM * 1000 / MOON_RADIUS_M
        )
        longitude_radius_deg = latitude_radius_deg / max(
            abs(math.cos(math.radians(lat))), 1e-6
        )
        padding_deg = 2 / GLOBAL_DEM_PIXELS_PER_DEGREE
        left = lon - longitude_radius_deg - padding_deg
        right = lon + longitude_radius_deg + padding_deg
        bottom = lat - latitude_radius_deg - padding_deg
        top = lat + latitude_radius_deg + padding_deg
        width = min(
            GLOBAL_HORIZON_MAX_IMAGE_SIZE,
            math.ceil((right - left) * GLOBAL_DEM_PIXELS_PER_DEGREE),
        )
        height = min(
            GLOBAL_HORIZON_MAX_IMAGE_SIZE,
            math.ceil((top - bottom) * GLOBAL_DEM_PIXELS_PER_DEGREE),
        )
    else:
        if projection == "south-polar":
            center_x, center_y = _south_polar_stereographic_xy(lat, lon)
        elif projection == "north-polar":
            center_x, center_y = _north_polar_stereographic_xy(lat, lon)
        else:
            raise HorizonDataError(f"Unsupported DEM projection: {projection}.")
        half_size = HORIZON_WINDOW_HALF_SIZE_M
        left = center_x - half_size
        right = center_x + half_size
        bottom = center_y - half_size
        top = center_y + half_size
        width = height = HORIZON_WINDOW_SIZE_PX

    return {
        "bbox": f"{left},{bottom},{right},{top}",
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": "F32",
        "f": "image",
    }


async def fetch_horizon(
    lat: float, lon: float, height_m: float, bin_deg: float
) -> dict[str, Any]:
    service = _dem_service_for_latitude(lat)
    key = (
        f"horizon:{service['version']}:{lat:.5f}:{lon:.5f}:"
        f"{height_m:.2f}:{bin_deg:.1f}"
    )
    cached = _cache_get(key)
    if cached is not None:
        return cached

    params = _horizon_export_params(lat, lon, service)
    export_url = service["url"].rsplit("/", 1)[0] + "/exportImage"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=15.0)
        ) as client:
            response = await client.get(export_url, params=params)
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise _upstream_error(
            "The lunar DEM export timed out.", 504, cause=exc
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise _upstream_error(
            f"The lunar DEM service returned HTTP {exc.response.status_code}.",
            cause=exc,
        ) from exc
    except httpx.RequestError as exc:
        raise _upstream_error(
            "The lunar DEM service could not be reached.", cause=exc
        ) from exc

    if not response.content.startswith((b"II*\x00", b"MM\x00*")):
        raise _upstream_error("The lunar DEM service returned an invalid TIFF.")
    try:
        azimuths, elevations = await asyncio.to_thread(
            _horizon_profile_from_tiff,
            response.content,
            lat,
            lon,
            height_m,
            bin_deg,
            service["projection"],
        )
    except HorizonOutOfCoverageError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OUT_OF_DEM_COVERAGE",
                "message": str(exc),
                "field": "lat",
            },
        ) from exc
    except HorizonDataError as exc:
        raise _upstream_error(
            "The lunar DEM could not be processed.", cause=exc
        ) from exc

    resolution_m = service["resolutionM"]
    if resolution_m is None:
        resolution_m = (
            2 * math.pi * MOON_RADIUS_KM * 1000 / 360
            / GLOBAL_DEM_PIXELS_PER_DEGREE
        )
    result = {
        "lat": lat,
        "lon": lon,
        "heightM": height_m,
        "binDeg": bin_deg,
        "maxDistanceKm": HORIZON_MAX_DISTANCE_KM,
        "azimuthDeg": azimuths,
        "elevationDeg": elevations,
        "features": [],
        "demVersion": service["version"],
        "demResolutionM": round(resolution_m, 1),
    }
    _cache_set(key, result, HORIZON_CACHE_TTL)
    return result
