import asyncio
import math
from typing import Any

from app.heightmap_source import _heightmap_projected_grid
from app.persistent_cache import get as get_persisted_cache
from app.persistent_cache import set as set_persisted_cache
from app.sources import MOON_RADIUS_KM, _upstream_error

VISIBILITY_GRID_CACHE_TTL = 24 * 60 * 60
VISIBILITY_GRID_SOURCE = "NASA GSFC PGDA LOLA Lunar Polar Illumination"
VISIBILITY_GRID_BASE_URL = (
    "https://pgda.gsfc.nasa.gov/data/MoonIllumination"
)


class VisibilityGridDataError(RuntimeError):
    pass


def _visibility_product(
    layer_id: str, lat: float, size_km: float
) -> dict[str, Any] | None:
    if layer_id not in {"illumination", "earth-visibility"}:
        raise ValueError(f"Unsupported visibility layer: {layer_id}.")

    radius_deg = math.degrees(
        size_km / math.sqrt(2) / MOON_RADIUS_KM
    )
    min_abs_latitude = max(0.0, abs(lat) - radius_deg)
    max_abs_latitude = abs(lat) + radius_deg
    if max_abs_latitude < 65:
        return None

    hemisphere = "S" if lat < 0 else "N"
    band, resolution_m = (
        ("75", 120) if min_abs_latitude >= 75 else ("65", 240)
    )
    product_id = (
        f"AVGVISIB_{band}{hemisphere}_{resolution_m:03}M_201608"
    )
    if layer_id == "earth-visibility":
        product_id += "_EARTH"
    return {
        "version": product_id,
        "resolutionM": resolution_m,
        "projection": "south-polar" if hemisphere == "S" else "north-polar",
        "url": f"{VISIBILITY_GRID_BASE_URL}/{product_id}.TIF",
    }


def _sample_visibility_dataset(
    dataset: Any, projected_x: Any, projected_y: Any
) -> list[list[float | None]]:
    import numpy as np
    from rasterio.transform import rowcol
    from rasterio.windows import Window

    flat_x = np.asarray(projected_x, dtype=np.float64).ravel()
    flat_y = np.asarray(projected_y, dtype=np.float64).ravel()
    rows, cols = rowcol(dataset.transform, flat_x, flat_y)
    rows = np.asarray(rows, dtype=np.int64)
    cols = np.asarray(cols, dtype=np.int64)
    values = np.full(flat_x.shape, np.nan, dtype=np.float64)
    in_bounds = (
        (rows >= 0)
        & (rows < dataset.height)
        & (cols >= 0)
        & (cols < dataset.width)
    )
    if np.any(in_bounds):
        in_bounds_indices = np.flatnonzero(in_bounds)
        selected_rows = rows[in_bounds]
        selected_cols = cols[in_bounds]
        row_min = int(np.min(selected_rows))
        col_min = int(np.min(selected_cols))
        row_max = int(np.max(selected_rows)) + 1
        col_max = int(np.max(selected_cols)) + 1
        raster_window = dataset.read(
            1,
            window=Window(
                col_min,
                row_min,
                col_max - col_min,
                row_max - row_min,
            ),
            masked=True,
        )
        sampled = raster_window[
            selected_rows - row_min,
            selected_cols - col_min,
        ]
        raw_values = np.asarray(sampled.data, dtype=np.float64)
        valid = (
            ~np.ma.getmaskarray(sampled)
            & np.isfinite(raw_values)
        )
        scales = dataset.scales
        offsets = dataset.offsets
        scale = float(scales[0]) if scales else 1.0
        offset = float(offsets[0]) if offsets else 0.0
        if not math.isfinite(scale) or scale == 0 or not math.isfinite(offset):
            raise VisibilityGridDataError(
                "The PGDA raster has invalid scale metadata."
            )
        fractions = raw_values * scale + offset
        valid &= np.isfinite(fractions)
        if np.any(valid & ((fractions < -1e-6) | (fractions > 1 + 1e-6))):
            raise VisibilityGridDataError(
                "The PGDA raster contains values outside the expected 0–1 range."
            )
        percentages = np.round(np.clip(fractions, 0, 1) * 100, 3)
        values[in_bounds_indices[valid]] = percentages[valid]

    return [
        [
            round(float(value), 3) if math.isfinite(float(value)) else None
            for value in row
        ]
        for row in values.reshape(np.shape(projected_x))
    ]


def _read_visibility_grid_values(
    lat: float,
    lon: float,
    size_km: float,
    res: int,
    product: dict[str, Any],
) -> list[list[float | None]]:
    try:
        import rasterio
    except ImportError as exc:
        raise VisibilityGridDataError(
            "Rasterio and NumPy are required to read PGDA visibility grids."
        ) from exc

    projected_x, projected_y = _heightmap_projected_grid(
        lat,
        lon,
        size_km,
        res,
        product["projection"],
    )
    try:
        with rasterio.Env(
            GDAL_HTTP_USERAGENT="HORIZON-backend/0.1",
            GDAL_HTTP_VERSION="1.1",
            CPL_VSIL_CURL_USE_HEAD="NO",
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".TIF",
        ):
            with rasterio.open(f"/vsicurl/{product['url']}") as dataset:
                return _sample_visibility_dataset(
                    dataset,
                    projected_x,
                    projected_y,
                )
    except VisibilityGridDataError:
        raise
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise VisibilityGridDataError(
            "The PGDA visibility raster could not be read."
        ) from exc


async def fetch_visibility_grid(
    layer_id: str,
    lat: float,
    lon: float,
    size_km: float,
    res: int,
) -> dict[str, Any]:
    product = _visibility_product(layer_id, lat, size_km)
    version = product["version"] if product is not None else None
    cache_key = (
        f"layergrid:{layer_id}:{version or 'no-coverage'}:"
        f"{lat:.5f}:{lon:.5f}:{size_km:g}:{res}"
    )
    cached = get_persisted_cache(cache_key)
    if cached is not None:
        return cached[0]

    if product is None:
        values = [[None] * res for _ in range(res)]
    else:
        try:
            values = await asyncio.to_thread(
                _read_visibility_grid_values,
                lat,
                lon,
                size_km,
                res,
                product,
            )
        except VisibilityGridDataError as exc:
            raise _upstream_error(
                "The PGDA visibility map could not be reached or processed.",
                cause=exc,
            ) from exc

    valid_values = [
        value
        for row in values
        for value in row
        if value is not None
    ]
    result = {
        "layerId": layer_id,
        "lat": lat,
        "lon": lon,
        "sizeKm": size_km,
        "res": res,
        "kind": "continuous",
        "unit": "%",
        "min": min(valid_values) if valid_values else None,
        "max": max(valid_values) if valid_values else None,
        "values": values,
        "northUp": True,
        "source": VISIBILITY_GRID_SOURCE,
        "version": version,
    }
    set_persisted_cache(cache_key, result, VISIBILITY_GRID_CACHE_TTL)
    return result
