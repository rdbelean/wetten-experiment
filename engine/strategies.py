"""Die Spieler der "Wett-Agentur": gleiche Daten, gleiches Budget (100 €/Tag), andere Strategie.

Jede Strategie bekommt dieselbe Liste bewerteter Wettmöglichkeiten (outcomes) und gibt
eine Liste von Wetten mit Einsatz zurück. Summe der Einsätze = 100 € pro Tag.
"""
import math
import random
from datetime import timedelta

from . import config as C
from .evaluate import passes
from .util import parse_ts

PLAYERS = {
    "analyst": dict(name="Der Analyst", risk="mittel", color="#3987e5",
                    tagline="Nur Wetten mit mathematischem Vorteil, Einsatz nach Kelly.",
                    desc="Die Hauptstrategie des Experiments: faire Wahrscheinlichkeit aus Pinnacle, Börse und Marktschnitt, "
                         "dazu Tor-Modell und News. Gesetzt wird nur bei mindestens +2 % Erwartungswert, der Einsatz richtet sich "
                         "nach der Größe des Vorteils (Viertel-Kelly), höchstens 40 € pro Wette."),
    "banker": dict(name="Der Banker", risk="niedrig", color="#d95926",
                   tagline="Nur klare Favoriten, kleine Quoten, flache Einsätze.",
                   desc="Setzt nur auf Ausgänge mit mindestens 62 % Wahrscheinlichkeit bei Quoten von 1,25 bis 1,75, "
                        "und nur, wenn die beste Quote mindestens fair ist. Bis zu 5 Wetten, das Budget wird gleichmäßig verteilt. "
                        "Gewinnt oft, aber wenig."),
    "zocker": dict(name="Der Zocker", risk="hoch", color="#199e70",
                   tagline="Außenseiter mit Vorteil, große Quoten, mutige Einsätze.",
                   desc="Sucht Außenseiter mit Quoten von 3 bis 12, bei denen der Markt sie unterschätzt (mindestens +4 % "
                        "Erwartungswert). Einsatz nach halbem Kelly, bis zu 60 € auf eine Wette. Verliert oft, aber ein Treffer "
                        "bringt viel."),
    "kombi": dict(name="Der Kombi-König", risk="sehr hoch", color="#c98500",
                  tagline="Zwei Kombiwetten pro Tag aus den besten Einzeltipps.",
                  desc="Baut aus den besten Value-Tipps des Tages zwei Kombiwetten (3 und 4 Spiele, je 50 €). "
                       "Die Quoten multiplizieren sich, damit auch der kleine Vorteil jedes Tipps. Eine einzige falsche Partie "
                       "und die ganze Kombi ist verloren."),
    "stammtisch": dict(name="Der Stammtisch", risk="mittel", color="#d55181",
                       tagline="Kontrollgruppe: Bauchgefühl, Favorit der großen Spiele, Tipico-Quote.",
                       desc="So wettet ein typischer Hobby-Tipper: auf den Favoriten der 5 bekanntesten Spiele des Tages, "
                            "immer zur Tipico-Quote, ohne Quotenvergleich und ohne Mathe, je 20 €. Zeigt, was die Buchmacher-Marge "
                            "kostet."),
    "affe": dict(name="Der Affe", risk="Zufall", color="#3F9B2B",
                 tagline="Kontrollgruppe: 4 zufällige Tipps zur Tipico-Quote.",
                 desc="Wählt per Zufall 4 Siegwetten aus dem Tagesangebot (Quote bis 5), je 25 € zur Tipico-Quote. "
                      "Wenn eine Strategie nicht besser ist als der Affe, taugt sie nichts."),
}
ORDER = list(PLAYERS)

POPULAR = ["Bundesliga", "Premier League", "Nations League", "La Liga", "Serie A", "Ligue 1", "NFL", "NBA",
           "2. Bundesliga", "Championship", "Eredivisie", "NHL", "EuroLeague", "3. Liga", "League One", "League Two"]


def _future(outcomes, now):
    return [o for o in outcomes if parse_ts(o["commence"]) > now + timedelta(minutes=C.START_BUFFER_MIN)]


