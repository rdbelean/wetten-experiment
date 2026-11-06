"""Tagesablauf: Kandidaten vorbereiten (prepare) und Wetten platzieren (pick)."""
import os
import time as _time
from datetime import date, timedelta

import requests

from . import config as C
from . import espn, odds_api
from .evaluate import evaluate_event, passes
from .util import day_dir, day_window, iso, log, now_utc, parse_ts, read_json, write_json


# --------------------------------------------------------------------------- Kontext
def standings_context(sports_needed):
    """Tabellenplätze von football-data.org (Free Tier) als Kontext."""
    key = os.environ.get("FOOTBALL_DATA_ORG_KEY")
    out = {}
    if not key:
        return out
    for sk in sports_needed:
        code = C.SPORTS[sk].get("fdorg")
        if not code:
            continue
        try:
            r = requests.get(f"https://api.football-data.org/v4/competitions/{code}/standings",
                             headers={"X-Auth-Token": key}, timeout=20)
            if r.status_code == 429:
                _time.sleep(7)
                continue
            r.raise_for_status()
            table = r.json()["standings"][0]["table"]
            out[sk] = [{"pos": t["position"], "team": t["team"]["name"], "short": t["team"].get("shortName"),
                        "pts": t["points"], "played": t["playedGames"], "gd": t["goalDifference"]} for t in table]
        except Exception as ex:  # noqa: BLE001
            log("football-data.org Fehler", code, ex)
    return out


def _table_pos(table, team):
    from .names import best_match
    if not table:
        return None
    names = {t["team"]: t for t in table}
    names.update({t["short"]: t for t in table if t.get("short")})
    m, _ = best_match(team, list(names))
    if m:
        t = names[m]
        return {"pos": t["pos"], "pts": t["pts"], "played": t["played"], "gd": t["gd"]}
    return None


# --------------------------------------------------------------------------- Quoten holen
def fetch_day_odds(d: date, sports=None):
    frm, to = day_window(d)
    frm = max(frm, now_utc() + timedelta(minutes=C.START_BUFFER_MIN))
    raw = {}
    for sk, cfg in C.SPORTS.items():
        if sports is not None and sk not in sports:
            continue
        try:
            evs = odds_api.events(sk, frm, to)  # kostenlos
        except Exception as ex:  # noqa: BLE001
            log("events Fehler", sk, ex)
            continue
        if not evs:
            continue
        try:
            data = odds_api.odds(sk, cfg["markets"], frm, to)
        except Exception as ex:  # noqa: BLE001
            log("odds Fehler", sk, ex)
            continue
        if data:
            raw[sk] = data
            log(f"{cfg['label']}: {len(data)} Events, Credits übrig {odds_api.credits_remaining()}")
    return raw


def evaluate_all(raw, d: date, adjustments=None):
    outcomes, infos = [], {}
    for sk, events in raw.items():
        for e in events:
            o, info = evaluate_event(e, sk, d, adjustments)
            outcomes += o
            if info:
                infos[e["id"]] = info
    return outcomes, infos


# --------------------------------------------------------------------------- prepare
def prepare(d: date):
    dd = day_dir(d)
    raw = fetch_day_odds(d)
    write_json(dd / "odds_prepare.json", {"fetched_at": iso(now_utc()), "odds": raw})
    outcomes, infos = evaluate_all(raw, d)
    ctx = standings_context(list(raw))
    events = {}
    for o in outcomes:
        ev = events.setdefault(o["event_id"], {
            "event_id": o["event_id"], "sport": o["sport"], "league": o["league"], "group": o["group"],
            "home": o["home"], "away": o["away"], "commence": o["commence"],
            "model": infos.get(o["event_id"]),
            "table_home": _table_pos(ctx.get(o["sport"]), o["home"]),
            "table_away": _table_pos(ctx.get(o["sport"]), o["away"]),
            "best_ev": -1, "outcomes": []})
        ev["outcomes"].append({k: o[k] for k in ("market", "point", "key", "label", "odds", "book_name",
                                                  "fair_market", "model_p", "p", "ev", "tipico_odds", "pinnacle_odds", "n_books")})
        ev["best_ev"] = max(ev["best_ev"], o["ev"])
    ev_list = sorted(events.values(), key=lambda e: -e["best_ev"])
    # Für die Recherche: die interessantesten Events zuerst markieren
    for i, e in enumerate(ev_list):
        e["research_priority"] = "hoch" if e["best_ev"] > 0 and i < 25 else "normal"
    write_json(dd / "candidates.json", {"day": d.isoformat(), "created_at": iso(now_utc()),
                                         "n_events": len(ev_list), "events": ev_list})
    log(f"prepare {d}: {len(ev_list)} Events, {sum(1 for o in outcomes if passes(o))} Value-Kandidaten vor News")
    return ev_list


