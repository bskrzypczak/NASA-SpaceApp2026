"""POST /luna — Luna, the AI explainer.

The answer streams as NDJSON (one JSON object per line):
  {"type":"meta","source":"ai"|"template","cached":bool,"focusDay":float|null,"model":str|null}
  {"type":"delta","text":"..."}            (repeated)
  {"type":"done"}  or  {"type":"error","message":"..."}

Without GROQ_API_KEY (or when Groq fails before the first word) Luna answers from a template built
from the same facts, so the demo never shows an empty panel.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from collections import OrderedDict
from typing import Any, AsyncIterator, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api_utils import API_PREFIX
from app.horizon_source import fetch_horizon
from app.luna_facts import (
    scenario_facts,
    scenario_template,
    sim_score_facts,
    sim_sun_facts,
    sim_template,
    sim_worst_facts,
    site_facts,
    site_template,
)
from app.luna_prompts import SYSTEM, TASKS
from app.simulation_routes import get_simulation

logger = logging.getLogger(__name__)
router = APIRouter(prefix=API_PREFIX)

Topic = Literal["site-intro", "sim-score", "sim-worst", "sim-sun", "scen-why", "scen-decide"]


class LunaTerrain(BaseModel):
    elevationM: float | None = None
    slopeDeg: float | None = None
    psr: bool | None = None


class LunaScenario(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    simulationId: str


class LunaRecommendation(BaseModel):
    label: str
    reason: str | None = None


class LunaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: Topic
    # site-intro
    siteId: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=360)
    name: str | None = Field(default=None, max_length=120)
    terrain: LunaTerrain | None = None
    # sim-*
    simulationId: str | None = None
    # scen-*
    scenarios: list[LunaScenario] | None = Field(default=None, min_length=2, max_length=4)
    requirements: dict[str, float] | None = None
    recommendation: LunaRecommendation | None = None
    # Skip the answer cache ("Ask again").
    refresh: bool = False


# ---------------------------------------------------------------- config


def _config() -> dict[str, Any]:
    return {
        "api_key": os.getenv("GROQ_API_KEY", "").strip(),
        "model": os.getenv("LUNA_MODEL", "qwen/qwen3.8-27b").strip(),
        "temperature": float(os.getenv("LUNA_TEMPERATURE", "0.4")),
        "max_tokens": int(os.getenv("LUNA_MAX_TOKENS", "2048")),
        "reasoning_effort": os.getenv("LUNA_REASONING_EFFORT", "medium").strip(),
        "reasoning_format": os.getenv("LUNA_REASONING_FORMAT", "hidden").strip(),
        "timeout_s": float(os.getenv("LUNA_TIMEOUT_S", "45")),
    }


_client = None
_client_key = None


def _groq(api_key: str, timeout_s: float):
    global _client, _client_key
    if _client is None or _client_key != api_key:
        from groq import AsyncGroq  # imported lazily: the backend runs without the package

        _client = AsyncGroq(api_key=api_key, timeout=timeout_s, max_retries=1)
        _client_key = api_key
    return _client


# ---------------------------------------------------------------- answer cache

_CACHE: OrderedDict[str, str] = OrderedDict()
_CACHE_MAX = 200


def _cache_key(req: LunaRequest, model: str) -> str:
    raw = json.dumps(req.model_dump(exclude={"refresh"}), sort_keys=True) + model
    return hashlib.sha256(raw.encode()).hexdigest()


def _remember(key: str, text: str) -> None:
    _CACHE[key] = text
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


# ---------------------------------------------------------------- facts


async def _facts(req: LunaRequest) -> tuple[dict[str, Any], str, float | None]:
    """Return (facts, template answer, timeline day to focus)."""
    if req.topic == "site-intro":
        if req.lat is None or req.lon is None:
            raise _bad("lat and lon are required for site-intro.", "lat")
        lon = ((req.lon + 180) % 360) - 180
        facts = site_facts(
            site_id=req.siteId,
            lat=req.lat,
            lon=lon,
            name=req.name,
            terrain=req.terrain.model_dump() if req.terrain else None,
        )
        return facts, site_template(facts), None

    if req.topic.startswith("sim-"):
        if not req.simulationId:
            raise _bad("simulationId is required.", "simulationId")
        sim = await get_simulation(req.simulationId)
        if req.topic == "sim-score":
            facts, focus = sim_score_facts(sim), None
        elif req.topic == "sim-worst":
            facts, focus = sim_worst_facts(sim)
        else:
            horizon = None
            try:
                hw = sim["input"].get("hardware", {})
                horizon = await asyncio.wait_for(
                    fetch_horizon(sim["site"]["lat"], sim["site"]["lon"], hw.get("panelHeightM", 2.0), 0.5),
                    timeout=20,
                )
            except Exception as exc:  # the ridge distance is a nice-to-have
                logger.info("Luna: horizon unavailable for ridge distance: %s", exc)
            facts, focus = sim_sun_facts(sim, horizon)
        return facts, sim_template(req.topic, facts), focus

    if not req.scenarios:
        raise _bad("scenarios are required.", "scenarios")
    sims = await asyncio.gather(*(get_simulation(s.simulationId) for s in req.scenarios))
    facts = scenario_facts(
        [(s.label, sim) for s, sim in zip(req.scenarios, sims)],
        req.requirements or {},
        req.recommendation.model_dump() if req.recommendation else None,
    )
    return facts, scenario_template(req.topic, facts), None


def _bad(message: str, field: str) -> HTTPException:
    return HTTPException(400, detail={"code": "VALIDATION_ERROR", "message": message, "field": field})


# ---------------------------------------------------------------- streaming


class _ThinkFilter:
    """Drops <think>…</think> blocks in case the model streams its reasoning inline."""

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, text: str) -> str:
        self.buf += text
        out = []
        while self.buf:
            if self.inside:
                end = self.buf.find("</think>")
                if end < 0:
                    self.buf = self.buf[-8:]
                    break
                self.buf = self.buf[end + 8 :]
                self.inside = False
            else:
                start = self.buf.find("<think>")
                if start < 0:
                    # Hold back a trailing "<", "<th"… that may be the start of a tag split across chunks.
                    lt = self.buf.rfind("<")
                    keep = lt if lt >= 0 and "<think>".startswith(self.buf[lt:]) else len(self.buf)
                    out.append(self.buf[:keep])
                    self.buf = self.buf[keep:]
                    break
                out.append(self.buf[:start])
                self.buf = self.buf[start + 7 :]
                self.inside = True
        return "".join(out)

    def flush(self) -> str:
        rest, self.buf = ("" if self.inside else self.buf), ""
        return rest


def _line(obj: dict[str, Any]) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode()


async def _chunks(text: str, size: int = 24) -> AsyncIterator[str]:
    for i in range(0, len(text), size):
        yield text[i : i + size]
        await asyncio.sleep(0.012)


async def _groq_stream(cfg: dict[str, Any], topic: str, facts: dict[str, Any]) -> AsyncIterator[str]:
    client = _groq(cfg["api_key"], cfg["timeout_s"])
    kwargs: dict[str, Any] = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": f"{TASKS[topic]}\n\nFACTS:\n{json.dumps(facts, ensure_ascii=False, indent=1)}",
            },
        ],
        "temperature": cfg["temperature"],
        "max_completion_tokens": cfg["max_tokens"],
        "top_p": 1,
        "stream": True,
    }
    if cfg["reasoning_effort"]:
        kwargs["reasoning_effort"] = cfg["reasoning_effort"]
    if cfg["reasoning_format"]:
        kwargs["reasoning_format"] = cfg["reasoning_format"]
    try:
        stream = await client.chat.completions.create(**kwargs)
    except Exception as exc:
        # Some models reject reasoning options: try once without them.
        if "reasoning" not in str(exc).lower():
            raise
        kwargs.pop("reasoning_effort", None)
        kwargs.pop("reasoning_format", None)
        stream = await client.chat.completions.create(**kwargs)
    async for chunk in stream:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content


@router.post("/luna")
async def ask_luna(req: LunaRequest) -> StreamingResponse:
    facts, template, focus = await _facts(req)  # 400/404 surface as normal JSON errors
    cfg = _config()
    key = _cache_key(req, cfg["model"] if cfg["api_key"] else "template")

    async def body() -> AsyncIterator[bytes]:
        meta = {"type": "meta", "focusDay": focus, "model": None, "cached": False}
        cached = None if req.refresh else _CACHE.get(key)
        if cached is not None:
            yield _line({**meta, "source": "ai" if cfg["api_key"] else "template", "cached": True, "model": cfg["model"] if cfg["api_key"] else None})
            async for part in _chunks(cached, 64):
                yield _line({"type": "delta", "text": part})
            yield _line({"type": "done"})
            return

        if cfg["api_key"]:
            written: list[str] = []
            think = _ThinkFilter()
            sent_meta = False
            try:
                async for part in _groq_stream(cfg, req.topic, facts):
                    text = think.feed(part)
                    if not text:
                        continue
                    if not sent_meta:
                        text = text.lstrip()
                        if not text:
                            continue
                        yield _line({**meta, "source": "ai", "model": cfg["model"]})
                        sent_meta = True
                    written.append(text)
                    yield _line({"type": "delta", "text": text})
                tail = think.flush()
                if tail and sent_meta:
                    written.append(tail)
                    yield _line({"type": "delta", "text": tail})
                if sent_meta:
                    _remember(key, "".join(written).strip())
                    yield _line({"type": "done"})
                    return
                logger.warning("Luna: empty answer from %s, using the template", cfg["model"])
            except Exception as exc:
                logger.warning("Luna: Groq request failed (%s), using the template", exc)
                if sent_meta:
                    yield _line({"type": "error", "message": "Luna lost the connection mid-answer. Try again."})
                    return

        yield _line({**meta, "source": "template"})
        async for part in _chunks(template):
            yield _line({"type": "delta", "text": part})
        if not cfg["api_key"]:
            _remember(key, template)
        yield _line({"type": "done"})

    return StreamingResponse(
        body(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/luna/status")
async def luna_status() -> dict[str, Any]:
    cfg = _config()
    return {"enabled": bool(cfg["api_key"]), "model": cfg["model"] if cfg["api_key"] else None}
