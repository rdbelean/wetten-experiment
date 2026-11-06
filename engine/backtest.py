"""Backtest: Wie viel Gewicht verdient unser Tor-Modell neben dem Markt?

Für Saison 2025/26 wird das Modell vor jedem Spieltag nur mit vorherigen
Spielen neu geschätzt. Verglichen wird der Log-Loss (kleiner = besser) von
  - Pinnacle-Schlussquote (de-vigged)  = der "schärfste" Marktpreis
  - Modell allein
  - Mischungen Markt/Modell mit verschiedenen Gewichten
Ergebnis landet in data/backtest.json und auf der Website.
"""
import csv
import io
import math
from collections import defaultdict
from datetime import datetime, timedelta

import requests

from . import config as C
from .devig import power
from .model import TeamModel
from .util import write_json, log

WEIGHTS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0]


def _rows(code, season):
    r = requests.get(f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv", timeout=30)
    out = []
    for x in csv.DictReader(io.StringIO(r.content.decode("utf-8-sig", errors="ignore"))):
        try:
            d = datetime.strptime(x["Date"], "%d/%m/%Y").date()
            hg, ag = float(x["FTHG"]), float(x["FTAG"])
        except (ValueError, KeyError, TypeError):
            continue
        def f(k):
            try:
                return float(x.get(k) or "")
            except ValueError:
                return None
        out.append(dict(date=d, home=x["HomeTeam"].strip(), away=x["AwayTeam"].strip(), hg=hg, ag=ag,
                        hxg=None, axg=None, season=season,
                        pc=[f("PSCH"), f("PSCD"), f("PSCA")], avgc=[f("AvgCH"), f("AvgCD"), f("AvgCA")]))
    return out


def run(code, test_season="2526", warm_season="2425"):
    warm, test = _rows(code, warm_season), _rows(code, test_season)
    allm = warm + test
    teams_test = sorted({m["home"] for m in test} | {m["away"] for m in test})
    by_week = defaultdict(list)
    for m in test:
        by_week[m["date"] - timedelta(days=m["date"].weekday())].append(m)
    ll = defaultdict(float)
    n = 0
    bets = defaultdict(lambda: [0, 0.0])  # simulierte Value-Wetten gg. Durchschnittsquote
    for wk in sorted(by_week):
        hist = [m for m in allm if m["date"] < wk]
        if sum(1 for m in hist if m["season"] == test_season) < 40:
            continue  # erst ab ~4 Spieltagen
        tm = TeamModel.__new__(TeamModel)
        tm.matches, tm.teams = hist, teams_test
        tm._fit(wk)
        for m in by_week[wk]:
            if None in m["pc"]:
                continue
            pr = tm.probs(m["home"], m["away"])
            if not pr:
                continue
            mk = power(m["pc"])
            mo = [pr["home"], pr["draw"], pr["away"]]
            res = 0 if m["hg"] > m["ag"] else 1 if m["hg"] == m["ag"] else 2
            n += 1
            for w in WEIGHTS:
                p = [(1 - w) * a + w * b for a, b in zip(mk, mo)]
                ll[w] += -math.log(max(1e-9, p[res]))
                # Value-Simulation gegen die Durchschnitts-Schlussquote (weiche Buchmacher)
                if None not in m["avgc"] and w > 0:
                    for i in range(3):
                        ev = p[i] * m["avgc"][i] - 1
                        if ev > C.MIN_EV:
                            bets[w][0] += 1
                            bets[w][1] += (m["avgc"][i] - 1) if i == res else -1
    out = {"league": code, "season": test_season, "matches": n,
           "logloss": {str(w): round(ll[w] / n, 5) for w in WEIGHTS} if n else {},
           "value_sim": {str(w): {"bets": b[0], "roi": round(b[1] / b[0], 4) if b[0] else None} for w, b in bets.items()}}
    return out


def sharp_vs_soft(season="2425", codes=("D1", "E0", "D2", "E1", "E2", "E3", "SP1", "I1", "F1", "N1")):
    """Kernstrategie testen: Pinnacle-Quote (vor dem Spiel) entmargen, bei der besten
    Quote am Markt wetten, wenn EV > Schwelle. Ergebnis + CLV gegen Pinnacle-Schlussquote."""
    out = {}
    for code in codes:
        t = requests.get(f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv", timeout=30)
        for x in csv.DictReader(io.StringIO(t.content.decode("utf-8-sig", "ignore"))):
            try:
                ps = [float(x[k]) for k in ("PSH", "PSD", "PSA")]
                mx = [float(x[k]) for k in ("MaxH", "MaxD", "MaxA")]
                pc = [float(x[k]) for k in ("PSCH", "PSCD", "PSCA")]
                res = {"H": 0, "D": 1, "A": 2}[x["FTR"]]
            except (KeyError, ValueError):
                continue
            fair, cfair = power(ps), power(pc)
            for th in (0.02, 0.04):
                for i in range(3):
                    ev = fair[i] * mx[i] - 1
                    if ev > th and mx[i] <= C.MAX_ODDS:
                        a = out.setdefault(str(th), [0, 0.0, 0.0])
                        a[0] += 1
                        a[1] += (mx[i] - 1) if i == res else -1
                        a[2] += cfair[i] * mx[i] - 1
    return {"season": season, "leagues": len(codes),
            "by_threshold": {k: {"bets": n, "roi": round(p / n, 4), "clv": round(c / n, 4)} for k, (n, p, c) in out.items()}}


def main():
    res = []
    for code in ["D1", "E0", "D2", "E1", "SP1", "I1"]:
        try:
            r = run(code)
            log(code, r["matches"], r["logloss"])
            res.append(r)
        except Exception as ex:  # noqa: BLE001
            log("Backtest-Fehler", code, ex)
    svs = sharp_vs_soft()
    log("sharp vs soft", svs)
    write_json(C.DATA / "backtest.json", {"model": res, "sharp_vs_soft": svs})
    return res


if __name__ == "__main__":
    main()
