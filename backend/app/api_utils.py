API_PREFIX = "/api/v1"


def normalize_longitude(lon: float) -> float:
    normalized = (lon + 180.0) % 360.0 - 180.0
    return 180.0 if normalized == -180.0 and lon > 0 else normalized
