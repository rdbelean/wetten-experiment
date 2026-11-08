"""Kostenlose Ergebnisse/Live-Stände über die öffentliche ESPN-Scoreboard-API."""
from datetime import timedelta

import requests

from .names import similarity
from .util import log, parse_ts

BASE = "https://site.api.espn.com/apis/site/v2/sports"
_cache = {}


def scoreboard(path, day_str):
    """day_str: YYYYMMDD (ESPN-Tag, US-Zeit)."""
    key = (path, day_str)
    if key in _cache:
        return _cache[key]
    try:
        r = requests.get(f"{BASE}/{path}/scoreboard", params={"dates": day_str, "limit": 300}, timeout=20)
        r.raise_for_status()
        out = []
        for e in r.json().get("events", []):
            c = e["competitions"][0]
            teams = {x["homeAway"]: x for x in c["competitors"]}
            out.append({
                "id": e["id"], "date": e["date"],
                "status": e["status"]["type"]["name"],
                "completed": e["status"]["type"].get("completed", False),
                "detail": e["status"]["type"].get("shortDetail", ""),
                "home": teams["home"]["team"]["displayName"], "away": teams["away"]["team"]["displayName"],
                "home_score": _int(teams["home"].get("score")), "away_score": _int(teams["away"].get("score")),
                "goals": _goals(c, teams),
            })
    except Exception as ex:  # noqa: BLE001
        log("espn Fehler", path, day_str, ex)
        out = []
    _cache[key] = out
    return out


def _goals(c, teams):
    """Tore mit Minute und Seite (nur Fußball liefert das). Eigentore werden über das Endergebnis korrigiert."""
    hid = teams["home"]["team"]["id"]
    out = []
    for d in c.get("details") or []:
        if not d.get("scoringPlay"):
            continue
        try:
            minute = int(str(d["clock"]["displayValue"]).split("'")[0])
        except (KeyError, ValueError):
            minute = 0
        out.append({"min": minute, "side": "home" if d.get("team", {}).get("id") == hid else "away", "og": bool(d.get("ownGoal"))})
    hs, as_ = _int(teams["home"].get("score")), _int(teams["away"].get("score"))
    if out and sum(g["side"] == "home" for g in out) != hs:
        for g in out:
            if g["og"]:
                g["side"] = "away" if g["side"] == "home" else "home"
    return out


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _days_around(ts):
    d = parse_ts(ts)
    return sorted({(d + timedelta(hours=h)).strftime("%Y%m%d") for h in (-8, 0, 8)})


def find_event(path, home, away, commence):
    """Event per Anstoßzeit (±3h) + Namensähnlichkeit finden."""
    if not path:
        return None
    t0 = parse_ts(commence)
    best, best_s = None, 0
    for day in _days_around(commence):
        for e in scoreboard(path, day):
            if abs((parse_ts(e["date"]) - t0).total_seconds()) > 3 * 3600:
                continue
            s = similarity(home, e["home"]) + similarity(away, e["away"])
            if s > best_s:
                best, best_s = e, s
    return best if best_s >= 1.1 else None


def get_event(path, event_id, commence):
    for day in _days_around(commence):
        for e in scoreboard(path, day):
            if e["id"] == event_id:
                return e
    return None
