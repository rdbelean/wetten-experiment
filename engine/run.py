"""Einstiegspunkt.

  python -m engine.run tick              # alles, was gerade fällig ist (GitHub Actions, alle 20 min)
  python -m engine.run prepare [--day D] # Quoten holen + Kandidaten schreiben
  python -m engine.run pick [--day D]    # Wetten platzieren
  python -m engine.run settle            # Schlussquoten + Abrechnung
  python -m engine.run build             # state.json neu bauen
"""
import argparse
from datetime import date, datetime

from . import config as C
from . import pick as P
from . import settle as S
from .state import build
from .util import day_dir, experiment_days, iso, load_env, log, now_utc, read_json, write_json


def load_ledger():
    return read_json(C.LEDGER, {"bets": []}) or {"bets": []}


def save_ledger(ledger):
    return write_json(C.LEDGER, ledger)


def _note(action):
    m = read_json(C.META, {}) or {}
    acts = m.setdefault("last_actions", [])
    acts.append({"t": iso(now_utc()), "a": action})
    m["last_actions"] = acts[-40:]
    write_json(C.META, m)


def tick():
    now = now_utc().astimezone(C.TZ)
    ledger = load_ledger()
    today = now.date()
    if today in experiment_days():
        dd = day_dir(today)
        hm = (now.hour, now.minute)
        if hm >= C.PREPARE_HOUR and not (dd / "candidates.json").exists():
            P.prepare(today)
            _note(f"Kandidaten für {today} vorbereitet")
        if hm >= C.PICK_HOUR and not (dd / "picks.json").exists():
            if not (dd / "candidates.json").exists():
                P.prepare(today)
            if P.pick(today, ledger):
                _note(f"Wetten für {today} platziert")
    if S.capture_closing(ledger):
        _note("Schlussquoten erfasst")
    if S.settle(ledger):
        _note("Wetten abgerechnet")
    save_ledger(ledger)
    build(ledger)


def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["tick", "prepare", "pick", "settle", "build"])
    ap.add_argument("--day")
    a = ap.parse_args()
    d = date.fromisoformat(a.day) if a.day else now_utc().astimezone(C.TZ).date()
    if a.cmd == "tick":
        tick()
    elif a.cmd == "prepare":
        P.prepare(d)
    elif a.cmd == "pick":
        ledger = load_ledger()
        P.pick(d, ledger)
        save_ledger(ledger)
        build(ledger)
    elif a.cmd == "settle":
        ledger = load_ledger()
        S.capture_closing(ledger)
        S.settle(ledger)
        save_ledger(ledger)
        build(ledger)
    elif a.cmd == "build":
        build(load_ledger())


if __name__ == "__main__":
    main()
