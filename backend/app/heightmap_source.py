import asyncio
import math
from typing import Any

import httpx
from fastapi import HTTPException

from app.sources import (
    MOON_RADIUS_KM,
    MOON_RADIUS_M,
    _cache,
    _cache_get,
    _cache_set,
    _dem_service_for_latitude,
    _upstream_error,
)

HEIGHTMAP_CACHE_TTL = 24 * 60 * 60
HEIGHTMAP_CACHE_MAX_ENTRIES = 4
MAX_ABS_LUNAR_ELEVATION_M = 20_000.0


class HeightmapDataError(RuntimeError):
    pass


class HeightmapOutOfCoverageError(RuntimeError):
    pass


def _heightmap_xy(
    latitudes: Any, longitudes: Any, projection: str
) -> tuple[Any, Any]:
    import numpy as np

    latitudes_rad = np.radians(latitudes)
    longitudes_rad = np.radians(longitudes)
    if projection == "south-polar":
        rho = 2 * MOON_RADIUS_M * np.tan(math.pi / 4 + latitudes_rad / 2)
        return rho * np.sin(longitudes_rad), rho * np.cos(longitudes_rad)
    if projection == "north-polar":
        rho = 2 * MOON_RADIUS_M * np.tan(math.pi / 4 - latitudes_rad / 2)
        return rho * np.sin(longitudes_rad), -rho * np.cos(longitudes_rad)
    return longitudes, latitudes


