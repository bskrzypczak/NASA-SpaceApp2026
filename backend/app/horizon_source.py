import asyncio
import math
from typing import Any

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
    single_flight,
)

HORIZON_CACHE_TTL = 24 * 60 * 60
HORIZON_MAX_DISTANCE_KM = 150.0
HORIZON_RAY_STEP_M = 100.0
GLOBAL_DEM_PIXELS_PER_DEGREE = 256


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


def _horizon_profile_from_dataset(
    dem: Any,
    *,
    transform: Any,
    nodata: float | None,
    lat: float,
    lon: float,
    height_m: float,
    bin_deg: float,
    projection: str,
) -> tuple[list[float], list[float]]:
    if projection == "south-polar":
        center_x, center_y = _south_polar_stereographic_xy(lat, lon)
    elif projection == "north-polar":
        center_x, center_y = _north_polar_stereographic_xy(lat, lon)
    elif projection == "geographic":
        center_x, center_y = lon, lat
    else:
        raise HorizonDataError(f"Unsupported DEM projection: {projection}.")
    return _horizon_profile_from_dem(
        dem,
        left=transform.c,
        top=transform.f,
        pixel_width=transform.a,
        pixel_height=-transform.e,
        nodata=nodata,
        center_x=center_x,
        center_y=center_y,
        lat=lat,
        lon=lon,
        height_m=height_m,
        bin_deg=bin_deg,
        projection=projection,
    )


def _horizon_profiles_from_tiff(
    raster_bytes: bytes,
    requests: list[tuple[float, float, float, float]],
    projection: str,
) -> list[tuple[list[float], list[float]]]:
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError as exc:
        raise HorizonDataError(
            "NumPy and Rasterio are required to calculate the horizon."
        ) from exc

    try:
        with MemoryFile(raster_bytes) as memory_file:
            with memory_file.open() as dataset:
                dem = np.asarray(dataset.read(1))
                return [
                    _horizon_profile_from_dataset(
                        dem,
                        transform=dataset.transform,
                        nodata=dataset.nodata,
                        lat=lat,
                        lon=lon,
                        height_m=height_m,
                        bin_deg=bin_deg,
                        projection=projection,
                    )
                    for lat, lon, height_m, bin_deg in requests
                ]
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise HorizonDataError("The DEM export could not be decoded.") from exc


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
    return await single_flight(
        key, lambda: _fetch_horizon(lat, lon, height_m, bin_deg, service, key)
    )


async def _fetch_horizon(
    lat: float,
    lon: float,
    height_m: float,
    bin_deg: float,
    service: dict[str, Any],
    key: str,
) -> dict[str, Any]:
    from app.dem_window_source import fetch_dem_window

    dem_window = await fetch_dem_window(lat, lon, service)
    try:
        profiles = await asyncio.to_thread(
            _horizon_profiles_from_tiff,
            dem_window.content,
            [(lat, lon, height_m, bin_deg)],
            service["projection"],
        )
        azimuths, elevations = profiles[0]
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


async def prepare_horizon_profiles(
    center_lat: float,
    center_lon: float,
    locations: list[tuple[float, float]],
    heights_m: tuple[float, ...],
    bin_deg: float = 0.5,
    *,
    neighborhood_radius_m: float = 0.0,
) -> None:
    missing_by_service: dict[str, list[tuple[float, float, float, float]]] = {}
    services: dict[str, dict[str, Any]] = {}
    for lat, lon in locations:
        service = _dem_service_for_latitude(lat)
        services[service["version"]] = service
        for height_m in heights_m:
            key = (
                f"horizon:{service['version']}:{lat:.5f}:{lon:.5f}:"
                f"{height_m:.2f}:{bin_deg:.1f}"
            )
            if _cache_get(key) is None:
                missing_by_service.setdefault(service["version"], []).append(
                    (lat, lon, height_m, bin_deg)
                )

    if not missing_by_service:
        return

    from app.dem_window_source import fetch_dem_window

    for version, requests in missing_by_service.items():
        service = services[version]
        if service["version"] == _dem_service_for_latitude(center_lat)["version"]:
            window_center = (center_lat, center_lon)
            margin_m = neighborhood_radius_m
        else:
            window_center = (
                sum(item[0] for item in requests) / len(requests),
                sum(item[1] for item in requests) / len(requests),
            )
            margin_m = max(
                math.hypot(
                    (lat - window_center[0]) * math.pi / 180 * MOON_RADIUS_M,
                    (lon - window_center[1])
                    * math.cos(math.radians(window_center[0]))
                    * math.pi
                    / 180
                    * MOON_RADIUS_M,
                )
                for lat, lon, _, _ in requests
            )

        dem_window = await fetch_dem_window(
            *window_center,
            service,
            required_margin_m=HORIZON_MAX_DISTANCE_KM * 1000 + margin_m,
        )
        try:
            profiles = await asyncio.to_thread(
                _horizon_profiles_from_tiff,
                dem_window.content,
                requests,
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
        for (lat, lon, height_m, profile_bin), (azimuths, elevations) in zip(
            requests, profiles
        ):
            key = (
                f"horizon:{version}:{lat:.5f}:{lon:.5f}:"
                f"{height_m:.2f}:{profile_bin:.1f}"
            )
            _cache_set(
                key,
                {
                    "lat": lat,
                    "lon": lon,
                    "heightM": height_m,
                    "binDeg": profile_bin,
                    "maxDistanceKm": HORIZON_MAX_DISTANCE_KM,
                    "azimuthDeg": azimuths,
                    "elevationDeg": elevations,
                    "features": [],
                    "demVersion": version,
                    "demResolutionM": round(resolution_m, 1),
                },
                HORIZON_CACHE_TTL,
            )