# --------------------------------------------------------------------------- Einsätze
def allocate(selected, budget=C.DAILY_BUDGET):
    """Kelly-Gewichtung, Deckel 40 €, Mindesteinsatz 2 €, Summe exakt = Budget, 0,50-€-Schritte."""
    n = len(selected)
    if n == 0:
        return []
    cap = max(C.MAX_STAKE, budget / n)
    w = [max(s["kelly"], 0.004) * C.KELLY_FRACTION for s in selected]
    stakes = [0.0] * n
    free = list(range(n))
    remaining = budget
    while free:
        tw = sum(w[i] for i in free)
        over = [i for i in free if remaining * w[i] / tw > cap]
        if not over:
            for i in free:
                stakes[i] = remaining * w[i] / tw
            break
        for i in over:
            stakes[i] = cap
            remaining -= cap
            free.remove(i)
    stakes = [max(2.0, round(s * 2) / 2) for s in stakes]
    diff = round(budget - sum(stakes), 2)
    order = sorted(range(n), key=lambda i: -stakes[i])
    k = 0
    while abs(diff) >= 0.5 and k < 1000:
        i = order[k % n]
        step = 0.5 if diff > 0 else -0.5
        if (step > 0 and stakes[i] + step <= cap) or (step < 0 and stakes[i] + step >= 2.0):
            stakes[i] += step
            diff = round(diff - step, 2)
        k += 1
    for s, st in zip(selected, stakes):
        s["stake"] = round(st, 2)
    return selected


def select(outcomes, now):
    live_ok = [o for o in outcomes if parse_ts(o["commence"]) > now + timedelta(minutes=C.START_BUFFER_MIN)]
    value = sorted((o for o in live_ok if passes(o)), key=lambda o: -o["kelly"])
    chosen, used_events = [], set()
    for o in value:
        if o["event_id"] in used_events:
            continue
        o["kind"] = "value"
        chosen.append(o)
        used_events.add(o["event_id"])
        if len(chosen) >= C.MAX_BETS:
            break
    if len(chosen) < C.MIN_BETS:
        fillers = sorted((o for o in live_ok if o["event_id"] not in used_events and not o["veto"]
                          and C.MIN_ODDS <= o["odds"] <= 3.0 and o["p"] >= 0.45 and o["ev"] >= C.FILLER_MIN_EV),
                         key=lambda o: -o["ev"])
        for o in fillers:
            if o["event_id"] in used_events:
                continue
            o["kind"] = "filler"
            chosen.append(o)
            used_events.add(o["event_id"])
            if len(chosen) >= C.MIN_BETS:
                break
    if len(chosen) < C.MIN_BETS:  # Notfall: Favoriten mit geringster Marge
        rest = sorted((o for o in live_ok if o["event_id"] not in used_events and not o["veto"]
                       and C.MIN_ODDS <= o["odds"] <= 2.5), key=lambda o: -o["ev"])
        for o in rest:
            if o["event_id"] in used_events:
                continue
            o["kind"] = "filler"
            chosen.append(o)
            used_events.add(o["event_id"])
            if len(chosen) >= C.MIN_BETS:
                break
    return chosen