def _one_per_event(cands):
    out, seen = [], set()
    for o in cands:
        if o["event_id"] in seen:
            continue
        seen.add(o["event_id"])
        out.append(o)
    return out


def _flat(chosen, budget=C.DAILY_BUDGET):
    if not chosen:
        return []
    n = len(chosen)
    base = math.floor(budget / n * 2) / 2
    stakes = [base] * n
    stakes[0] += round(budget - base * n, 2)
    for o, s in zip(chosen, stakes):
        o["stake"] = round(s, 2)
    return chosen


def _weighted(chosen, weights, cap, budget=C.DAILY_BUDGET):
    """Budget proportional zu Gewichten, mit Deckel, 0,50-€-Schritte, Summe exakt."""
    n = len(chosen)
    if not n:
        return []
    cap = max(cap, budget / n)
    stakes = [0.0] * n
    free, remaining = list(range(n)), budget
    while free:
        tw = sum(weights[i] for i in free) or 1
        over = [i for i in free if remaining * weights[i] / tw > cap]
        if not over:
            for i in free:
                stakes[i] = remaining * weights[i] / tw
            break
        for i in over:
            stakes[i] = cap
            remaining -= cap
            free.remove(i)
    stakes = [max(2.0, round(s * 2) / 2) for s in stakes]
    diff = round(budget - sum(stakes), 2)
    order = sorted(range(n), key=lambda i: -stakes[i])
    k = 0
    while abs(diff) >= 0.5 and k < 2000:
        i = order[k % n]
        step = 0.5 if diff > 0 else -0.5
        if (step > 0 and stakes[i] + step <= cap) or (step < 0 and stakes[i] + step >= 2.0):
            stakes[i] += step
            diff = round(diff - step, 2)
        k += 1
    for o, s in zip(chosen, stakes):
        o["stake"] = round(s, 2)
    return chosen


def _at_tipico(o):
    """Wette zur Tipico-Quote (ohne Quotenvergleich); fehlt Tipico, dann Median."""
    o = dict(o)
    price = o.get("tipico_odds") or o.get("median_odds")
    o["book"], o["book_name"] = ("tipico_de", "Tipico") if o.get("tipico_odds") else ("median", "Marktschnitt")
    o["odds"] = round(price, 3)
    o["ev"] = round(o["p"] * price - 1, 4)
    o["kelly"] = round(max(0.0, o["ev"] / (price - 1)), 4) if price > 1 else 0.0
    return o


# --------------------------------------------------------------------------- Strategien
def analyst(outcomes, now, day):
    from .pick import allocate, select  # noqa: WPS433 (zirkulärer Import vermeiden)
    chosen = [dict(o) for o in select(outcomes, now)]
    return allocate(chosen)


def banker(outcomes, now, day):
    c = [o for o in _future(outcomes, now) if not o["veto"] and o["market"] in ("h2h", "spreads", "totals")
         and o["p"] >= 0.62 and 1.25 <= o["odds"] <= 1.75 and -0.005 <= o["ev"] <= C.MAX_EV]
    c.sort(key=lambda o: (-o["p"], -o["ev"]))
    chosen = [dict(o, kind="value" if o["ev"] >= C.MIN_EV else "favorit") for o in _one_per_event(c)[:5]]
    if len(chosen) < 3:  # zu wenig sichere Favoriten: Anforderungen lockern
        more = [o for o in _future(outcomes, now) if not o["veto"] and o["p"] >= 0.55 and o["odds"] <= 1.9
                and o["ev"] >= -0.02 and o["event_id"] not in {x["event_id"] for x in chosen}]
        more.sort(key=lambda o: -o["p"])
        chosen += [dict(o, kind="favorit") for o in _one_per_event(more)[: 3 - len(chosen)]]
    return _flat(chosen)


