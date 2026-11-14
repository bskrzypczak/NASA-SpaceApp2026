import asyncio
import csv
import io
import json
import math
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import HTTPException

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
MOON_TREK_BASE = "https://trek.nasa.gov/moon/trekarcgis/rest/services"
AU_KM = 149_597_870.7
MOON_RADIUS_KM = 1737.4
MAX_CACHE_ENTRIES = 512
HORIZONS_CACHE_TTL = 24 * 60 * 60
DEM_CACHE_TTL = 24 * 60 * 60
HORIZON_CACHE_TTL = 24 * 60 * 60
HEIGHTMAP_CACHE_TTL = 24 * 60 * 60
HEIGHTMAP_CACHE_MAX_ENTRIES = 4
HORIZON_DEM_EXPORT_URL = (
    f"{MOON_TREK_BASE}/LRO_LOLA_DEM_SPole45_100mp_v04/ImageServer/exportImage"
)
HORIZON_DEM_VERSION = "LRO_LOLA_DEM_SPole45_100mp_v04"
HORIZON_DEM_RESOLUTION_M = 100.0
HORIZON_MAX_DISTANCE_KM = 150.0
HORIZON_WINDOW_HALF_SIZE_M = 152_000.0
HORIZON_WINDOW_SIZE_PX = 3041
HORIZON_RAY_STEP_M = 100.0
PSR_RASTER_URL = (
    "/vsicurl/https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/"
    "LPSR_80S_20MPP_ADJ.TIF"
)
PSR_MIN_LATITUDE = -90.0
PSR_MAX_LATITUDE = -80.0
MOON_RADIUS_M = 1_737_400.0
MAX_ABS_LUNAR_ELEVATION_M = 20_000.0

DEM_SERVICES = {
    "south-pole": {
        "url": f"{MOON_TREK_BASE}/LRO_LOLA_DEM_SPole45_100mp_v04/ImageServer/identify",
        "projection": "south-polar",
        "spatialReference": "104903",
        "resolutionM": 100.0,
        "version": "LRO_LOLA_DEM_SPole45_100mp_v04",
    },
    "north-pole": {
        "url": f"{MOON_TREK_BASE}/LRO_LOLA_DEM_NPole45_100mp_v04/ImageServer/identify",
        "projection": "north-polar",
        "spatialReference": "104904",
        "resolutionM": 100.0,
        "version": "LRO_LOLA_DEM_NPole45_100mp_v04",
    },
    "global": {
        "url": f"{MOON_TREK_BASE}/LRO_LOLA_DEM_Global_256ppd_v06/ImageServer/identify",
        "projection": "geographic",
        "spatialReference": None,
        "resolutionM": None,
        "version": "LRO_LOLA_DEM_Global_256ppd_v06",
    },
}

_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_horizons_semaphore = asyncio.Semaphore(2)


def _cache_get(key: str) -> dict[str, Any] | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    expires_at, value = entry
    if expires_at <= time.monotonic():
        del _cache[key]
        return None
    return value


def _cache_set(key: str, value: dict[str, Any], ttl: int) -> None:
    now = time.monotonic()
    expired_keys = [item_key for item_key, (expiry, _) in _cache.items() if expiry <= now]
    for item_key in expired_keys:
        del _cache[item_key]
    if len(_cache) >= MAX_CACHE_ENTRIES:
        oldest_key = min(_cache, key=lambda item_key: _cache[item_key][0])
        del _cache[oldest_key]
    _cache[key] = (now + ttl, value)


def _upstream_error(message: str, status_code: int = 502) -> HTTPException:
    code = "TIMEOUT" if status_code == 504 else "UPSTREAM_ERROR"
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "field": None,
            "retryAfterS": 5,
        },
    )


async def _get_json(
    client: httpx.AsyncClient, url: str, params: dict[str, str]
) -> dict[str, Any]:
    try:
        response = await client.get(url, params=params)
        response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise _upstream_error("The upstream data service timed out.", 504) from exc
    except httpx.HTTPStatusError as exc:
        raise _upstream_error(
            f"The upstream data service returned HTTP {exc.response.status_code}."
        ) from exc
    except httpx.RequestError as exc:
        raise _upstream_error("The upstream data service could not be reached.") from exc

    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError) as exc:
        raise _upstream_error("The upstream data service returned invalid JSON.") from exc
    if not isinstance(payload, dict):
        raise _upstream_error("The upstream data service returned an unexpected response.")
    if "error" in payload:
        raise _upstream_error("The upstream data service rejected the request.")
    return payload