def _reason(o, notes):
    pct = lambda x: f"{x * 100:.1f} %".replace(".", ",")  # noqa: E731
    q = lambda x: f"{x:.2f}".replace(".", ",")  # noqa: E731
    s = f"Faire Marktwahrscheinlichkeit {pct(o['fair_market'])}"
    if o.get("pinnacle_odds"):
        s += f" (Pinnacle {q(o['pinnacle_odds'])})"
    s += "."
    if o.get("model_p") is not None:
        s += f" Tor-Modell {pct(o['model_p'])}."
    if o.get("adj"):
        s += " News-Korrektur " + f"{o['adj'] * 100:+.1f}".replace(".", ",") + " Prozentpunkte."
    s += f" Unser Wert: {pct(o['p'])}. Beste Quote {q(o['odds'])} bei {o['book_name']}"
    s += f" (Median {q(o['median_odds'])}, {o['n_books']} Anbieter), Erwartungswert " + f"{o['ev'] * 100:+.1f}".replace(".", ",") + " %."
    if o.get("kind") == "filler":
        s += " Füllwette: An diesem Tag gab es zu wenige echte Value-Wetten, das Budget wird aber immer komplett gesetzt."
    if notes:
        s += f" Recherche: {notes}"
    return s


# --------------------------------------------------------------------------- pick
def pick(d: date, ledger):
    dd = day_dir(d)
    if read_json(dd / "picks.json"):
        log("Tag", d, "bereits platziert")
        return False
    adj_doc = read_json(dd / "adjustments.json", {}) or {}
    adjustments = adj_doc.get("events", {})
    now = now_utc()

    prep = read_json(dd / "odds_prepare.json")
    if prep and (now - parse_ts(prep["fetched_at"])).total_seconds() < 6 * 3600:
        raw = prep["odds"]
    else:
        raw = fetch_day_odds(d)
    outcomes, _ = evaluate_all(raw, d, adjustments)
    # Für aussichtsreiche Sportarten frische Quoten holen (spart Credits)
    hot = sorted({o["sport"] for o in outcomes if o["ev"] > -0.005})
    if prep and hot:
        fresh = fetch_day_odds(d, sports=set(hot))
        raw = {**raw, **fresh}
        outcomes, _ = evaluate_all(raw, d, adjustments)

    chosen = select(outcomes, now)
    allocate(chosen)
    bets = []
    for i, o in enumerate(chosen, 1):
        cfg = C.SPORTS[o["sport"]]
        e = espn.find_event(cfg.get("espn"), o["home"], o["away"], o["commence"])
        notes = (adjustments.get(o["event_id"]) or {}).get("notes")
        bet = {
            "id": f"{d.isoformat()}-{i:02d}", "day": d.isoformat(), "placed_at": iso(now), "status": "open",
            **{k: o[k] for k in ("event_id", "sport", "league", "group", "home", "away", "commence", "market", "point",
                                 "key", "label", "odds", "book", "book_name", "median_odds", "tipico_odds", "pinnacle_odds",
                                 "n_books", "fair_market", "model_p", "adj", "p", "ev", "kelly", "books", "kind", "stake")},
            "potential_payout": round(o["stake"] * o["odds"], 2),
            "reason": _reason(o, notes), "research": notes,
            "espn": {"path": cfg.get("espn"), "id": e["id"]} if e else None,
            "closing": None, "result": None, "payout": None, "profit": None, "clv": None, "analysis": None,
        }
        bets.append(bet)
    near = sorted((o for o in outcomes if o["event_id"] not in {b["event_id"] for b in bets}),
                  key=lambda o: -o["ev"])[:12]
    write_json(dd / "picks.json", {
        "day": d.isoformat(), "placed_at": iso(now), "n_outcomes": len(outcomes),
        "n_value": sum(1 for o in outcomes if passes(o)), "adjustments_used": bool(adjustments),
        "bets": [b["id"] for b in bets],
        "near_misses": [{k: o[k] for k in ("home", "away", "league", "label", "odds", "book_name", "p", "ev", "commence")} for o in near],
    })
    ledger["bets"].extend(bets)
    log(f"pick {d}: {len(bets)} Wetten, Einsatz {sum(b['stake'] for b in bets):.2f} €")
    return True
