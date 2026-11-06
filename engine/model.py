"""Tor-Modell für Club-Fußball: Dixon-Coles-Poisson mit xG und Zeitgewichtung.

Daten: football-data.co.uk (Ergebnisse + xG der aktuellen und letzten Saison).
Jedes Team bekommt eine Angriffs- und eine Abwehrstärke; ältere Spiele zählen
exponentiell weniger (Halbwertszeit ~120 Tage). Als "Tore" verwenden wir eine
Mischung aus echten Toren und Expected Goals, weil xG die zugrundeliegende
Leistung stabiler misst als das Endergebnis.
"""
import csv
import io
import math
from datetime import date, datetime

import numpy as np
import requests
from scipy.optimize import minimize
from scipy.stats import poisson

from . import config as C
from .names import best_match, norm
from .util import log

HALF_LIFE_DAYS = 120
XG_WEIGHT = 0.6
RIDGE = 0.8
RHO = -0.08          # Dixon-Coles-Korrektur für 0:0/1:0/0:1/1:1
MAX_GOALS = 10

_models = {}


def _season_codes(today: date):
    y = today.year if today.month >= 7 else today.year - 1
    cur = f"{y % 100:02d}{(y + 1) % 100:02d}"
    prev = f"{(y - 1) % 100:02d}{y % 100:02d}"
    return [prev, cur]


