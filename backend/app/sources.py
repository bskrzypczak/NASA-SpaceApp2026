import asyncio
import csv
import io
import json
import logging
import math
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import HTTPException

from app import persistent_cache

logger = logging.getLogger(__name__)

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
MOON_TREK_BASE = "https://trek.nasa.gov/moon/trekarcgis/rest/services"
AU_KM = 149_597_870.7
MOON_RADIUS_KM = 1737.4
MAX_CACHE_ENTRIES = 512
HORIZONS_CACHE_TTL = 24 * 60 * 60
DEM_CACHE_TTL = 24 * 60 * 60
PARTIAL_RESULT_TTL = 60
PSR_RASTER_URL = (
    "/vsicurl/https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/"
    "LPSR_80S_20MPP_ADJ.TIF"
)
PSR_MIN_LATITUDE = -90.0
PSR_MAX_LATITUDE = -80.0
MOON_RADIUS_M = 1_737_400.0

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
# Moon Trek gets two independent lanes so a 38 MB DEM-window export never blocks
# the small requests the UI waits for (point elevation, small heightmaps).
MOON_TREK_LANE_LIMITS = {"light": 4, "bulk": 1}
MOON_TREK_CONCURRENCY_LIMIT = MOON_TREK_LANE_LIMITS["light"]
_moon_trek_semaphores: dict[str, asyncio.Semaphore] = {}
_moon_trek_semaphore_loop: asyncio.AbstractEventLoop | None = None
MOON_TREK_RETRIES = 2
HORIZONS_RETRIES = 1

# GDAL /vsicurl reads (PGDA PSR and visibility GeoTIFFs) had no timeout and could
# hang a worker thread forever, which also stalled /terrain/point. Keep them bounded.
GDAL_HTTP_TIMEOUT_S = 20
REMOTE_RASTER_TIMEOUT_S = 45.0


def gdal_http_env() -> dict[str, str]:
    """Options for rasterio.Env around every remote (/vsicurl) raster read."""
    return {
        "GDAL_HTTP_USERAGENT": "HORIZON-backend/0.1",
        "GDAL_HTTP_VERSION": "1.1",
        "CPL_VSIL_CURL_USE_HEAD": "NO",
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".TIF",
        "GDAL_HTTP_TIMEOUT": str(GDAL_HTTP_TIMEOUT_S),
        "GDAL_HTTP_CONNECTTIMEOUT": "10",
        "GDAL_HTTP_MAX_RETRY": "2",
        "GDAL_HTTP_RETRY_DELAY": "1",
    }


async def run_remote_raster(func: Any, *args: Any, timeout_s: float | None = None) -> Any:
    """Run a blocking /vsicurl raster read in a thread, but never wait longer than timeout_s."""
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(func, *args), timeout_s or REMOTE_RASTER_TIMEOUT_S
        )
    except asyncio.TimeoutError as exc:
        raise _upstream_error(
            "The PGDA raster service timed out.", 504, cause=exc
        ) from exc


_in_flight: dict[str, asyncio.Future] = {}


async def single_flight(key: str, factory: Any) -> Any:
    """Run factory() once per key; concurrent callers with the same key share the result.

    The work runs in its own task, so a caller that goes away (client closed the
    request) does not cancel the download for everybody else.
    """
    existing = _in_flight.get(key)
    if existing is not None and existing.get_loop() is asyncio.get_running_loop():
        return await asyncio.shield(existing)

    task = asyncio.ensure_future(factory())
    _in_flight[key] = task

    def _done(_task: asyncio.Future) -> None:
        if _in_flight.get(key) is _task:
            del _in_flight[key]
        if not _task.cancelled():
            _task.exception()  # mark as retrieved; callers re-raise it

    task.add_done_callback(_done)
    return await asyncio.shield(task)


def _cache_get(key: str) -> dict[str, Any] | None:
    entry = _cache.get(key)
    if entry is not None:
        expires_at, value = entry
        if expires_at > time.monotonic():
            return value
        del _cache[key]

    persisted_entry = persistent_cache.get(key)
    if persisted_entry is None:
        return None
    value, remaining_ttl = persisted_entry
    _cache[key] = (time.monotonic() + remaining_ttl, value)
    return value


def _cache_set(
    key: str,
    value: dict[str, Any],
    ttl: int,
    *,
    prefix_limit: int | None = None,
) -> None:
    now = time.monotonic()
    expired_keys = [item_key for item_key, (expiry, _) in _cache.items() if expiry <= now]
    for item_key in expired_keys:
        del _cache[item_key]
    if len(_cache) >= MAX_CACHE_ENTRIES:
        oldest_key = min(_cache, key=lambda item_key: _cache[item_key][0])
        del _cache[oldest_key]
    _cache[key] = (now + ttl, value)
    persistent_cache.set(key, value, ttl, prefix_limit=prefix_limit)


