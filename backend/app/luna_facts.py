"""Facts Luna is allowed to talk about.

Everything numeric is computed here, in Python, from data HORIZON already has (the site catalog,
stored simulation results, the horizon profile). The language model only narrates these facts —
it never calculates or looks anything up — so its answers stay checkable on stage.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

from app.sites import SITE_BY_ID, SITES

LUNAR_RADIUS_KM = 1737.4

# Short, conservative history notes for the catalog. Luna may only state mission facts from here.
SITE_NOTES: dict[str, str] = {
    "connecting-ridge": (
        "A ridge linking the rims of Shackleton and de Gerlache craters, a few kilometres from the "
        "south pole. On NASA's 2022 list of 13 candidate regions for the Artemis III crewed landing. "
        "Its height lets it catch sunlight for long stretches while the low ground around it stays dark."
    ),
    "shackleton-rim": (
        "Rim of Shackleton crater (about 21 km across), almost exactly at the lunar south pole and "
        "named after the polar explorer Ernest Shackleton. The crater floor never sees the Sun and is a "
        "prime place to look for water ice; parts of the rim are lit most of the year."
    ),
    "malapert-massif": (
        "A mountain roughly 5 km high near the south pole and one of NASA's 2022 Artemis III candidate "
        "regions. Its height gives good views of Earth, which matters for direct radio contact."
    ),
    "haworth": (
        "Region around Haworth crater, one of NASA's 2022 Artemis III candidate regions. The crater floor "
        "is permanently shadowed, so the landing would be on lit ground next to possible ice deposits."
    ),
    "nobile-rim-1": (
        "Rim of Nobile crater, one of NASA's 2022 Artemis III candidate regions. The Nobile area was also "
        "the planned target of NASA's VIPER ice-prospecting rover, which NASA cancelled in 2024."
    ),
    "mons-mouton": (
        "A flat-topped mountain near the south pole named after Melba Mouton, a NASA mathematician. "
        "Intuitive Machines' IM-2 lander Athena touched down nearby in March 2025, but it ended up on its "
        "side in a small crater and the mission ended early — a reminder of how hard polar terrain and "
        "low Sun angles are for landing."
    ),
    "malapert-a": (
        "Malapert A crater in the south polar region. Intuitive Machines' IM-1 lander Odysseus landed here "
        "in February 2024: the first commercial lunar landing and the first US landing since Apollo 17 in "
        "1972. It tipped onto its side but still sent data for several days."
    ),
    "mare-crisium": (
        "A large basin on the near side. Firefly Aerospace's Blue Ghost Mission 1 landed here upright in "
        "March 2025 and operated through a full lunar day of about two weeks, carrying NASA instruments."
    ),
    "mare-frigoris": (
        "The 'Sea of Cold', a long dark plain in the northern near side. ispace's Resilience lander "
        "(Hakuto-R Mission 2) was lost during its landing attempt here in June 2025."
    ),
    "chandrayaan-3": (
        "ISRO's Chandrayaan-3 lander Vikram touched down here on 23 August 2023, making India the fourth "
        "country to land on the Moon and the first to land this far toward the south pole. Its rover "
        "Pragyan drove around the site; India named the landing point Shiv Shakti."
    ),
    "change-4": (
        "Inside Von Kármán crater on the far side. China's Chang'e-4 made the first ever soft landing on "
        "the far side in January 2019, talking to Earth through the Queqiao relay satellite; its rover "
        "Yutu-2 kept driving for years."
    ),
    "change-6": (
        "In the South Pole–Aitken basin on the far side. China's Chang'e-6 landed here in June 2024 and "
        "brought the first samples from the lunar far side back to Earth."
    ),
    "slim": (
        "Near Shioli crater on the near side. JAXA's SLIM made Japan's first lunar landing in January 2024 "
        "and demonstrated a pinpoint landing within about 100 m of its target, although it came to rest "
        "upside down."
    ),
    "apollo-11": (
        "Tranquility Base in Mare Tranquillitatis. Neil Armstrong and Buzz Aldrin landed here on "
        "20 July 1969 — the first crewed landing on the Moon."
    ),
    "apollo-12": (
        "Oceanus Procellarum. Pete Conrad and Alan Bean landed here in November 1969 within walking "
        "distance of the robotic Surveyor 3 probe, proving pinpoint landing."
    ),
    "apollo-14": (
        "Fra Mauro highlands. Alan Shepard and Edgar Mitchell landed here in February 1971, taking over "
        "the geology goals of the aborted Apollo 13."
    ),
    "apollo-15": (
        "Hadley–Apennine, at the foot of the Apennine mountains next to Hadley Rille. David Scott and "
        "James Irwin landed here in July 1971 and drove the first Lunar Roving Vehicle."
    ),
    "apollo-16": (
        "Descartes Highlands. John Young and Charles Duke landed here in April 1972 — the first crewed "
        "landing in the lunar highlands."
    ),
    "apollo-17": (
        "Taurus–Littrow valley. Eugene Cernan and geologist Harrison Schmitt landed here in December 1972 "
        "— the last time humans walked on the Moon."
    ),
}

COMPASS_16 = [
    "north", "north-northeast", "northeast", "east-northeast",
    "east", "east-southeast", "southeast", "south-southeast",
    "south", "south-southwest", "southwest", "west-southwest",
    "west", "west-northwest", "northwest", "north-northwest",
]


def compass(az_deg: float) -> str:
    return COMPASS_16[int(((az_deg % 360) + 11.25) // 22.5) % 16]


def lunar_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return LUNAR_RADIUS_KM * 2 * math.asin(math.sqrt(min(1.0, h)))


def format_lat_lon(lat: float, lon: float) -> str:
    return f"{abs(lat):.2f}° {'N' if lat >= 0 else 'S'}, {abs(lon):.2f}° {'E' if lon >= 0 else 'W'}"


def region_for(lat: float, lon: float) -> str:
    if lat <= -80:
        return "South polar region"
    if lat >= 80:
        return "North polar region"
    lon_w = ((lon + 180) % 360) - 180
    return "Near side (faces Earth)" if -90 <= lon_w <= 90 else "Far side (never faces Earth)"


def _utc(landing_iso: str, day: float) -> str:
    start = datetime.fromisoformat(landing_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    return (start + timedelta(days=day)).strftime("%Y-%m-%d %H:%M UTC")


def _r(value: Any, digits: int = 1) -> Any:
    return round(value, digits) if isinstance(value, (int, float)) and value is not None else value


# ---------------------------------------------------------------- site


def site_facts(
    *,
    site_id: str | None,
    lat: float,
    lon: float,
    name: str | None,
    terrain: dict[str, Any] | None,
) -> dict[str, Any]:
    site = SITE_BY_ID.get(site_id) if site_id else None
    if site is None:
        # A catalog site picked by coordinates (within 3 km) still gets its story.
        nearest = min(SITES, key=lambda s: lunar_distance_km(lat, lon, s["lat"], s["lon"]))
        nearest_km = lunar_distance_km(lat, lon, nearest["lat"], nearest["lon"])
        if nearest_km <= 3:
            site = nearest
    else:
        nearest, nearest_km = site, 0.0

    facts: dict[str, Any] = {
        "name": site["name"] if site else (name or "Custom point"),
        "coordinates": format_lat_lon(lat, lon),
        "region": region_for(lat, lon),
    }
    if site:
        facts["program"] = site["program"]
        facts["status"] = site["status"]
        if site["id"] in SITE_NOTES:
            facts["history"] = SITE_NOTES[site["id"]]
    else:
        facts["catalog_site"] = "no — a custom point chosen by the user"
        facts["nearest_catalog_site"] = f"{nearest['name']} ({nearest['program']}, {nearest['status']}), {nearest_km:.0f} km away"
        if nearest["id"] in SITE_NOTES:
            facts["nearest_site_history"] = SITE_NOTES[nearest["id"]]

    terrain = terrain or {}
    if terrain.get("elevationM") is not None:
        facts["elevation_m"] = f"{terrain['elevationM']:.0f} m relative to the lunar reference sphere (1737.4 km radius)"
    if terrain.get("slopeDeg") is not None:
        slope = terrain["slopeDeg"]
        facts["slope_deg"] = round(slope, 1)
        facts["slope_assessment"] = (
            "gentle — safe for a lander" if slope < 5 else "moderate — usable with care" if slope <= 10 else "steep — above the 10° tipping limit used for landers"
        )
    if terrain.get("psr") is not None:
        facts["permanent_shadow"] = (
            "yes — this point never sees the Sun (possible water ice, no solar power)"
            if terrain["psr"]
            else "no — the point gets sunlight during part of the lunar day"
        )
    facts["lunar_day"] = "One lunar day lasts about 29.5 Earth days, so most places get ~2 weeks of light then ~2 weeks of night; near the poles the Sun stays within a few degrees of the horizon."
    return facts


def site_template(f: dict[str, Any]) -> str:
    parts = [f"**{f['name']}** lies at {f['coordinates']} in the {f['region'].lower()}."]
    if f.get("history"):
        parts.append(f["history"])
    elif f.get("nearest_catalog_site"):
        parts.append(f"It is not a catalogued landing site; the nearest one is {f['nearest_catalog_site']}.")
    terrain = []
    if "elevation_m" in f:
        terrain.append(f"elevation {f['elevation_m'].split(' relative')[0]}")
    if "slope_deg" in f:
        terrain.append(f"slope {f['slope_deg']}° ({f['slope_assessment']})")
    if "permanent_shadow" in f:
        terrain.append(f"permanent shadow: {f['permanent_shadow']}")
    if terrain:
        parts.append("Terrain here: " + "; ".join(terrain) + ".")
    parts.append("Next step: simulate a landing date to see how sunlight, battery and Earth contact play out.")
    return "\n\n".join(parts)


# ---------------------------------------------------------------- simulation

SCORING_RULES = (
    "Score = weighted sum of three factors. Battery (power): 0 points at a 10% minimum charge, full "
    "points at 40% or more. Earth link (comms): full points when Earth is in view at least 50% of the "
    "mission. Night length: full points if the longest darkness is 72 h or less, 0 points at 168 h or more."
)

FACTOR_NAMES = {"power": "Battery (lowest charge)", "comms": "Earth link (Earth in view)", "night": "Longest night"}
FACTOR_UNITS = {"power": "%", "comms": "%", "night": "h"}


def _runs(flags: list[bool]) -> list[tuple[int, int]]:
    runs, start = [], None
    for i, f in enumerate(flags):
        if f and start is None:
            start = i
        elif not f and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(flags) - 1))
    return runs


def _mission_slice(sim: dict[str, Any]) -> tuple[dict[str, list], int] | None:
    ts = sim.get("timeseries")
    if not ts or not ts.get("day"):
        return None
    mission_days = sim["input"].get("missionDays", 14)
    n = sum(1 for d in ts["day"] if d <= mission_days + 1e-9)
    return ts, max(n, 1)


def sim_base_facts(sim: dict[str, Any]) -> dict[str, Any]:
    s = sim["summary"]
    hw = sim["input"].get("hardware", {})
    facts: dict[str, Any] = {
        "site": sim["site"].get("name") or format_lat_lon(sim["site"]["lat"], sim["site"]["lon"]),
        "coordinates": format_lat_lon(sim["site"]["lat"], sim["site"]["lon"]),
        "landing_time": _utc(sim["input"]["landingTime"], 0),
        "surface_mission_days": sim["input"].get("missionDays"),
        "success_score_pct": s["successPct"],
        "verdict": s["verdict"],
        "sunlit_pct_of_mission": _r(s.get("sunlitPct")),
        "earth_in_view_pct_of_mission": _r(s.get("earthVisiblePct")),
        "lowest_battery_pct": _r(s.get("minSocPct")),
        "lowest_battery_on_mission_day": _r(s.get("minSocAtDay")),
        "longest_darkness_h": _r(s.get("longestNightH")),
        "longest_earth_blackout_h": _r(s.get("longestCommsGapH")),
        "battery_reserve_pct": hw.get("reservePct"),
        "battery_wh": hw.get("batteryWh"),
        "solar_w": hw.get("solarW"),
        "panel_height_m": hw.get("panelHeightM"),
    }
    if s.get("flatHorizonSuccessPct") is not None:
        facts["score_if_terrain_were_flat_pct"] = s["flatHorizonSuccessPct"]
        facts["points_lost_to_local_terrain"] = s["flatHorizonSuccessPct"] - s["successPct"]
    return facts


def sim_score_facts(sim: dict[str, Any]) -> dict[str, Any]:
    facts = sim_base_facts(sim)
    factors = []
    for f in sim.get("factors", []):
        max_points = round(f["weight"] * 100, 1)
        factors.append(
            {
                "factor": FACTOR_NAMES.get(f["key"], f["key"]),
                "measured": f"{_r(f['value'])} {FACTOR_UNITS.get(f['key'], '')}".strip(),
                "points": f["points"],
                "max_points": max_points,
                "points_missing": round(max_points - f["points"], 1),
                "status": "good" if f["ok"] else "weak",
            }
        )
    facts["factors"] = factors
    if factors:
        facts["factor_costing_most_points"] = max(factors, key=lambda x: x["points_missing"])["factor"]
    facts["scoring_rules"] = SCORING_RULES
    return facts


def sim_worst_facts(sim: dict[str, Any]) -> tuple[dict[str, Any], float | None]:
    facts = sim_base_facts(sim)
    s = sim["summary"]
    focus = s.get("minSocAtDay")
    sl = _mission_slice(sim)
    if sl is not None and focus is not None:
        ts, n = sl
        days = ts["day"][:n]
        dark = [v <= 0 for v in ts["sunVisibleFrac"][:n]]
        i_min = min(range(n), key=lambda i: abs(days[i] - focus))
        # The darkness that drains the battery ends at (or just before) the minimum.
        run = next(((a, b) for a, b in _runs(dark) if a <= i_min <= b + 2), None)
        if run:
            a, b = run
            hours = (days[b] - days[a]) * 24 + ts.get("stepMin", 60) / 60
            terrain_steps = sum(1 for i in range(a, b + 1) if ts["sunElDeg"][i] > 0)
            facts["darkness_before_minimum"] = {
                "starts": _utc(sim["input"]["landingTime"], days[a]),
                "starts_mission_day": round(days[a], 1),
                "duration_h": round(hours, 1),
                "cause": (
                    "local terrain blocks the Sun while it is still above the horizon"
                    if terrain_steps > (b - a + 1) / 2
                    else "the Sun is below the horizon (normal lunar night)"
                    if terrain_steps == 0
                    else "mixed: the Sun sets and terrain hides it for part of the time"
                ),
                "share_caused_by_terrain_pct": round(100 * terrain_steps / (b - a + 1)),
            }
        facts["earth_in_view_at_minimum"] = "yes" if ts["earthVisible"][i_min] else "no — no direct radio contact"
        facts["lowest_battery_time"] = _utc(sim["input"]["landingTime"], days[i_min])
    elif focus is not None:
        facts["lowest_battery_time"] = _utc(sim["input"]["landingTime"], focus)
    low = next((e for e in sim.get("events", []) if e["type"] == "BATTERY_LOW"), None)
    facts["battery_falls_below_reserve"] = f"yes, on mission day {low['day']:.1f}" if low else "no"
    facts["mitigation_options"] = "a bigger battery, lower night power draw, panels mounted higher, or a landing date whose darkness falls after the mission ends"
    return facts, focus


def sim_sun_facts(sim: dict[str, Any], horizon: dict[str, Any] | None) -> tuple[dict[str, Any], float | None]:
    facts = sim_base_facts(sim)
    focus = None
    sl = _mission_slice(sim)
    if sl is None:
        facts["terrain_shadow"] = "unknown — this result has no time series"
        return facts, None
    ts, n = sl
    step_h = ts.get("stepMin", 60) / 60
    el, mask, vis, az = ts["sunElDeg"][:n], ts["sunMaskElDeg"][:n], ts["sunVisibleFrac"][:n], ts["sunAzDeg"][:n]
    terrain = [el[i] > 0 and vis[i] <= 0 for i in range(n)]
    night = [el[i] <= 0 for i in range(n)]
    facts["hours_sun_above_horizon_but_hidden_by_terrain"] = round(sum(terrain) * step_h, 1)
    facts["hours_sun_below_horizon"] = round(sum(night) * step_h, 1)
    facts["sun_elevation_range_deg"] = f"{min(el):.1f}° to {max(el):.1f}°"
    runs = _runs(terrain)
    if runs:
        a, b = max(runs, key=lambda r: r[1] - r[0])
        mid = (a + b) // 2
        sun_az = az[mid]
        event: dict[str, Any] = {
            "starts": _utc(sim["input"]["landingTime"], ts["day"][a]),
            "starts_mission_day": round(ts["day"][a], 1),
            "duration_h": round((b - a + 1) * step_h, 1),
            "sun_azimuth_deg": round(sun_az),
            "blocking_ridge_direction": compass(sun_az),
            "ridge_height_above_horizon_deg": round(max(mask[a : b + 1]), 1),
            "sun_height_above_horizon_deg": round(el[mid], 1),
        }
        if horizon and horizon.get("distanceKm") and horizon.get("azimuthDeg"):
            azs = horizon["azimuthDeg"]
            k = min(range(len(azs)), key=lambda i: abs(((azs[i] - sun_az + 180) % 360) - 180))
            d = horizon["distanceKm"][k]
            if d:
                event["ridge_distance_km"] = round(d, 1)
        facts["longest_terrain_shadow"] = event
        facts["terrain_shadow_events"] = len(runs)
        focus = ts["day"][a]
    else:
        facts["longest_terrain_shadow"] = "none — the terrain never hides the Sun while it is above the horizon"
    facts["geometry_note"] = "Near the poles the Sun circles close to the horizon, so a ridge only a few degrees high, even tens of km away, can shade the site."
    return facts, focus


def sim_template(topic: str, f: dict[str, Any]) -> str:
    if topic == "sim-score":
        lines = [f"This mission scores **{f['success_score_pct']}% ({f['verdict'].lower()})**. The factor costing the most points is **{f.get('factor_costing_most_points', 'n/a').lower()}**."]
        for x in f.get("factors", []):
            lines.append(f"- {x['factor']}: {x['measured']} → {x['points']} of {x['max_points']} points ({x['status']}).")
        if f.get("points_lost_to_local_terrain", 0) >= 5:
            lines.append(f"With a flat horizon it would score {f['score_if_terrain_were_flat_pct']}% — local terrain costs {f['points_lost_to_local_terrain']} points.")
        return "\n".join(lines)
    if topic == "sim-worst":
        d = f.get("darkness_before_minimum")
        out = f"The critical moment is **{f.get('lowest_battery_time', 'n/a')}** (mission day {f.get('lowest_battery_on_mission_day')}): the battery bottoms out at **{f['lowest_battery_pct']}%** (reserve {f['battery_reserve_pct']}%)."
        if isinstance(d, dict):
            out += f" It follows {d['duration_h']} h of darkness — {d['cause']}."
        out += f"\n\nEarth in view at that moment: {f.get('earth_in_view_at_minimum', 'unknown')}. Falls below reserve: {f['battery_falls_below_reserve']}."
        return out
    ev = f.get("longest_terrain_shadow")
    out = f"The Sun is above the horizon but hidden by terrain for **{f.get('hours_sun_above_horizon_but_hidden_by_terrain', 0)} h**, versus {f.get('hours_sun_below_horizon', 0)} h of true night."
    if isinstance(ev, dict):
        dist = f", about {ev['ridge_distance_km']} km away" if "ridge_distance_km" in ev else ""
        out += f"\n\nThe longest shadow starts {ev['starts']} and lasts {ev['duration_h']} h: a ridge to the **{ev['blocking_ridge_direction']}**{dist}, rising {ev['ridge_height_above_horizon_deg']}° above the horizon, hides a Sun only {ev['sun_height_above_horizon_deg']}° high."
    else:
        out += "\n\nThe terrain never hides the Sun here — good news for power."
    return out


# ---------------------------------------------------------------- scenarios


def _scenario_kind(base: dict[str, Any], sim: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    b_lat, b_lon = base["site"]["lat"], base["site"]["lon"]
    move_km = lunar_distance_km(b_lat, b_lon, sim["site"]["lat"], sim["site"]["lon"])
    t0 = datetime.fromisoformat(base["input"]["landingTime"].replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(sim["input"]["landingTime"].replace("Z", "+00:00"))
    slip_days = round((t1 - t0).total_seconds() / 86400, 1)
    moved, slipped = move_km > 1, abs(slip_days) >= 0.5
    extra: dict[str, Any] = {}
    if slipped:
        extra["date_change_days"] = slip_days
    if moved:
        extra["site_move_km"] = round(move_km)
    kind = "date slip and site move" if moved and slipped else "site move (same date)" if moved else "date slip (same site)" if slipped else "same as baseline"
    return kind, extra


def scenario_facts(
    items: list[tuple[str, dict[str, Any]]],
    requirements: dict[str, float],
    recommendation: dict[str, Any] | None,
) -> dict[str, Any]:
    min_soc = requirements.get("minSocPct", 20)
    min_earth = requirements.get("minEarthVisiblePct", 50)
    base = items[0][1]
    rows = []
    for idx, (label, sim) in enumerate(items):
        s = sim["summary"]
        misses = []
        if s["minSocPct"] < min_soc:
            misses.append(f"battery minimum {s['minSocPct']:.1f}% is {min_soc - s['minSocPct']:.1f} points below the required {min_soc:.0f}%")
        if s["earthVisiblePct"] < min_earth:
            misses.append(f"Earth in view {s['earthVisiblePct']:.1f}% is {min_earth - s['earthVisiblePct']:.1f} points below the required {min_earth:.0f}%")
        row: dict[str, Any] = {
            "label": label,
            "role": "baseline" if idx == 0 else _scenario_kind(base, sim)[0],
            "site": sim["site"].get("name") or format_lat_lon(sim["site"]["lat"], sim["site"]["lon"]),
            "landing": _utc(sim["input"]["landingTime"], 0),
            "score_pct": s["successPct"],
            "verdict": s["verdict"],
            "lowest_battery_pct": _r(s["minSocPct"]),
            "earth_in_view_pct": _r(s["earthVisiblePct"]),
            "longest_darkness_h": _r(s["longestNightH"]),
            "meets_requirements": "yes" if not misses else "no",
        }
        if idx > 0:
            row.update(_scenario_kind(base, sim)[1])
        if misses:
            row["fails_because"] = misses
        rows.append(row)
    return {
        "requirements": f"battery never below {min_soc:.0f}%, Earth in view at least {min_earth:.0f}% of the mission",
        "scenarios": rows,
        "recommended": (
            {"label": recommendation["label"], "reason_from_app": recommendation.get("reason", "")}
            if recommendation
            else "none — no scenario meets the requirements"
        ),
        "selection_rule": "Among scenarios meeting the requirements the app picks the highest score; if another one on the baseline date is within 3 points, it prefers that one to avoid a launch slip.",
    }


def scenario_template(topic: str, f: dict[str, Any]) -> str:
    rows = f["scenarios"]
    rec = f["recommended"]
    if topic == "scen-decide":
        slips = [r for r in rows if r["role"].startswith("date slip")]
        moves = [r for r in rows if r["role"].startswith("site move")]
        best = lambda rs: max(rs, key=lambda r: (r["meets_requirements"] == "yes", r["score_pct"])) if rs else None
        bs, bm = best(slips), best(moves)
        if isinstance(rec, dict):
            winner = next(r for r in rows if r["label"] == rec["label"])
            head = "Keep the baseline." if winner["role"] == "baseline" else "Slip the date." if winner["role"].startswith("date") else "Move the site." if winner["role"].startswith("site") else f"Go with {winner['label']}."
        else:
            head = "Neither option works yet."
        lines = [f"**{head}**"]
        lines.append(f"- Best date slip: {bs['label']} — {bs['score_pct']}%, meets requirements: {bs['meets_requirements']}." if bs else "- No date-slip scenario in the comparison — try adding 'Slip +2 wk'.")
        lines.append(f"- Best site move: {bm['label']} — {bm['score_pct']}%, meets requirements: {bm['meets_requirements']}." if bm else "- No site-move scenario in the comparison — try 'Other site, same date…'.")
        return "\n".join(lines)
    if isinstance(rec, dict):
        w = next(r for r in rows if r["label"] == rec["label"])
        lines = [f"**{w['label']}** wins with **{w['score_pct']}%**: battery never below {w['lowest_battery_pct']}%, Earth in view {w['earth_in_view_pct']}% of the time."]
    else:
        lines = ["**No scenario meets the requirements** "f"({f['requirements']})."]
    for r in rows:
        if isinstance(rec, dict) and r["label"] == rec["label"]:
            continue
        why = "; ".join(r.get("fails_because", [])) or f"lower score ({r['score_pct']}%)"
        lines.append(f"- {r['label']}: {why}.")
    return "\n".join(lines)
