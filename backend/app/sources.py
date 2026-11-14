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

DEM_SERVICES = {
    "south-pole": {
        "url": f"{MOON_TREK_BASE}/LRO_LOLA_DEM_SPole45_100mp_v04/ImageServer/identify",
        "resolutionM": 100.0,
        "version": "LRO_LOLA_DEM_SPole45_100mp_v04",
    },
    "north-pole": {
        "url": f"{MOON_TREK_BASE}/LRO_LOLA_DEM_NPole45_100mp_v04/ImageServer/identify",
        "resolutionM": 100.0,
        "version": "LRO_LOLA_DEM_NPole45_100mp_v04",
    },
    "global": {
        "url": f"{MOON_TREK_BASE}/LRO_LOLA_DEM_Global_256ppd_v06/ImageServer/identify",
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
    params = {
        "geometry": json.dumps({"x": lon, "y": lat}, separators=(",", ":")),
        "geometryType": "esriGeometryPoint",
        "sr": "104903",
        "returnGeometry": "false",
        "returnCatalogItems": "false",
        "f": "json",
    }
    payload = await _get_json(client, service["url"], params)
    try:
        value = float(payload.get("value"))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


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
        samples = await asyncio.gather(
            *(
                _fetch_dem_sample(client, service, point_lat, point_lon)
                for point_lat, point_lon in sample_points.values()
            )
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
        "inPermanentShadow": None,
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
