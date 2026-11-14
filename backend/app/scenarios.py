from datetime import timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.simulation import SimulationRequest


class ScenarioSpec(SimulationRequest):
    label: str = Field(min_length=1, max_length=80)
    includeTimeseries: Literal[False] = False


class ScenarioRequirements(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    minSocPct: float = Field(default=20, ge=0, le=100)
    minEarthVisiblePct: float = Field(default=50, ge=0, le=100)


class ScenarioCompareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenarios: list[ScenarioSpec] = Field(min_length=2, max_length=4)
    requirements: ScenarioRequirements = Field(
        default_factory=ScenarioRequirements
    )


def meets_requirements(
    summary: dict, requirements: ScenarioRequirements
) -> bool:
    return (
        summary["minSocPct"] >= requirements.minSocPct
        and summary["earthVisiblePct"] >= requirements.minEarthVisiblePct
    )


def choose_recommendation(
    scenarios: list[ScenarioSpec], results: list[dict]
) -> dict | None:
    eligible = [
        index
        for index, result in enumerate(results)
        if result["meetsRequirements"]
    ]
    if not eligible:
        return None

    best_score = max(
        results[index]["summary"]["successPct"] for index in eligible
    )
    close_candidates = [
        index
        for index in eligible
        if best_score - results[index]["summary"]["successPct"] < 3
    ]
    baseline_date = scenarios[0].landingTime.astimezone(timezone.utc).date()
    same_date_candidates = [
        index
        for index in close_candidates
        if scenarios[index].landingTime.astimezone(timezone.utc).date()
        == baseline_date
    ]
    selected_index = max(
        same_date_candidates or close_candidates,
        key=lambda index: results[index]["summary"]["successPct"],
    )
    selected = results[selected_index]
    score = selected["summary"]["successPct"]
    if same_date_candidates:
        reason = f"Scores {score}% on the baseline date — no launch slip needed."
    else:
        reason = f"Scores {score}% and meets all requirements."
    return {"label": selected["label"], "reason": reason}
