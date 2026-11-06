"""Zentrale Einstellungen des Wett-Experiments."""
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DAYS = DATA / "days"
ANALYSES = DATA / "analyses"
CACHE = DATA / "cache"
SITE_DATA = ROOT / "site" / "data"
LEDGER = DATA / "ledger.json"
META = DATA / "meta.json"

TZ = ZoneInfo("Europe/Berlin")

# --- Experiment -----------------------------------------------------------
EXPERIMENT_NAME = "Projekt Value — 7 Tage, 700 € Spielgeld"
START_DAY = date(2026, 11, 7)
NUM_DAYS = 7
DAILY_BUDGET = 100.0

# Ein "Wett-Tag" D umfasst alle Events mit Anstoß von D 12:00 bis D+1 12:00 (Berlin).
DAY_START_HOUR = 12
PREPARE_HOUR = (8, 30)   # Quoten holen + Kandidaten für die Claude-Recherche
PICK_HOUR = (11, 0)      # Wetten final platzieren

# --- Auswahl- und Einsatzregeln ---------------------------------------------
MIN_EV = 0.02                 # mind. +2 % Erwartungswert
MAX_EV = 0.15                 # mehr als +15 % gilt als Datenfehler
COINFLIP_BAND = (0.40, 0.60)  # "60/40-Münzwürfe" ...
COINFLIP_MIN_EV = 0.045       # ... nur mit deutlich größerem Vorteil
MIN_ODDS = 1.20
MAX_ODDS = 6.0
MAX_STAKE = 40.0              # max. 40 € auf eine einzelne Wette
MIN_BETS = 3
MAX_BETS = 8
KELLY_FRACTION = 0.25         # Viertel-Kelly als Gewichtung
OUTLIER_RATIO = 1.12          # beste Quote > 12 % über Median -> vermutlich veraltet
MIN_BOOKS = 4                 # mind. so viele Buchmacher für einen Markt
FILLER_MIN_EV = -0.035        # Füllwetten (falls zu wenig Value) dürfen max. so schlecht sein
ADJ_CAP = 0.05                # Claude-News-Korrektur max. ±5 Prozentpunkte
START_BUFFER_MIN = 10         # keine Wetten auf Spiele, die in <10 min starten

# Gewichte für die faire Wahrscheinlichkeit aus dem Markt
W_PINNACLE = 0.55
W_EXCHANGE = 0.20
W_CONSENSUS = 0.25

# Börsen: Quote nach Kommission
EXCHANGE_COMMISSION = {"betfair_ex_eu": 0.05, "matchbook": 0.02}
EXCHANGES = set(EXCHANGE_COMMISSION)

BOOK_NAMES = {
    "pinnacle": "Pinnacle", "tipico_de": "Tipico", "winamax_de": "Winamax DE",
    "winamax_fr": "Winamax FR", "onexbet": "1xBet", "sport888": "888sport",
    "unibet_fr": "Unibet FR", "unibet_nl": "Unibet NL", "unibet_se": "Unibet SE",
    "unibet_it": "Unibet IT", "williamhill": "William Hill", "betclic_fr": "Betclic",
    "marathonbet": "Marathonbet", "betfair_ex_eu": "Betfair Exchange", "nordicbet": "NordicBet",
    "betsson": "Betsson", "leovegas_se": "LeoVegas", "pmu_fr": "PMU", "coolbet": "Coolbet",
    "matchbook": "Matchbook", "gtbets": "GTbets", "codere_it": "Codere", "everygame": "Everygame",
    "betonlineag": "BetOnline", "betanysports": "BetAnySports", "mybookieag": "MyBookie",
    "betvictor": "BetVictor",
}

# --- Sportarten / Ligen -----------------------------------------------------
# espn: Pfad für Live-Ergebnisse, fd: football-data.co.uk-Code (Modell), fdorg: football-data.org-Code
# tier: 1 = sehr effizienter Markt, 2 = Nische (Modell bekommt mehr Gewicht)
SPORTS = {
    "soccer_germany_bundesliga":   dict(label="Bundesliga", group="Fußball", country="DE", espn="soccer/ger.1", fd="D1", fdorg="BL1", tier=1, markets="h2h,totals", dur=2.0),
    "soccer_epl":                  dict(label="Premier League", group="Fußball", country="EN", espn="soccer/eng.1", fd="E0", fdorg="PL", tier=1, markets="h2h,totals", dur=2.0),
    "soccer_germany_bundesliga2":  dict(label="2. Bundesliga", group="Fußball", country="DE", espn="soccer/ger.2", fd="D2", tier=2, markets="h2h,totals", dur=2.0),
    "soccer_germany_liga3":        dict(label="3. Liga", group="Fußball", country="DE", espn=None, fd=None, tier=2, markets="h2h,totals", dur=2.0),
    "soccer_efl_champ":            dict(label="Championship", group="Fußball", country="EN", espn="soccer/eng.2", fd="E1", fdorg="ELC", tier=2, markets="h2h,totals", dur=2.0),
    "soccer_england_league1":      dict(label="League One", group="Fußball", country="EN", espn="soccer/eng.3", fd="E2", tier=2, markets="h2h,totals", dur=2.0),
    "soccer_england_league2":      dict(label="League Two", group="Fußball", country="EN", espn="soccer/eng.4", fd="E3", tier=2, markets="h2h,totals", dur=2.0),
    "soccer_spain_la_liga":        dict(label="La Liga", group="Fußball", country="ES", espn="soccer/esp.1", fd="SP1", fdorg="PD", tier=1, markets="h2h,totals", dur=2.0),
    "soccer_italy_serie_a":        dict(label="Serie A", group="Fußball", country="IT", espn="soccer/ita.1", fd="I1", fdorg="SA", tier=1, markets="h2h,totals", dur=2.0),
    "soccer_france_ligue_one":     dict(label="Ligue 1", group="Fußball", country="FR", espn="soccer/fra.1", fd="F1", fdorg="FL1", tier=1, markets="h2h,totals", dur=2.0),
    "soccer_netherlands_eredivisie": dict(label="Eredivisie", group="Fußball", country="NL", espn="soccer/ned.1", fd="N1", fdorg="DED", tier=2, markets="h2h,totals", dur=2.0),
    "soccer_uefa_nations_league":  dict(label="Nations League", group="Fußball", country="EU", espn="soccer/uefa.nations", fd=None, tier=2, markets="h2h,totals", dur=2.0),
    "basketball_nba":              dict(label="NBA", group="Basketball", country="US", espn="basketball/nba", fd=None, tier=1, markets="h2h,spreads,totals", dur=2.75),
    "basketball_euroleague":       dict(label="EuroLeague", group="Basketball", country="EU", espn=None, fd=None, tier=2, markets="h2h,totals", dur=2.5),
    "icehockey_nhl":               dict(label="NHL", group="Eishockey", country="US", espn="hockey/nhl", fd=None, tier=1, markets="h2h,totals", dur=3.0),
    "americanfootball_nfl":        dict(label="NFL", group="American Football", country="US", espn="football/nfl", fd=None, tier=1, markets="h2h,spreads,totals", dur=3.75),
}

# Backtest 2025/26: Modell verbessert die Pinnacle-Schlussquote kaum -> nur kleiner Tie-Breaker.
MODEL_WEIGHT = {1: 0.05, 2: 0.08}