def _upstream_error(
    message: str,
    status_code: int = 502,
    *,
    cause: Exception | None = None,
) -> HTTPException:
    if cause is None:
        logger.error("Upstream request failed: %s (status %s)", message, status_code)
    else:
        logger.error(
            "Upstream request failed: %s (status %s)",
            message,
            status_code,
            exc_info=(type(cause), cause, cause.__traceback__),
        )
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


async def _get_response(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, str],
    *,
    semaphore: asyncio.Semaphore | None = None,
    retries: int = 0,
    service_name: str = "upstream data",
) -> httpx.Response:
    for attempt in range(retries + 1):
        try:
            if semaphore is None:
                response = await client.get(url, params=params)
            else:
                async with semaphore:
                    response = await client.get(url, params=params)
            response.raise_for_status()
            return response
        except (httpx.RemoteProtocolError, httpx.ReadTimeout) as exc:
            if attempt < retries:
                await asyncio.sleep(0.25 * (2**attempt))
                continue
            if isinstance(exc, httpx.ReadTimeout):
                raise _upstream_error(
                    f"The {service_name} service timed out.",
                    504,
                    cause=exc,
                ) from exc
            raise _upstream_error(
                f"The {service_name} service could not be reached.",
                cause=exc,
            ) from exc
        except httpx.TimeoutException as exc:
            raise _upstream_error(
                f"The {service_name} service timed out.",
                504,
                cause=exc,
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise _upstream_error(
                f"The {service_name} service returned HTTP {exc.response.status_code}.",
                cause=exc,
            ) from exc
        except httpx.RequestError as exc:
            raise _upstream_error(
                f"The {service_name} service could not be reached.",
                cause=exc,
            ) from exc

    raise RuntimeError("The upstream request retry loop ended unexpectedly.")


async def _get_moon_trek_response(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, str],
    *,
    lane: str = "light",
) -> httpx.Response:
    """lane="bulk" for large DEM-window exports, "light" for everything else."""
    global _moon_trek_semaphore_loop
    loop = asyncio.get_running_loop()
    if _moon_trek_semaphore_loop is not loop:
        _moon_trek_semaphores.clear()
        for name, limit in MOON_TREK_LANE_LIMITS.items():
            _moon_trek_semaphores[name] = asyncio.Semaphore(limit)
        _moon_trek_semaphore_loop = loop
    semaphore = _moon_trek_semaphores.get(lane)
    if semaphore is None:
        raise ValueError(f"Unknown Moon Trek lane: {lane}.")
    return await _get_response(
        client,
        url,
        params,
        semaphore=semaphore,
        retries=MOON_TREK_RETRIES,
        service_name="lunar DEM",
    )


async def _get_json(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, str],
    *,
    moon_trek: bool = False,
    retries: int = 0,
    service_name: str = "upstream data",
) -> dict[str, Any]:
    if moon_trek:
        response = await _get_moon_trek_response(client, url, params)
    else:
        response = await _get_response(
            client, url, params, retries=retries, service_name=service_name
        )

    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError) as exc:
        raise _upstream_error(
            "The upstream data service returned invalid JSON.", cause=exc
        ) from exc
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
    payload = await _get_json(
        client, service["url"], params, moon_trek=True
    )
    try:
        value = float(payload.get("value"))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _wrap_lon_to_window(lon: float, bounds: Any) -> float:
    """Shift lon by ±360° so it falls inside a geographic window that crosses the antimeridian."""
    for candidate in (lon, lon - 360.0, lon + 360.0):
        if bounds.left <= candidate <= bounds.right:
            return candidate
    return lon


def _sample_dem_window(
    content: bytes,
    service: dict[str, Any],
    sample_points: dict[str, tuple[float, float]],
) -> dict[str, float | None]:
    try:
        import rasterio
        from rasterio.io import MemoryFile
    except ImportError as exc:
        raise _upstream_error(
            "NumPy and Rasterio are required to read the lunar DEM window.",
            cause=exc,
        ) from exc

    try:
        with MemoryFile(content) as memory_file:
            with memory_file.open() as dataset:
                dem = dataset.read(1)
                result: dict[str, float | None] = {}
                for name, (lat, lon) in sample_points.items():
                    if service["projection"] == "south-polar":
                        x, y = _south_polar_stereographic_xy(lat, lon)
                    elif service["projection"] == "north-polar":
                        x, y = _north_polar_stereographic_xy(lat, lon)
                    else:
                        # Global DEM windows are in degrees (lon, lat). Before this fix they
                        # were sampled as north-polar metres → always out of bounds → null.
                        x, y = _wrap_lon_to_window(lon, dataset.bounds), lat
                    row, col = dataset.index(x, y)
                    if not (0 <= row < dataset.height and 0 <= col < dataset.width):
                        result[name] = None
                        continue
                    value = float(dem[row, col])
                    if (
                        not math.isfinite(value)
                        or (dataset.nodata is not None and value == dataset.nodata)
                    ):
                        result[name] = None
                    else:
                        result[name] = value
                return result
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise _upstream_error(
            "The cached lunar DEM window could not be decoded.", cause=exc
        ) from exc


