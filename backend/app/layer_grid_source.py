import asyncio
import math
from typing import Any

from app.heightmap_source import _heightmap_projected_grid
from app.persistent_cache import get as get_persisted_cache
from app.persistent_cache import set as set_persisted_cache
from app.sources import PSR_RASTER_URL, _upstream_error

PSR_RASTER_VERSION = "LPSR_80S_20MPP_ADJ"
PSR_GRID_SOURCE = "NASA GSFC PGDA LPSR PSR map"
PSR_GRID_CACHE_TTL = 24 * 60 * 60


class LayerGridDataError(RuntimeError):
    pass


def build_slope_grid(heightmap: dict[str, Any]) -> dict[str, Any]:
    import numpy as np

    res = int(heightmap["res"])
    size_km = float(heightmap["sizeKm"])
    cell_size_m = size_km * 1000 / res
    heights = np.asarray(heightmap["heightsM"], dtype=np.float64)
    if (
        heights.shape != (res, res)
        or res < 3
        or not math.isfinite(cell_size_m)
        or cell_size_m <= 0
    ):
        raise LayerGridDataError("The LOLA heightmap has an invalid shape.")

    valid_heights = np.isfinite(heights)
    valid_windows = np.ones((res - 2, res - 2), dtype=bool)
    for row_offset in range(3):
        for col_offset in range(3):
            valid_windows &= valid_heights[
                row_offset : row_offset + res - 2,
                col_offset : col_offset + res - 2,
            ]

    north_west = heights[:-2, :-2]
    north = heights[:-2, 1:-1]
    north_east = heights[:-2, 2:]
    west = heights[1:-1, :-2]
    east = heights[1:-1, 2:]
    south_west = heights[2:, :-2]
    south = heights[2:, 1:-1]
    south_east = heights[2:, 2:]

    dz_dx = (
        north_east + 2 * east + south_east
        - north_west - 2 * west - south_west
    ) / (8 * cell_size_m)
    dz_dy = (
        south_west + 2 * south + south_east
        - north_west - 2 * north - north_east
    ) / (8 * cell_size_m)
    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    slope_grid = np.full((res, res), np.nan, dtype=np.float64)
    slope_grid[1:-1, 1:-1] = np.where(
        valid_windows,
        np.round(slope, 3),
        np.nan,
    )
    values = [
        [
            round(float(value), 3) if math.isfinite(float(value)) else None
            for value in row
        ]
        for row in slope_grid
    ]
    valid_values = [
        value
        for row in values
        for value in row
        if value is not None
    ]

    return {
        "layerId": "slope",
        "lat": heightmap["lat"],
        "lon": heightmap["lon"],
        "sizeKm": size_km,
        "res": res,
        "kind": "continuous",
        "unit": "deg",
        "min": min(valid_values) if valid_values else None,
        "max": max(valid_values) if valid_values else None,
        "values": values,
        "northUp": True,
        "source": (
            f"LOLA DEM {float(heightmap['demResolutionM']):g} m/px"
        ),
        "version": heightmap["demVersion"],
    }


def _sample_psr_dataset(
    dataset: Any, projected_x: Any, projected_y: Any
) -> Any:
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
        sample_data = np.asarray(sampled.data, dtype=np.float64)
        sample_valid = (
            ~np.ma.getmaskarray(sampled)
            & np.isfinite(sample_data)
        )
        values[in_bounds_indices[sample_valid]] = (
            sample_data[sample_valid] > 0.5
        ).astype(np.float64)
    return values.reshape(np.shape(projected_x))


def _read_psr_grid_values(
    lat: float, lon: float, size_km: float, res: int
) -> list[list[int | None]]:
    try:
        import rasterio
    except ImportError as exc:
        raise LayerGridDataError(
            "Rasterio and NumPy are required to read the PGDA PSR grid."
        ) from exc

    projected_x, projected_y = _heightmap_projected_grid(
        lat,
        lon,
        size_km,
        res,
        "south-polar",
    )
    try:
        with rasterio.Env(
            GDAL_HTTP_USERAGENT="HORIZON-backend/0.1",
            GDAL_HTTP_VERSION="1.1",
            CPL_VSIL_CURL_USE_HEAD="NO",
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".TIF",
        ):
            with rasterio.open(PSR_RASTER_URL) as dataset:
                sampled = _sample_psr_dataset(
                    dataset,
                    projected_x,
                    projected_y,
                )
    except (OSError, rasterio.errors.RasterioError) as exc:
        raise LayerGridDataError("The PGDA PSR raster could not be read.") from exc

    return [
        [
            int(value) if math.isfinite(float(value)) else None
            for value in row
        ]
        for row in sampled
    ]


async def fetch_psr_grid(
    lat: float, lon: float, size_km: float, res: int
) -> dict[str, Any]:
    key = (
        f"layergrid:psr:{PSR_RASTER_VERSION}:{lat:.5f}:{lon:.5f}:"
        f"{size_km:g}:{res}"
    )
    cached = get_persisted_cache(key)
    if cached is not None:
        return cached[0]

    try:
        values = await asyncio.to_thread(
            _read_psr_grid_values,
            lat,
            lon,
            size_km,
            res,
        )
    except LayerGridDataError as exc:
        raise _upstream_error(
            "The PGDA PSR map could not be reached.", cause=exc
        ) from exc

    valid_values = [
        value
        for row in values
        for value in row
        if value is not None
    ]
    result = {
        "layerId": "psr",
        "lat": lat,
        "lon": lon,
        "sizeKm": size_km,
        "res": res,
        "kind": "mask",
        "unit": None,
        "min": min(valid_values) if valid_values else None,
        "max": max(valid_values) if valid_values else None,
        "values": values,
        "northUp": True,
        "source": PSR_GRID_SOURCE,
        "version": PSR_RASTER_VERSION,
    }
    set_persisted_cache(key, result, PSR_GRID_CACHE_TTL)
    return result
