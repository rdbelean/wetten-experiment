# Quotenlabor

Wetten als Experiment, nicht als Bauchgefühl. Live: https://quotenlabor.vercel.app

Spielgeld-Experiment: 7 Tage (7.–13. November 2026), jeden Tag genau 100 € auf Sportwetten mit
mathematischem Vorteil. Es werden **keine echten Wetten** platziert.

- `engine/strategies.py`: die 6 Spieler (Analyst, Banker, Zocker, Kombi-König, Stammtisch, Affe)
- `engine/`: Python-Engine (Quoten, Entmargung, Dixon-Coles/xG-Modell, Auswahl, Kelly-Einsätze, Abrechnung, CLV)
- `site/`: statische Website (Vercel), liest `site/data/state.json`, Live-Stände direkt von ESPN
- `.github/workflows/runner.yml`: Dauer-Job, prüft alle 5 Minuten, was fällig ist (Quoten, Wetten, Schlussquoten, Abrechnung)
- `.github/workflows/tick.yml`: einzelnen Schritt manuell anstoßen
- `routine/RESEARCH.md`: Anleitung für die tägliche Claude-Routine (News-Recherche + Analysen)
- `data/`: Ledger, Tagesdaten, Analysen (wird automatisch gepflegt)

Lokal: `python -m engine.run tick|prepare|pick|settle|build [--day YYYY-MM-DD]` (Keys in `.env`).
Backtest: `python -m engine.backtest`.
