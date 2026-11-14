import asyncio
import math
from typing import Any

import httpx
from fastapi import HTTPException

from app.sources import (
    MOON_TREK_BASE,
    MOON_RADIUS_M,
    _cache_get,
    _cache_set,
    _south_polar_stereographic_xy,
    _upstream_error,
)

HORIZON_CACHE_TTL = 24 * 60 * 60
HORIZON_DEM_EXPORT_URL = (
    f"{MOON_TREK_BASE}/LRO_LOLA_DEM_SPole45_100mp_v04/ImageServer/exportImage"
)
HORIZON_DEM_VERSION = "LRO_LOLA_DEM_SPole45_100mp_v04"
HORIZON_DEM_RESOLUTION_M = 100.0
HORIZON_MAX_DISTANCE_KM = 150.0
HORIZON_WINDOW_HALF_SIZE_M = 152_000.0
HORIZON_WINDOW_SIZE_PX = 3041
HORIZON_RAY_STEP_M = 100.0


class HorizonDataError(RuntimeError):
    pass


class HorizonOutOfCoverageError(RuntimeError):
    pass


def _horizon_profile_from_dem(
    dem: Any,
    *,
    left_m: float,
    top_m: float,
    pixel_width_m: float,
    pixel_height_m: float,
    nodata: float | None,
    center_x_m: float,
    center_y_m: float,
    lat: float,
    lon: float,
    height_m: float,
    bin_deg: float,
    max_distance_m: float = HORIZON_MAX_DISTANCE_KM * 1000,
) -> tuple[list[float], list[float]]:
    import numpy as np

    if pixel_width_m <= 0 or pixel_height_m <= 0:
        raise HorizonDataError("The DEM export has an invalid pixel size.")

    rows_count, cols_count = dem.shape
    center_col = math.floor((center_x_m - left_m) / pixel_width_m)
    center_row = math.floor((top_m - center_y_m) / pixel_height_m)
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
        rho = 2 * MOON_RADIUS_M * np.tan(math.pi / 4 + destination_lat / 2)
        projected_x = rho * np.sin(destination_lon)
        projected_y = rho * np.cos(destination_lon)

        col_indices = np.floor(
            (projected_x - left_m) / pixel_width_m
        ).astype(np.int32)
        row_indices = np.floor(
            (top_m - projected_y) / pixel_height_m
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
) -> tuple[list[float], list[float]]:
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError as exc:
        raise HorizonDataError(
            "NumPy and Rasterio are required to calculate the horizon."
        ) from exc

    center_x_m, center_y_m = _south_polar_stereographic_xy(lat, lon)
    try:
        with MemoryFile(raster_bytes) as memory_file:
            with memory_file.open() as dataset:
                transform = dataset.transform
                if not math.isclose(
                    transform.a,
                    -transform.e,
                    rel_tol=0,
                    abs_tol=1e-6,
                ):
                    raise HorizonDataError(
                        "The DEM export must use square pixels."
                    )
                return _horizon_profile_from_dem(
                    np.asarray(dataset.read(1)),
                    left_m=transform.c,
                    top_m=transform.f,
                    pixel_width_m=transform.a,
                    pixel_height_m=-transform.e,
                    nodata=dataset.nodata,
                    center_x_m=center_x_m,
                    center_y_m=center_y_m,
                    lat=lat,
                    lon=lon,
                    height_m=height_m,
                    bin_deg=bin_deg,
                )
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise HorizonDataError("The DEM export could not be decoded.") from exc


async def fetch_horizon(
    lat: float, lon: float, height_m: float, bin_deg: float
) -> dict[str, Any]:
    key = f"horizon:{lat:.5f}:{lon:.5f}:{height_m:.2f}:{bin_deg:.1f}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    center_x_m, center_y_m = _south_polar_stereographic_xy(lat, lon)
    half_size_m = HORIZON_WINDOW_HALF_SIZE_M
    params = {
        "bbox": (
            f"{center_x_m - half_size_m},{center_y_m - half_size_m},"
            f"{center_x_m + half_size_m},{center_y_m + half_size_m}"
        ),
        "size": f"{HORIZON_WINDOW_SIZE_PX},{HORIZON_WINDOW_SIZE_PX}",
        "format": "tiff",
        "pixelType": "F32",
        "f": "image",
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=15.0)
        ) as client:
            response = await client.get(HORIZON_DEM_EXPORT_URL, params=params)
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

    result = {
        "lat": lat,
        "lon": lon,
        "heightM": height_m,
        "binDeg": bin_deg,
        "maxDistanceKm": HORIZON_MAX_DISTANCE_KM,
        "azimuthDeg": azimuths,
        "elevationDeg": elevations,
        "features": [],
        "demVersion": HORIZON_DEM_VERSION,
        "demResolutionM": HORIZON_DEM_RESOLUTION_M,
    }
    _cache_set(key, result, HORIZON_CACHE_TTL)
    return result