def _dem_service_for_latitude(lat: float) -> dict[str, Any]:
    if lat <= -45:
        return DEM_SERVICES["south-pole"]
    if lat >= 45:
        return DEM_SERVICES["north-pole"]
    return DEM_SERVICES["global"]


def _destination_point(lat: float, lon: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    angular_distance = distance_m / (MOON_RADIUS_KM * 1000)
    bearing = math.radians(bearing_deg)
    latitude = math.radians(lat)
    longitude = math.radians(lon)
    destination_latitude = math.asin(
        math.sin(latitude) * math.cos(angular_distance)
        + math.cos(latitude) * math.sin(angular_distance) * math.cos(bearing)
    )
    destination_longitude = longitude + math.atan2(
        math.sin(bearing) * math.sin(angular_distance) * math.cos(latitude),
        math.cos(angular_distance) - math.sin(latitude) * math.sin(destination_latitude),
    )
    destination_lon_deg = (math.degrees(destination_longitude) + 180) % 360 - 180
    return math.degrees(destination_latitude), destination_lon_deg


def _slope_from_cardinal_samples(
    north_m: float,
    south_m: float,
    east_m: float,
    west_m: float,
    north_south_spacing_m: float,
    east_west_spacing_m: float,
) -> float:
    dz_dy = (north_m - south_m) / north_south_spacing_m
    dz_dx = (east_m - west_m) / east_west_spacing_m
    return math.degrees(math.atan(math.hypot(dz_dx, dz_dy)))


async def _fetch_dem_sample(
    client: httpx.AsyncClient,
    service: dict[str, Any],
    lat: float,
    lon: float,
) -> float | None:
    projection = service["projection"]
    if projection == "south-polar":
        x, y = _south_polar_stereographic_xy(lat, lon)
    elif projection == "north-polar":
        x, y = _north_polar_stereographic_xy(lat, lon)
    else:
        x, y = lon, lat

    params = {
        "geometry": json.dumps({"x": x, "y": y}, separators=(",", ":")),
        "geometryType": "esriGeometryPoint",
        "returnGeometry": "false",
        "returnCatalogItems": "false",
        "f": "json",
    }
    if service["spatialReference"] is not None:
        params["sr"] = service["spatialReference"]
    payload = await _get_json(client, service["url"], params)
    try:
        value = float(payload.get("value"))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


class PermanentShadowDataError(RuntimeError):
    pass


class HorizonDataError(RuntimeError):
    pass


class HorizonOutOfCoverageError(RuntimeError):
    pass


def _south_polar_stereographic_xy(lat: float, lon: float) -> tuple[float, float]:
    rho = 2 * MOON_RADIUS_M * math.tan(math.pi / 4 + math.radians(lat) / 2)
    longitude = math.radians(lon)
    return rho * math.sin(longitude), rho * math.cos(longitude)


def _north_polar_stereographic_xy(lat: float, lon: float) -> tuple[float, float]:
    rho = 2 * MOON_RADIUS_M * math.tan(math.pi / 4 - math.radians(lat) / 2)
    longitude = math.radians(lon)
    return rho * math.sin(longitude), -rho * math.cos(longitude)


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
        raise _upstream_error("The lunar DEM export timed out.", 504) from exc
    except httpx.HTTPStatusError as exc:
        raise _upstream_error(
            f"The lunar DEM service returned HTTP {exc.response.status_code}."
        ) from exc
    except httpx.RequestError as exc:
        raise _upstream_error("The lunar DEM service could not be reached.") from exc

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
        raise _upstream_error("The lunar DEM could not be processed.") from exc

    heightmap_keys = [
        item_key for item_key in _cache if item_key.startswith("heightmap:")
    ]
    if len(heightmap_keys) >= HEIGHTMAP_CACHE_MAX_ENTRIES:
        oldest_key = min(heightmap_keys, key=lambda item_key: _cache[item_key][0])
        del _cache[oldest_key]
    _cache_set(key, result, HEIGHTMAP_CACHE_TTL)
    return result


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
        raise _upstream_error("The lunar DEM export timed out.", 504) from exc
    except httpx.HTTPStatusError as exc:
        raise _upstream_error(
            f"The lunar DEM service returned HTTP {exc.response.status_code}."
        ) from exc
    except httpx.RequestError as exc:
        raise _upstream_error("The lunar DEM service could not be reached.") from exc

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
        raise _upstream_error("The lunar DEM could not be processed.") from exc

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


def _read_psr_raster_value(lat: float, lon: float) -> float | None:
    try:
        import rasterio
    except ImportError as exc:
        raise PermanentShadowDataError(
            "Rasterio is required to read the PGDA PSR map."
        ) from exc

    x, y = _south_polar_stereographic_xy(lat, lon)
    try:
        with rasterio.Env(
            GDAL_HTTP_USERAGENT="HORIZON-backend/0.1",
            GDAL_HTTP_VERSION="1.1",
            CPL_VSIL_CURL_USE_HEAD="NO",
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".TIF",
        ):
            with rasterio.open(PSR_RASTER_URL) as dataset:
                row, col = dataset.index(x, y)
                if not (0 <= row < dataset.height and 0 <= col < dataset.width):
                    return None
                value = float(next(dataset.sample([(x, y)]))[0])
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise PermanentShadowDataError(
            "The PGDA PSR raster could not be read."
        ) from exc

    return value if math.isfinite(value) else None


async def _fetch_permanent_shadow(lat: float, lon: float) -> bool | None:
    if not PSR_MIN_LATITUDE <= lat <= PSR_MAX_LATITUDE:
        return None
    try:
        raster_value = await asyncio.to_thread(_read_psr_raster_value, lat, lon)
    except PermanentShadowDataError as exc:
        raise _upstream_error("The PGDA PSR map could not be reached.") from exc
    if raster_value is None or not math.isfinite(raster_value):
        return None
    return raster_value > 0.5


async def fetch_lunar_elevation(lat: float, lon: float) -> dict[str, Any]:
    service = _dem_service_for_latitude(lat)
    key = f"dem:{service['version']}:{lat:.5f}:{lon:.5f}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    resolution_m = service["resolutionM"]
    if resolution_m is None:
        resolution_m = 2 * math.pi * MOON_RADIUS_KM * 1000 / 360 / 256
    north_south_step_m = resolution_m
    east_west_step_m = resolution_m
    if service["resolutionM"] is None:
        east_west_step_m *= max(math.cos(math.radians(lat)), 1e-6)

    sample_points = {
        "center": (lat, lon),
        "north": _destination_point(lat, lon, 0, north_south_step_m),
        "south": _destination_point(lat, lon, 180, north_south_step_m),
        "east": _destination_point(lat, lon, 90, east_west_step_m),
        "west": _destination_point(lat, lon, 270, east_west_step_m),
    }
    async with httpx.AsyncClient(timeout=12.0) as client:
        samples, in_permanent_shadow = await asyncio.gather(
            asyncio.gather(
                *(
                    _fetch_dem_sample(client, service, point_lat, point_lon)
                    for point_lat, point_lon in sample_points.values()
                )
            ),
            _fetch_permanent_shadow(lat, lon),
        )
    elevations = dict(zip(sample_points, samples))
    elevation_m = elevations["center"]
    slope_samples = [elevations[name] for name in ("north", "south", "east", "west")]
    slope_deg = None
    if elevation_m is not None and all(value is not None for value in slope_samples):
        north_m, south_m, east_m, west_m = slope_samples
        slope_deg = _slope_from_cardinal_samples(
            north_m,
            south_m,
            east_m,
            west_m,
            2 * north_south_step_m,
            2 * east_west_step_m,
        )

    result = {
        "elevationM": round(elevation_m, 2) if elevation_m is not None else None,
        "slopeDeg": round(slope_deg, 3) if slope_deg is not None else None,
        "demCoverage": elevation_m is not None,
        "demResolutionM": round(resolution_m, 1),
        "inPermanentShadow": in_permanent_shadow,
        "demVersion": service["version"],
        "source": "NASA Moon Trek LRO LOLA ImageServer",
    }
    _cache_set(key, result, DEM_CACHE_TTL)
    return result


def _horizons_request_params(
    command: str,
    lat: float,
    lon: float,
    start: datetime,
    end: datetime,
    step_min: int,
) -> dict[str, str]:
    return {
        "format": "json",
        "COMMAND": command,
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER",
        "CENTER": "coord@301",
        "COORD_TYPE": "GEODETIC",
        "SITE_COORD": f"{lon},{lat},0",
        "START_TIME": start.strftime("%Y-%m-%d %H:%M"),
        "STOP_TIME": end.strftime("%Y-%m-%d %H:%M"),
        "STEP_SIZE": f"{step_min} m",
        "QUANTITIES": "4,20",
        "APPARENT": "AIRLESS",
        "TIME_TYPE": "UT",
        "TIME_DIGITS": "MINUTES",
        "CSV_FORMAT": "YES",
    }


def _parse_horizons_response(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    if not isinstance(result, str):
        raise ValueError("Missing Horizons result table.")
    start_marker, end_marker = "$$SOE", "$$EOE"
    if start_marker not in result or end_marker not in result:
        raise ValueError("Horizons result contains no observation table.")

    table = result.split(start_marker, 1)[1].split(end_marker, 1)[0]
    rows = list(csv.reader(io.StringIO(table)))
    samples = []
    for row in rows:
        if len(row) < 6 or not row[0].strip():
            continue
        timestamp = datetime.strptime(
            row[0].strip(), "%Y-%b-%d %H:%M"
        ).replace(tzinfo=timezone.utc)
        samples.append(
            {
                "time": timestamp.isoformat().replace("+00:00", "Z"),
                "azDeg": float(row[3]),
                "elDeg": float(row[4]),
                "distanceKm": float(row[5]) * AU_KM,
            }
        )
    if not samples:
        raise ValueError("Horizons returned no usable ephemeris samples.")

    source_match = re.search(r"\{source:\s*([^}]+)\}", result)
    return {
        "samples": samples,
        "model": source_match.group(1).strip() if source_match else "JPL Horizons",
        "version": payload.get("signature", {}).get("version"),
    }


async def _fetch_horizons_body(
    client: httpx.AsyncClient,
    command: str,
    lat: float,
    lon: float,
    start: datetime,
    end: datetime,
    step_min: int,
) -> dict[str, Any]:
    async with _horizons_semaphore:
        payload = await _get_json(
            client,
            HORIZONS_URL,
            _horizons_request_params(command, lat, lon, start, end, step_min),
        )
    try:
        return _parse_horizons_response(payload)
    except (ValueError, TypeError, IndexError, KeyError) as exc:
        raise _upstream_error("JPL Horizons returned an invalid ephemeris table.") from exc


async def fetch_ephemeris(
    lat: float,
    lon: float,
    start: datetime,
    end: datetime,
    step_min: int,
    bodies: set[str],
) -> dict[str, Any]:
    body_commands = {"sun": "10", "earth": "399"}
    cache_key = (
        f"ephemeris:{lat:.3f}:{lon:.3f}:{start.isoformat()}:"
        f"{end.isoformat()}:{step_min}:{','.join(sorted(bodies))}"
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    start_utc = start.astimezone(timezone.utc)
    end_utc = end.astimezone(timezone.utc)
    async with httpx.AsyncClient(timeout=30.0) as client:
        results = await asyncio.gather(
            *(
                _fetch_horizons_body(
                    client,
                    body_commands[body],
                    lat,
                    lon,
                    start_utc,
                    end_utc,
                    step_min,
                )
                for body in sorted(bodies)
            )
        )

    response: dict[str, Any] = {
        "start": start_utc.isoformat().replace("+00:00", "Z"),
        "stepMin": step_min,
    }
    models = set()
    for body, result in zip(sorted(bodies), results):
        models.add(result["model"])
        response[body] = {
            "azDeg": [sample["azDeg"] for sample in result["samples"]],
            "elDeg": [sample["elDeg"] for sample in result["samples"]],
            "distanceKm": [round(sample["distanceKm"], 3) for sample in result["samples"]],
        }
        if "times" not in response:
            response["times"] = [sample["time"] for sample in result["samples"]]
    response["source"] = (
        f"JPL Horizons API, observer on body 301, airless, {', '.join(sorted(models))}"
    )
    _cache_set(cache_key, response, HORIZONS_CACHE_TTL)
    return response
