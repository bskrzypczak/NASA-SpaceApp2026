from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.simulation import (
    SimulationHardware,
    SimulationRequest,
    SimulationSite,
    SimulationWeights,
    build_simulation_result,
)

MAX_CALENDAR_DAYS = 366
CALENDAR_STEP_MIN = 60
MAX_EPHEMERIS_SAMPLES = 4320


class CalendarRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    site: SimulationSite
    from_date: date = Field(alias="from")
    to_date: date = Field(alias="to")
    landingTimeOfDay: str = Field(
        default="06:00:00Z",
        pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?Z$",
    )
    missionDays: int = Field(default=14, ge=1, le=30)
    horizonModel: Literal["real", "flat"] = "real"
    hardware: SimulationHardware = Field(default_factory=SimulationHardware)


def build_calendar_result(
    *,
    request: CalendarRequest,
    lat: float,
    lon: float,
    site_name: str,
    landing_time_of_day: time,
    step_min: int,
    ephemeris: dict[str, dict[str, list[float]]],
    sun_horizon: dict[str, Any] | None,
    earth_horizon: dict[str, Any] | None,
) -> dict[str, Any]:
    date_count = (request.to_date - request.from_date).days + 1
    sample_count = request.missionDays * 1440 // step_min
    required_samples = (date_count - 1 + request.missionDays) * 1440 // step_min
    if any(
        len(ephemeris[body][field]) != required_samples
        for body in ("sun", "earth")
        for field in ("azDeg", "elDeg")
    ):
        raise ValueError("Horizons returned an unexpected calendar sample count.")

    first_landing = datetime.combine(
        request.from_date, landing_time_of_day, tzinfo=timezone.utc
    )
    template = SimulationRequest(
        site=SimulationSite(lat=lat, lon=lon),
        landingTime=first_landing,
        missionDays=request.missionDays,
        windowDays=request.missionDays,
        stepMin=step_min,
        horizonModel=request.horizonModel,
        hardware=request.hardware,
        includeTimeseries=False,
    )
    weights = SimulationWeights().model_dump()
    site = {"name": site_name, "lat": lat, "lon": lon, "elevationM": None}
    days = []
    for day_index in range(date_count):
        start_index = day_index * 1440 // step_min
        end_index = start_index + sample_count
        landing_time = first_landing + timedelta(days=day_index)
        window_ephemeris = {
            body: {
                field: values[start_index:end_index]
                for field, values in ephemeris[body].items()
            }
            for body in ("sun", "earth")
        }
        result = build_simulation_result(
            request=template.model_copy(update={"landingTime": landing_time}),
            input_echo={},
            site=site,
            ephemeris=window_ephemeris,
            sun_horizon=sun_horizon,
            earth_horizon=earth_horizon,
            simulation_id=f"calendar-{landing_time.date().isoformat()}",
            created_at=landing_time.isoformat().replace("+00:00", "Z"),
            weights=weights,
        )
        summary = result["summary"]
        days.append(
            {
                "date": landing_time.date().isoformat(),
                "successPct": summary["successPct"],
                "minSocPct": summary["minSocPct"],
                "earthVisiblePct": summary["earthVisiblePct"],
                "longestNightH": summary["longestNightH"],
            }
        )

    best_day = max(days, key=lambda item: item["successPct"])
    grouped_days: dict[str, list[dict[str, Any]]] = {}
    for day in days:
        grouped_days.setdefault(day["date"][:7], []).append(day)
    months = [
        {
            "month": month,
            "goodDays": sum(day["successPct"] >= 80 for day in month_days),
            "bestPct": max(day["successPct"] for day in month_days),
        }
        for month, month_days in sorted(grouped_days.items())
    ]
    return {
        "days": days,
        "best": {
            "date": best_day["date"],
            "successPct": best_day["successPct"],
        },
        "months": months,
    }