def _download(code, season):
    cache = C.CACHE / "fd" / f"{season}_{code}.csv"
    cache.parent.mkdir(parents=True, exist_ok=True)
    stale = True
    if cache.exists():
        age_h = (datetime.now().timestamp() - cache.stat().st_mtime) / 3600
        stale = age_h > 12
    if stale:
        try:
            r = requests.get(f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv", timeout=30)
            if r.ok and "HomeTeam" in r.text[:500]:
                cache.write_text(r.content.decode("utf-8-sig", errors="ignore"))
        except Exception as ex:  # noqa: BLE001
            log("football-data.co.uk Fehler", code, season, ex)
    return cache.read_text() if cache.exists() else ""


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_matches(code, today: date):
    rows = []
    for season in _season_codes(today):
        text = _download(code, season)
        if not text:
            continue
        for r in csv.DictReader(io.StringIO(text)):
            hg, ag = _f(r.get("FTHG")), _f(r.get("FTAG"))
            if hg is None or ag is None or not r.get("HomeTeam"):
                continue
            try:
                d = datetime.strptime(r["Date"], "%d/%m/%Y").date()
            except ValueError:
                try:
                    d = datetime.strptime(r["Date"], "%d/%m/%y").date()
                except ValueError:
                    continue
            rows.append(dict(date=d, home=r["HomeTeam"].strip(), away=r["AwayTeam"].strip(),
                             hg=hg, ag=ag, hxg=_f(r.get("HxG")), axg=_f(r.get("AxG")), season=season))
    return rows


class TeamModel:
    def __init__(self, code, today: date):
        self.code = code
        self.matches = load_matches(code, today)
        cur = _season_codes(today)[1]
        # Nur Teams der aktuellen Saison bewerten; Altsaison dient als Vorwissen
        self.teams = sorted({m["home"] for m in self.matches if m["season"] == cur} |
                            {m["away"] for m in self.matches if m["season"] == cur})
        self.ok = len(self.teams) >= 10 and len(self.matches) >= 60
        self.n_cur = sum(1 for m in self.matches if m["season"] == cur)
        self.xg_share = (sum(1 for m in self.matches if m["hxg"] is not None) / max(1, len(self.matches)))
        if self.ok:
            self._fit(today)

    def _fit(self, today):
        idx = {t: i for i, t in enumerate(self.teams)}
        n = len(self.teams)
        H, A, YH, YA, W = [], [], [], [], []
        for m in self.matches:
            if m["home"] not in idx or m["away"] not in idx:
                continue
            age = (today - m["date"]).days
            if age < 0:
                continue
            w = 0.5 ** (age / HALF_LIFE_DAYS)
            yh, ya = m["hg"], m["ag"]
            if m["hxg"] is not None and m["axg"] is not None:
                yh = XG_WEIGHT * m["hxg"] + (1 - XG_WEIGHT) * m["hg"]
                ya = XG_WEIGHT * m["axg"] + (1 - XG_WEIGHT) * m["ag"]
            H.append(idx[m["home"]]); A.append(idx[m["away"]]); YH.append(yh); YA.append(ya); W.append(w)
        H, A = np.array(H), np.array(A)
        YH, YA, W = np.array(YH), np.array(YA), np.array(W)
        self.n_fit = len(H)

        def nll(theta):
            mu, home = theta[0], theta[1]
            att, dfn = theta[2:2 + n], theta[2 + n:]
            lh = np.exp(mu + home + att[H] + dfn[A])
            la = np.exp(mu + att[A] + dfn[H])
            ll = W * (YH * np.log(lh) - lh + YA * np.log(la) - la)
            obj = -ll.sum() + RIDGE * (att @ att + dfn @ dfn)
            rh, ra = W * (YH - lh), W * (YA - la)
            g = np.zeros_like(theta)
            g[0] = -(rh.sum() + ra.sum())
            g[1] = -rh.sum()
            ga = np.zeros(n); gd = np.zeros(n)
            np.add.at(ga, H, rh); np.add.at(ga, A, ra)
            np.add.at(gd, A, rh); np.add.at(gd, H, ra)
            g[2:2 + n] = -ga + 2 * RIDGE * att
            g[2 + n:] = -gd + 2 * RIDGE * dfn
            return obj, g

        theta0 = np.zeros(2 + 2 * n); theta0[0] = math.log(1.3); theta0[1] = 0.2
        res = minimize(nll, theta0, jac=True, method="L-BFGS-B")
        t = res.x
        self.mu, self.home_adv = t[0], t[1]
        self.att = dict(zip(self.teams, t[2:2 + n]))
        self.dfn = dict(zip(self.teams, t[2 + n:]))

    def resolve(self, name):
        if name in self.att:
            return name
        m, _ = best_match(name, self.teams)
        return m

    def expected_goals(self, home, away):
        h, a = self.resolve(home), self.resolve(away)
        if not h or not a or h == a:
            return None
        lh = math.exp(self.mu + self.home_adv + self.att[h] + self.dfn[a])
        la = math.exp(self.mu + self.att[a] + self.dfn[h])
        return lh, la, h, a

    def probs(self, home, away, lambda_mult=(1.0, 1.0)):
        eg = self.expected_goals(home, away)
        if not eg:
            return None
        lh, la, h, a = eg
        lh *= lambda_mult[0]; la *= lambda_mult[1]
        g = np.arange(MAX_GOALS + 1)
        M = np.outer(poisson.pmf(g, lh), poisson.pmf(g, la))
        # Dixon-Coles-Korrektur der niedrigen Ergebnisse
        M[0, 0] *= 1 - lh * la * RHO
        M[0, 1] *= 1 + lh * RHO
        M[1, 0] *= 1 + la * RHO
        M[1, 1] *= 1 - RHO
        M /= M.sum()
        tot = np.add.outer(g, g)
        out = {
            "home": float(np.tril(M, -1).sum()), "draw": float(np.trace(M)), "away": float(np.triu(M, 1).sum()),
            "xg_home": round(lh, 2), "xg_away": round(la, 2), "team_home": h, "team_away": a,
            "_matrix": M, "_tot": tot,
        }
        return out

    @staticmethod
    def p_over(pr, line):
        """P(Tore > line) für .5- und ganzzahlige Linien (Push-Anteil separat)."""
        M, tot = pr["_matrix"], pr["_tot"]
        over = float(M[tot > line].sum())
        push = float(M[tot == line].sum()) if float(line).is_integer() else 0.0
        return over, push

    def ratings(self, top=None):
        rows = sorted(((t, self.att[t], self.dfn[t]) for t in self.teams), key=lambda r: -(r[1] - r[2]))
        return [{"team": t, "att": round(a, 3), "def": round(d, 3)} for t, a, d in rows[:top]]


def get_model(code, today: date):
    if not code:
        return None
    if code not in _models:
        try:
            m = TeamModel(code, today)
            _models[code] = m if m.ok else None
            if m.ok:
                log(f"Modell {code}: {len(m.teams)} Teams, {m.n_fit} Spiele, xG-Anteil {m.xg_share:.0%}")
        except Exception as ex:  # noqa: BLE001
            log("Modell-Fehler", code, ex)
            _models[code] = None
    return _models[code]