def zocker(outcomes, now, day):
    c = [o for o in _future(outcomes, now) if not o["veto"] and 3.0 <= o["odds"] <= 12.0
         and 0.04 <= o["ev"] <= C.MAX_EV]
    c.sort(key=lambda o: -o["ev"])
    chosen = [dict(o, kind="value") for o in _one_per_event(c)[:5]]
    if len(chosen) < 2:  # Notfall: die besten Außenseiter, auch mit kleinerem Vorteil
        more = [o for o in _future(outcomes, now) if not o["veto"] and 2.6 <= o["odds"] <= 12.0
                and -0.03 <= o["ev"] <= C.MAX_EV and o["event_id"] not in {x["event_id"] for x in chosen}]
        more.sort(key=lambda o: -o["ev"])
        chosen += [dict(o, kind="filler") for o in _one_per_event(more)[: 2 - len(chosen)]]
    weights = [max(0.01, o["kelly"]) * 0.5 for o in chosen]
    return _weighted(chosen, weights, cap=60.0)


def kombi(outcomes, now, day):
    fut = _future(outcomes, now)
    legs = [o for o in fut if passes(o) and o["odds"] <= 3.0]
    legs.sort(key=lambda o: -o["ev"])
    legs = _one_per_event(legs)
    if len(legs) < 7:  # mit fair bepreisten Favoriten auffüllen
        more = [o for o in fut if not o["veto"] and o["ev"] >= -0.01 and o["p"] >= 0.5 and 1.25 <= o["odds"] <= 2.5
                and o["event_id"] not in {x["event_id"] for x in legs}]
        more.sort(key=lambda o: -o["ev"])
        legs += _one_per_event(more)[: 7 - len(legs)]
    combos = []
    for size, pool in ((3, legs[:3]), (4, legs[3:7])):
        if len(pool) < 2:
            continue
        odds = math.prod(l["odds"] for l in pool)
        p = math.prod(l["p"] for l in pool)
        first = min(pool, key=lambda l: l["commence"])
        combos.append({
            "event_id": "+".join(l["event_id"] for l in pool), "sport": "combo", "league": f"Kombi aus {len(pool)} Spielen",
            "group": "Kombi", "home": " / ".join(l["home"] for l in pool), "away": "",
            "commence": first["commence"], "last_commence": max(l["commence"] for l in pool),
            "market": "combo", "point": None, "key": "combo",
            "label": f"{len(pool)}er-Kombi", "odds": round(odds, 2), "book": "mix", "book_name": "beste Quoten",
            "median_odds": round(math.prod(l["median_odds"] for l in pool), 2),
            "tipico_odds": round(math.prod(l["tipico_odds"] for l in pool), 2) if all(l.get("tipico_odds") for l in pool) else None,
            "pinnacle_odds": None, "n_books": min(l["n_books"] for l in pool),
            "fair_market": round(math.prod(l["fair_market"] for l in pool), 4), "model_p": None, "adj": None,
            "p": round(p, 4), "ev": round(p * odds - 1, 4), "kelly": 0.0, "books": {}, "veto": False,
            "kind": "kombi",
            "legs": [{k: l[k] for k in ("event_id", "sport", "league", "group", "home", "away", "commence", "market",
                                         "point", "key", "label", "odds", "book_name", "p", "ev")} for l in pool],
        })
    return _flat(combos)


def stammtisch(outcomes, now, day):
    fut = [o for o in _future(outcomes, now) if o["market"] == "h2h"]
    fav = {}
    for o in fut:
        cur = fav.get(o["event_id"])
        if cur is None or o["median_odds"] < cur["median_odds"]:
            fav[o["event_id"]] = o
    rank = {lg: i for i, lg in enumerate(POPULAR)}
    games = sorted(fav.values(), key=lambda o: (rank.get(o["league"], 99), o["commence"]))
    chosen = [dict(_at_tipico(o), kind="bauch") for o in games[:5]]
    return _flat(chosen)


def affe(outcomes, now, day):
    pool = [o for o in _future(outcomes, now) if o["market"] == "h2h" and (o.get("tipico_odds") or o["median_odds"]) <= 5.0]
    rng = random.Random(f"affe-{day}")
    rng.shuffle(pool)
    chosen = [dict(_at_tipico(o), kind="zufall") for o in _one_per_event(pool)[:4]]
    return _flat(chosen)


STRATEGIES = {"analyst": analyst, "banker": banker, "zocker": zocker, "kombi": kombi,
              "stammtisch": stammtisch, "affe": affe}
