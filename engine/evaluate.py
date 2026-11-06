"""Aus Rohquoten eines Events faire Wahrscheinlichkeiten, Modellwerte und Erwartungswerte berechnen."""
import statistics
from datetime import date

from . import config as C
from .devig import margin, power
from .model import TeamModel, get_model


def _label(market, key, point, home, away, sport_group):
    unit = "Tore" if sport_group == "Fußball" else "Punkte"
    if sport_group == "Eishockey":
        unit = "Tore"
    if market == "h2h":
        return {"home": f"Sieg {home}", "away": f"Sieg {away}", "draw": "Unentschieden"}[key]
    if market == "totals":
        return f"{'Über' if key == 'over' else 'Unter'} {point:g} {unit}"
    if market == "spreads":
        team = home if key == "home" else away
        return f"{team} {point:+g} (Handicap)"
    return key


def _collect(event, soccer=True):
    """-> {(market, point): {"keys": [...], "books": {book: {key: price}}, "lay": {book: {key: price}}}}"""
    home, away = event["home_team"], event["away_team"]
    mk = {}
    for b in event.get("bookmakers", []):
        bk = b["key"]
        for m in b.get("markets", []):
            mkey = m["key"]
            base = "h2h" if mkey in ("h2h", "h2h_lay") else mkey
            prices, point = {}, None
            for o in m["outcomes"]:
                name = o["name"]
                if base == "h2h":
                    k = "home" if name == home else "away" if name == away else "draw" if name == "Draw" else None
                elif base == "totals":
                    k = "over" if name == "Over" else "under" if name == "Under" else None
                    point = o.get("point")
                elif base == "spreads":
                    k = "home" if name == home else "away" if name == away else None
                    if k == "home":
                        point = o.get("point")
                else:
                    k = None
                if k:
                    prices[k] = float(o["price"])
            if not prices or (base != "h2h" and point is None):
                continue
            if base == "h2h" and "draw" in prices and not soccer:
                base = "h2h3"  # 3-Wege (reguläre Spielzeit) bei US-Sport: anderer Markt, nicht mischen
            slot = mk.setdefault((base, point), {"books": {}, "lay": {}})
            (slot["lay"] if mkey == "h2h_lay" else slot["books"])[bk] = prices
    return mk


def _placeable(book, price):
    c = C.EXCHANGE_COMMISSION.get(book)
    return round(1 + (price - 1) * (1 - c), 3) if c else price


