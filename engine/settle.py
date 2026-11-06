"""Schlussquoten (CLV) erfassen und Wetten abrechnen."""
from collections import defaultdict
from datetime import timedelta

from . import config as C
from . import espn, odds_api
from .evaluate import evaluate_event
from .names import similarity
from .util import iso, log, now_utc, parse_ts

FINAL = {"STATUS_FINAL", "STATUS_FULL_TIME", "STATUS_FINAL_OT", "STATUS_FINAL_SO", "STATUS_FINAL_PEN", "STATUS_FINAL_AET"}
VOID = {"STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_ABANDONED"}


# --------------------------------------------------------------------------- Closing Line
def capture_closing(ledger):
    """Kurz vor Anpfiff Quoten erneut holen -> Closing Line Value messen."""
    now = now_utc()
    due = defaultdict(list)
    for b in ledger["bets"]:
        if b["status"] != "open" or b.get("closing"):
            continue
        t = parse_ts(b["commence"])
        if now < t - timedelta(minutes=50):
            continue
        if now > t:
            b["closing"] = {"missed": True}
            continue
        due[b["sport"]].append(b)
    changed = False
    for sk, bets in due.items():
        markets = ",".join(sorted({b["market"] for b in bets}))
        data = odds_api.odds(sk, markets, event_ids=sorted({b["event_id"] for b in bets}))
        by_id = {e["id"]: e for e in data or []}
        for b in bets:
            e = by_id.get(b["event_id"])
            if not e:
                continue
            outs, _ = evaluate_event(e, sk, parse_ts(b["commence"]).date())
            match = [o for o in outs if o["market"] == b["market"] and o["key"] == b["key"] and o["point"] == b["point"]]
            if not match:
                continue
            o = match[0]
            b["closing"] = {"t": iso(now), "fair_p": o["fair_market"], "pinnacle_odds": o["pinnacle_odds"],
                            "best_odds": o["odds"], "fair_odds": round(1 / o["fair_market"], 3)}
            b["clv"] = round(b["odds"] * o["fair_market"] - 1, 4)
            changed = True
            log(f"Closing {b['id']}: unsere Quote {b['odds']} vs fair {1 / o['fair_market']:.2f} → CLV {b['clv']:+.1%}")
    return changed


# --------------------------------------------------------------------------- Abrechnung
def grade(b, hs, as_):
    k, pt = b["key"], b["point"]
    if b["market"] == "h2h":
        res = "home" if hs > as_ else "away" if as_ > hs else "draw"
        return "won" if res == k else "lost"
    if b["market"] == "totals":
        tot = hs + as_
        if tot == pt:
            return "push"
        return "won" if (tot > pt) == (k == "over") else "lost"
    if b["market"] == "spreads":
        # point = Handicap des Heimteams
        margin = (hs - as_) + pt
        if margin == 0:
            return "push"
        return "won" if (margin > 0) == (k == "home") else "lost"
    return None


def _close(b, status, hs=None, as_=None, source=None):
    b["status"] = status
    b["result"] = {"home": hs, "away": as_, "source": source, "t": iso(now_utc())}
    b["payout"] = round(b["stake"] * b["odds"], 2) if status == "won" else b["stake"] if status in ("push", "void") else 0.0
    b["profit"] = round(b["payout"] - b["stake"], 2)
    b["auto_analysis"] = auto_analysis(b)
    log(f"Abgerechnet {b['id']} {b['label']}: {status} {hs}:{as_} → {b['profit']:+.2f} €")


def settle(ledger):
    now = now_utc()
    changed = False
    fallback = defaultdict(list)
    for b in ledger["bets"]:
        if b["status"] != "open":
            continue
        t = parse_ts(b["commence"])
        dur = C.SPORTS[b["sport"]]["dur"]
        if now < t + timedelta(hours=dur):
            continue
        done = False
        if b.get("espn"):
            e = espn.get_event(b["espn"]["path"], b["espn"]["id"], b["commence"])
            if e and (e["status"] in FINAL or e["completed"]) and e["home_score"] is not None:
                hs, as_ = e["home_score"], e["away_score"]
                _close(b, grade(b, hs, as_), hs, as_, "ESPN")
                done = changed = True
            elif e and e["status"] in VOID:
                _close(b, "void", source="ESPN")
                done = changed = True
        if not done and now > t + timedelta(hours=dur + 2.5):
            fallback[b["sport"]].append(b)
    for sk, bets in fallback.items():
        try:
            data = odds_api.scores(sk, days_from=3)
        except Exception as ex:  # noqa: BLE001
            log("scores Fehler", sk, ex)
            continue
        by_id = {e["id"]: e for e in data or []}
        for b in bets:
            e = by_id.get(b["event_id"])
            if not e or not e.get("completed") or not e.get("scores"):
                if now > parse_ts(b["commence"]) + timedelta(hours=72):
                    _close(b, "void", source="kein Ergebnis nach 72h")
                    changed = True
                continue
            sc = {s["name"]: int(float(s["score"])) for s in e["scores"]}
            hs = sc.get(b["home"]); as_ = sc.get(b["away"])
            if hs is None or as_ is None:
                names = list(sc)
                hs = sc[max(names, key=lambda n: similarity(n, b["home"]))]
                as_ = sc[max(names, key=lambda n: similarity(n, b["away"]))]
            _close(b, grade(b, hs, as_), hs, as_, "The Odds API")
            changed = True
    return changed


def auto_analysis(b):
    """Automatische Kurz-Auswertung: Können (CLV) vs. Glück (Ergebnis)."""
    clv = b.get("clv")
    st = b["status"]
    if st in ("void", "push"):
        return "Einsatz zurück (Push/Absage) – neutral."
    good_price = clv is not None and clv > 0
    if clv is None:
        price_txt = "Keine Schlussquote erfasst, daher keine CLV-Bewertung."
    else:
        price_txt = (f"Unsere Quote war {abs(clv) * 100:.1f} % {'besser' if good_price else 'schlechter'} als der faire Schlusskurs"
                     + (" – der Markt hat sich in unsere Richtung bewegt." if good_price else " – der Markt hat gegen uns gearbeitet."))
    if clv is None:
        verdict = "Gewonnen." if st == "won" else "Verloren."
    elif st == "won":
        verdict = "Verdienter Treffer." if good_price else "Gewonnen, aber eher mit Glück – der Preis war am Ende nicht gut."
    else:
        verdict = ("Richtige Entscheidung, falsches Ergebnis (Varianz). Langfristig sind solche Wetten profitabel."
                   if good_price else "Fehleinschätzung: Markt und Ergebnis lagen gegen uns.")
    return f"{verdict} {price_txt}"