class PermanentShadowDataError(RuntimeError):
    pass






def _south_polar_stereographic_xy(lat: float, lon: float) -> tuple[float, float]:
    rho = 2 * MOON_RADIUS_M * math.tan(math.pi / 4 + math.radians(lat) / 2)
    longitude = math.radians(lon)
    return rho * math.sin(longitude), rho * math.cos(longitude)


def _north_polar_stereographic_xy(lat: float, lon: float) -> tuple[float, float]:
    rho = 2 * MOON_RADIUS_M * math.tan(math.pi / 4 - math.radians(lat) / 2)
    longitude = math.radians(lon)
    return rho * math.sin(longitude), -rho * math.cos(longitude)
























def _read_psr_raster_value(lat: float, lon: float) -> float | None:
    try:
        import rasterio
    except ImportError as exc:
        raise PermanentShadowDataError(
            "Rasterio is required to read the PGDA PSR map."
        ) from exc

    x, y = _south_polar_stereographic_xy(lat, lon)
    try:
        with rasterio.Env(**gdal_http_env()):
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
        raster_value = await asyncio.wait_for(
            asyncio.to_thread(_read_psr_raster_value, lat, lon),
            REMOTE_RASTER_TIMEOUT_S,
        )
    except asyncio.TimeoutError as exc:
        raise _upstream_error(
            "The PGDA PSR map timed out.", 504, cause=exc
        ) from exc
    except PermanentShadowDataError as exc:
        raise _upstream_error(
            "The PGDA PSR map could not be reached.", cause=exc
        ) from exc
    if raster_value is None or not math.isfinite(raster_value):
        return None
    return raster_value > 0.5


async def fetch_lunar_elevation(lat: float, lon: float) -> dict[str, Any]:
    service = _dem_service_for_latitude(lat)
    key = f"dem:{service['version']}:{lat:.5f}:{lon:.5f}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    return await single_flight(key, lambda: _fetch_lunar_elevation(lat, lon, service, key))


async def _optional_shadow(lat: float, lon: float) -> tuple[bool | None, bool]:
    """PSR lookup that never fails the whole point: (value, ok)."""
    try:
        return await _fetch_permanent_shadow(lat, lon), True
    except HTTPException:
        return None, False


async def _fetch_lunar_elevation(
    lat: float, lon: float, service: dict[str, Any], key: str
) -> dict[str, Any]:

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
    from app.dem_window_source import find_cached_dem_window

    dem_window = await find_cached_dem_window(
        lat, lon, service, required_margin_m=4 * resolution_m
    )
    complete = True
    if dem_window is not None:
        elevations, (in_permanent_shadow, shadow_ok) = await asyncio.gather(
            asyncio.to_thread(
                _sample_dem_window,
                dem_window.content,
                service,
                sample_points,
            ),
            _optional_shadow(lat, lon),
        )
    else:
        async with httpx.AsyncClient(timeout=12.0) as client:
            samples, (in_permanent_shadow, shadow_ok) = await asyncio.gather(
                asyncio.gather(
                    *(
                        _fetch_dem_sample(client, service, point_lat, point_lon)
                        for point_lat, point_lon in sample_points.values()
                    ),
                    return_exceptions=True,
                ),
                _optional_shadow(lat, lon),
            )
        # Only the centre sample is essential; a failed neighbour just means no slope.
        if isinstance(samples[0], BaseException):
            raise samples[0]
        complete = not any(isinstance(sample, BaseException) for sample in samples)
        elevations = {
            name: None if isinstance(sample, BaseException) else sample
            for name, sample in zip(sample_points, samples)
        }
    complete = complete and shadow_ok
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
        # false = slope or PSR could not be fetched this time; asking again may fill them in.
        "complete": complete,
    }
    # Partial answers are cached briefly so a retry a minute later tries upstream again.
    _cache_set(key, result, DEM_CACHE_TTL if complete else PARTIAL_RESULT_TTL)
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
            retries=HORIZONS_RETRIES,
            service_name="JPL Horizons",
        )
    try:
        return _parse_horizons_response(payload)
    except (ValueError, TypeError, IndexError, KeyError) as exc:
        raise _upstream_error(
            "JPL Horizons returned an invalid ephemeris table.", cause=exc
        ) from exc


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
    return await single_flight(
        cache_key,
        lambda: _fetch_ephemeris(start, end, lat, lon, step_min, bodies, body_commands, cache_key),
    )


async def _fetch_ephemeris(
    start: datetime,
    end: datetime,
    lat: float,
    lon: float,
    step_min: int,
    bodies: set[str],
    body_commands: dict[str, str],
    cache_key: str,
) -> dict[str, Any]:
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