def evaluate_event(event, sport_key, today: date, adjustments=None):
    cfg = C.SPORTS[sport_key]
    home, away = event["home_team"], event["away_team"]
    markets = _collect(event, soccer=cfg["group"] == "Fußball")
    # US-Sport: Buchmacher mit 3-Wege-Siegwette rechnen meist nach regulärer Spielzeit ab
    # (auch Tore/Punkte). Damit nichts vermischt wird, fliegen sie bei diesen Sportarten raus.
    regulation_books = set()
    for (mn, _pt), slot in markets.items():
        if mn == "h2h3":
            regulation_books |= set(slot["books"]) | set(slot["lay"])
    adj = (adjustments or {}).get(event["id"], {}) if adjustments else {}

    # Modell nur für Club-Fußball mit football-data.co.uk-Daten
    model_pr, model = None, None
    if cfg.get("fd"):
        model = get_model(cfg["fd"], today)
        if model:
            model_pr = model.probs(home, away)

    w_model = C.MODEL_WEIGHT[cfg["tier"]]
    outcomes = []
    for (mname, point), slot in markets.items():
        if mname == "h2h3":
            continue
        if mname == "h2h":
            keys = ["home", "draw", "away"] if cfg["group"] == "Fußball" else ["home", "away"]
        elif mname == "spreads":
            keys = ["home", "away"]
        else:
            keys = ["over", "under"]
        books = {bk: p for bk, p in slot["books"].items() if set(p) == set(keys) and bk not in regulation_books}
        if len(books) < C.MIN_BOOKS:
            continue

        comps, weights = [], []
        pin = books.get("pinnacle")
        if pin:
            comps.append(dict(zip(keys, power([pin[k] for k in keys])))); weights.append(C.W_PINNACLE)
        # Börse: Mittelwert aus Back und Lay ~ faire Quote fast ohne Marge
        ex_list = []
        for ex in C.EXCHANGES:
            back, lay = books.get(ex), slot["lay"].get(ex)
            if back and lay and all(k in lay for k in keys):
                mids = [2 / (1 / back[k] + 1 / lay[k]) for k in keys]
                s = sum(1 / m for m in mids)
                ex_list.append({k: (1 / m) / s for k, m in zip(keys, mids)})
        if ex_list:
            comps.append({k: statistics.mean(e[k] for e in ex_list) for k in keys}); weights.append(C.W_EXCHANGE)
        dv = [dict(zip(keys, power([p[k] for k in keys]))) for bk, p in books.items() if bk not in C.EXCHANGES]
        if len(dv) >= 3:
            med = {k: statistics.median(d[k] for d in dv) for k in keys}
            s = sum(med.values())
            comps.append({k: v / s for k, v in med.items()}); weights.append(C.W_CONSENSUS)
        if not comps:
            continue
        wsum = sum(weights)
        fair = {k: sum(c[k] * w for c, w in zip(comps, weights)) / wsum for k in keys}

        # Modell einmischen
        mp = None
        if model_pr:
            if mname == "h2h" and len(keys) == 3:
                mp = {k: model_pr[k] for k in keys}
            elif mname == "totals" and point is not None and not float(point).is_integer() and (point * 2) % 1 == 0:
                over, _ = TeamModel.p_over(model_pr, point)
                mp = {"over": over, "under": 1 - over}
        final = dict(fair)
        if mp:
            final = {k: (1 - w_model) * fair[k] + w_model * mp[k] for k in keys}

        # Claude-News-Korrektur
        adj_m = (adj.get(mname) or {}) if isinstance(adj, dict) else {}
        applied = {}
        if adj_m:
            for k in keys:
                d = max(-C.ADJ_CAP, min(C.ADJ_CAP, float(adj_m.get(k, 0) or 0)))
                if d:
                    final[k] = final[k] + d
                    applied[k] = round(d, 4)
            final = {k: min(0.98, max(0.01, v)) for k, v in final.items()}
            s = sum(final.values())
            final = {k: v / s for k, v in final.items()}

        for k in keys:
            raw = sorted(((_placeable(bk, p[k]), bk) for bk, p in books.items()), reverse=True)
            prices = [r[0] for r in raw]
            med = statistics.median(prices)
            best, best_bk = raw[0]
            outlier = False
            if len(raw) > 1 and best > med * C.OUTLIER_RATIO:
                outlier = True
                best, best_bk = raw[1]
            p = final[k]
            ev = p * best - 1
            outcomes.append({
                "event_id": event["id"], "sport": sport_key, "league": cfg["label"], "group": cfg["group"],
                "home": home, "away": away, "commence": event["commence_time"],
                "market": mname, "point": point, "key": k,
                "label": _label(mname, k, point, home, away, cfg["group"]),
                "odds": round(best, 3), "book": best_bk, "book_name": C.BOOK_NAMES.get(best_bk, best_bk),
                "outlier_skipped": outlier, "median_odds": round(med, 3),
                "tipico_odds": books.get("tipico_de", {}).get(k),
                "pinnacle_odds": (pin or {}).get(k),
                "pinnacle_margin": round(margin([pin[x] for x in keys]), 4) if pin else None,
                "n_books": len(books),
                "fair_market": round(fair[k], 4),
                "model_p": round(mp[k], 4) if mp else None,
                "adj": applied.get(k),
                "p": round(p, 4),
                "ev": round(ev, 4),
                "kelly": round(max(0.0, ev / (best - 1)), 4) if best > 1 else 0.0,
                "books": {C.BOOK_NAMES.get(bk, bk): round(_placeable(bk, pr[k]), 3) for bk, pr in books.items()},
                "veto": bool(adj.get("veto")) if isinstance(adj, dict) else False,
            })
    info = None
    if model_pr:
        info = {"xg_home": model_pr["xg_home"], "xg_away": model_pr["xg_away"],
                "p_home": round(model_pr["home"], 3), "p_draw": round(model_pr["draw"], 3), "p_away": round(model_pr["away"], 3)}
    return outcomes, info


def passes(o):
    if o["veto"]:
        return False
    if o["ev"] > C.MAX_EV:  # zu schön, um wahr zu sein -> Datenfehler/veraltete Quote
        return False
    if not (C.MIN_ODDS <= o["odds"] <= C.MAX_ODDS):
        return False
    lo, hi = C.COINFLIP_BAND
    need = C.COINFLIP_MIN_EV if lo <= o["p"] <= hi else C.MIN_EV
    return o["ev"] >= need
