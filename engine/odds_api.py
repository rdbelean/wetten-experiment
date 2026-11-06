"""Client für The Odds API (Free Tier: 500 Credits/Monat) mit Credit-Buchhaltung."""
import os

import requests

from . import config as C
from .util import iso, log, now_utc, read_json, write_json

BASE = "https://api.the-odds-api.com/v4"


def _meta():
    return read_json(C.META, {}) or {}


def _record(resp, path):
    m = _meta()
    rem = resp.headers.get("x-requests-remaining")
    used = resp.headers.get("x-requests-used")
    last = resp.headers.get("x-requests-last")
    if rem is not None:
        m["credits_remaining"] = int(float(rem))
        m["credits_used"] = int(float(used or 0))
    calls = m.setdefault("api_calls", [])
    calls.append({"t": iso(now_utc()), "path": path.split("?")[0], "cost": int(float(last or 0))})
    m["api_calls"] = calls[-200:]
    write_json(C.META, m)


def _get(path, **params):
    key = os.environ.get("ODDS_API_KEY")
    if not key:
        raise RuntimeError("ODDS_API_KEY fehlt")
    params["apiKey"] = key
    r = requests.get(f"{BASE}{path}", params=params, timeout=30)
    _record(r, path)
    if r.status_code == 422 or r.status_code == 404:
        log("odds-api", r.status_code, path, r.text[:200])
        return []
    r.raise_for_status()
    return r.json()


def credits_remaining():
    return _meta().get("credits_remaining")


def events(sport, frm, to):
    """Kostenlos: Event-Liste ohne Quoten."""
    return _get(f"/sports/{sport}/events", commenceTimeFrom=iso(frm), commenceTimeTo=iso(to), dateFormat="iso")


def odds(sport, markets, frm=None, to=None, event_ids=None):
    params = dict(regions="eu", markets=markets, oddsFormat="decimal", dateFormat="iso")
    if frm:
        params["commenceTimeFrom"] = iso(frm)
    if to:
        params["commenceTimeTo"] = iso(to)
    if event_ids:
        params["eventIds"] = ",".join(event_ids)
    rem = credits_remaining()
    if rem is not None and rem < 15:
        log("WARNUNG: kaum noch API-Credits, überspringe", sport)
        return []
    return _get(f"/sports/{sport}/odds", **params)


def scores(sport, days_from=2):
    return _get(f"/sports/{sport}/scores", daysFrom=days_from, dateFormat="iso")