def _heightmap_projected_grid(
    lat: float,
    lon: float,
    size_km: float,
    res: int,
    projection: str,
) -> tuple[Any, Any]:
    import numpy as np

    cell_size_m = size_km * 1000 / res
    east_offsets = (np.arange(res, dtype=np.float64) - res // 2) * cell_size_m
    north_offsets = (res // 2 - np.arange(res, dtype=np.float64)) * cell_size_m
    east, north = np.meshgrid(east_offsets, north_offsets)
    distances = np.hypot(east, north)
    bearings = np.arctan2(east, north)
    angular_distances = distances / MOON_RADIUS_M
    latitude = math.radians(lat)
    sin_latitude = math.sin(latitude)
    cos_latitude = math.cos(latitude)
    destination_latitudes = np.arcsin(
        np.clip(
            sin_latitude * np.cos(angular_distances)
            + cos_latitude * np.sin(angular_distances) * np.cos(bearings),
            -1.0,
            1.0,
        )
    )
    destination_longitudes = math.radians(lon) + np.arctan2(
        np.sin(bearings)
        * np.sin(angular_distances)
        * cos_latitude,
        np.cos(angular_distances)
        - sin_latitude * np.sin(destination_latitudes),
    )
    projected_x, projected_y = _heightmap_xy(
        np.degrees(destination_latitudes),
        np.degrees(destination_longitudes),
        projection,
    )
    if projection == "geographic":
        projected_x = lon + (projected_x - lon + 180) % 360 - 180
    return projected_x, projected_y


def _heightmap_from_dem(
    dem: Any,
    *,
    transform: Any,
    nodata: float | None,
    lat: float,
    lon: float,
    size_km: float,
    res: int,
    projection: str,
    dem_version: str,
    dem_resolution_m: float,
) -> dict[str, Any]:
    import numpy as np

    pixel_width = transform.a
    pixel_height = -transform.e
    if pixel_width <= 0 or pixel_height <= 0:
        raise HeightmapDataError("The DEM export has an invalid pixel size.")

    projected_x, projected_y = _heightmap_projected_grid(
        lat, lon, size_km, res, projection
    )

    cols = (projected_x - transform.c) / pixel_width - 0.5
    rows = (projected_y - transform.f) / transform.e - 0.5
    col0 = np.floor(cols).astype(np.int64)
    row0 = np.floor(rows).astype(np.int64)
    col1 = col0 + 1
    row1 = row0 + 1
    if (
        np.any(row0 < 0)
        or np.any(col0 < 0)
        or np.any(row1 >= dem.shape[0])
        or np.any(col1 >= dem.shape[1])
    ):
        raise HeightmapOutOfCoverageError("The DEM does not cover the requested area.")

    col_fraction = cols - col0
    row_fraction = rows - row0
    neighbors = (
        (dem[row0, col0], (1 - row_fraction) * (1 - col_fraction)),
        (dem[row0, col1], (1 - row_fraction) * col_fraction),
        (dem[row1, col0], row_fraction * (1 - col_fraction)),
        (dem[row1, col1], row_fraction * col_fraction),
    )
    elevation = np.zeros((res, res), dtype=np.float64)
    for values, weights in neighbors:
        valid = np.isfinite(values) & (np.abs(values) <= MAX_ABS_LUNAR_ELEVATION_M)
        if nodata is not None and math.isfinite(nodata):
            valid &= values != nodata
        if np.any((weights > 1e-12) & ~valid):
            raise HeightmapOutOfCoverageError(
                "The DEM does not cover the requested area."
            )
        elevation += np.where(valid, values, 0) * weights

    origin_x, origin_y = _heightmap_xy(
        np.asarray([lat]), np.asarray([lon]), projection
    )
    origin_col = (origin_x[0] - transform.c) / pixel_width - 0.5
    origin_row = (origin_y[0] - transform.f) / transform.e - 0.5
    origin_col0 = math.floor(origin_col)
    origin_row0 = math.floor(origin_row)
    origin_col1 = origin_col0 + 1
    origin_row1 = origin_row0 + 1
    if (
        origin_row0 < 0
        or origin_col0 < 0
        or origin_row1 >= dem.shape[0]
        or origin_col1 >= dem.shape[1]
    ):
        raise HeightmapOutOfCoverageError("The DEM does not cover the landing point.")

    origin_col_fraction = origin_col - origin_col0
    origin_row_fraction = origin_row - origin_row0
    origin_neighbors = (
        (
            float(dem[origin_row0, origin_col0]),
            (1 - origin_row_fraction) * (1 - origin_col_fraction),
        ),
        (
            float(dem[origin_row0, origin_col1]),
            (1 - origin_row_fraction) * origin_col_fraction,
        ),
        (
            float(dem[origin_row1, origin_col0]),
            origin_row_fraction * (1 - origin_col_fraction),
        ),
        (
            float(dem[origin_row1, origin_col1]),
            origin_row_fraction * origin_col_fraction,
        ),
    )
    origin_elevation = 0.0
    for value, weight in origin_neighbors:
        if weight <= 1e-12:
            continue
        if (
            not math.isfinite(value)
            or abs(value) > MAX_ABS_LUNAR_ELEVATION_M
            or (
                nodata is not None and math.isfinite(nodata) and value == nodata
            )
        ):
            raise HeightmapOutOfCoverageError(
                "The DEM has no valid elevation at the landing point."
            )
        origin_elevation += value * weight

    relative_elevation = elevation - origin_elevation
    rounded_elevation = np.round(relative_elevation, 2)
    heights = rounded_elevation.tolist()
    return {
        "lat": lat,
        "lon": lon,
        "sizeKm": size_km,
        "res": res,
        "originElevationM": round(origin_elevation, 2),
        "minElevationM": round(float(np.min(rounded_elevation)), 2),
        "maxElevationM": round(float(np.max(rounded_elevation)), 2),
        "heightsM": heights,
        "northUp": True,
        "demVersion": dem_version,
        "demResolutionM": round(dem_resolution_m, 1),
    }


def _heightmap_from_tiff(
    raster_bytes: bytes,
    lat: float,
    lon: float,
    size_km: float,
    res: int,
    service: dict[str, Any],
) -> dict[str, Any]:
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError as exc:
        raise HeightmapDataError(
            "NumPy and Rasterio are required to calculate a heightmap."
        ) from exc

    try:
        with MemoryFile(raster_bytes) as memory_file:
            with memory_file.open() as dataset:
                return _heightmap_from_dem(
                    np.asarray(dataset.read(1)),
                    transform=dataset.transform,
                    nodata=dataset.nodata,
                    lat=lat,
                    lon=lon,
                    size_km=size_km,
                    res=res,
                    projection=service["projection"],
                    dem_version=service["version"],
                    dem_resolution_m=service["resolutionM"]
                    or 2 * math.pi * MOON_RADIUS_KM * 1000 / 360 / 256,
                )
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise HeightmapDataError("The DEM export could not be decoded.") from exc


def _heightmap_export_params(
    lat: float,
    lon: float,
    size_km: float,
    res: int,
    service: dict[str, Any],
) -> dict[str, str]:
    import numpy as np

    projection = service["projection"]
    cell_size_m = size_km * 1000 / res
    projected_x, projected_y = _heightmap_projected_grid(
        lat, lon, size_km, res, projection
    )

    resolution_m = service["resolutionM"]
    if resolution_m is None:
        resolution_m = 2 * math.pi * MOON_RADIUS_KM * 1000 / 360 / 256
        meters_per_degree = 2 * math.pi * MOON_RADIUS_KM * 1000 / 360
        padding_x = 2 * resolution_m / (
            meters_per_degree * max(math.cos(math.radians(lat)), 1e-6)
        )
        padding_y = 2 * resolution_m / meters_per_degree
        native_pixel = 1 / 256
    else:
        padding_x = padding_y = max(2 * resolution_m, 2 * cell_size_m)
        native_pixel = resolution_m

    min_x = float(np.min(projected_x)) - padding_x
    max_x = float(np.max(projected_x)) + padding_x
    min_y = float(np.min(projected_y)) - padding_y
    max_y = float(np.max(projected_y)) + padding_y
    width = min(1024, max(res + 2, math.ceil((max_x - min_x) / native_pixel)))
    height = min(1024, max(res + 2, math.ceil((max_y - min_y) / native_pixel)))
    return {
        "bbox": f"{min_x},{min_y},{max_x},{max_y}",
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": "F32",
        "f": "image",
    }


async def fetch_lunar_heightmap(
    lat: float, lon: float, size_km: float, res: int
) -> dict[str, Any]:
    service = _dem_service_for_latitude(lat)
    key = f"heightmap:{service['version']}:{lat:.5f}:{lon:.5f}:{size_km:g}:{res}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    params = _heightmap_export_params(lat, lon, size_km, res, service)
    export_url = service["url"].rsplit("/", 1)[0] + "/exportImage"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=15.0)
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
        result = await asyncio.to_thread(
            _heightmap_from_tiff,
            response.content,
            lat,
            lon,
            size_km,
            res,
            service,
        )
    except HeightmapOutOfCoverageError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OUT_OF_DEM_COVERAGE",
                "message": str(exc),
                "field": "lat",
            },
        ) from exc
    except HeightmapDataError as exc:
        raise _upstream_error(
            "The lunar DEM could not be processed.", cause=exc
        ) from exc

    heightmap_keys = [
        item_key for item_key in _cache if item_key.startswith("heightmap:")
    ]
    if len(heightmap_keys) >= HEIGHTMAP_CACHE_MAX_ENTRIES:
        oldest_key = min(heightmap_keys, key=lambda item_key: _cache[item_key][0])
        del _cache[oldest_key]
    _cache_set(key, result, HEIGHTMAP_CACHE_TTL)
    return result
