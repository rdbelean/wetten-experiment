"""site/data/state.json für die Website zusammenbauen (alle Spieler)."""
import json

from . import config as C
from .strategies import ORDER, PLAYERS
from .util import day_dir, day_window, experiment_days, iso, now_utc, read_json, write_json


def _merge_analysis(b):
    a = read_json(C.ANALYSES / f"{b['id']}.json")
    if a:
        b["analysis"] = a
    b.setdefault("player", "analyst")
    return b


def totals(bets):
    settled = [b for b in bets if b["status"] in ("won", "lost", "push", "void")]
    open_ = [b for b in bets if b["status"] == "open"]
    staked = sum(b["stake"] for b in bets)
    staked_settled = sum(b["stake"] for b in settled)
    returned = sum(b["payout"] or 0 for b in settled)
    profit = returned - staked_settled
    clvs = [b["clv"] for b in bets if b.get("clv") is not None]
    won = sum(1 for b in settled if b["status"] == "won")
    lost = sum(1 for b in settled if b["status"] == "lost")
    # größter Rückgang vom Höchststand (Maß für das Risiko)
    peak = cum = dd = 0.0
    for b in sorted(settled, key=lambda b: ((b.get("result") or {}).get("t") or b["commence"])):
        cum += b["profit"] or 0
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return {
        "staked": round(staked, 2), "staked_settled": round(staked_settled, 2), "returned": round(returned, 2),
        "profit": round(profit, 2), "roi": round(profit / staked_settled, 4) if staked_settled else None,
        "open_stake": round(sum(b["stake"] for b in open_), 2),
        "open_potential": round(sum(b["potential_payout"] for b in open_), 2),
        "won": won, "lost": lost, "push": sum(1 for b in settled if b["status"] in ("push", "void")),
        "n_bets": len(bets),
        "hit_rate": round(won / (won + lost), 4) if won + lost else None,
        "avg_odds": round(sum(b["odds"] for b in bets) / len(bets), 3) if bets else None,
        "max_odds_won": max((b["odds"] for b in settled if b["status"] == "won"), default=None),
        "avg_ev": round(sum(b["ev"] * b["stake"] for b in bets) / staked, 4) if staked else None,
        "expected_profit": round(sum(b["ev"] * b["stake"] for b in bets), 2),
        "expected_settled": round(sum(b["ev"] * b["stake"] for b in settled), 2),
        "avg_clv": round(sum(clvs) / len(clvs), 4) if clvs else None, "n_clv": len(clvs),
        "clv_positive": sum(1 for c in clvs if c > 0),
        "max_drawdown": round(dd, 2),
    }


def day_rows(bets):
    rows, cum = [], 0.0
    for d in experiment_days():
        dbets = [b for b in bets if b["day"] == d.isoformat()]
        ds = [b for b in dbets if b["status"] != "open"]
        p = sum(b["profit"] or 0 for b in ds)
        cum += p
        rows.append({"date": d.isoformat(), "staked": round(sum(b["stake"] for b in dbets), 2), "profit": round(p, 2),
                     "cum_profit": round(cum, 2), "settled": len(ds), "n_bets": len(dbets)})
    return rows


def _talk():
    """Sprüche der Spieler (von der Claude-Routine geschrieben), neueste zuerst."""
    out = []
    for f in sorted(C.ANALYSES.glob("talk-*.json"), reverse=True)[:7]:
        doc = read_json(f) or {}
        if doc.get("messages"):
            out.append({"date": doc.get("date"), "messages": doc["messages"]})
    return out


def build(ledger):
    now = now_utc()
    bets = [_merge_analysis(dict(b)) for b in ledger["bets"]]

    days = []
    for d in experiment_days():
        dd = day_dir(d)
        picks = read_json(dd / "picks.json") or {}
        cand = read_json(dd / "candidates.json") or {}
        adj = read_json(dd / "adjustments.json") or {}
        frm, to = day_window(d)
        days.append({
            "date": d.isoformat(), "window": [iso(frm), iso(to)], "placed": bool(picks),
            "n_candidates": cand.get("n_events"), "n_outcomes": picks.get("n_outcomes"), "n_value": picks.get("n_value"),
            "research": {"used": picks.get("adjustments_used", False), "summary": adj.get("summary"),
                         "n_events": len(adj.get("events", {}))},
            "near_misses": picks.get("near_misses", []),
            "summary": read_json(C.ANALYSES / f"day-{d.isoformat()}.json"),
        })

    players = {}
    for pid in ORDER:
        pb = [b for b in bets if b["player"] == pid]
        players[pid] = {**PLAYERS[pid], "id": pid, "totals": totals(pb), "days": day_rows(pb)}

    meta = read_json(C.META, {}) or {}
    state = {
        "experiment": {"name": C.EXPERIMENT_NAME, "start": C.START_DAY.isoformat(), "days": C.NUM_DAYS,
                       "daily_budget": C.DAILY_BUDGET, "total_budget": C.DAILY_BUDGET * C.NUM_DAYS},
        "generated_at": iso(now),
        "players": players,
        "order": ORDER,
        "days": days,
        "bets": sorted(bets, key=lambda b: (b["commence"], b["id"])),
        "talk": _talk(),
        "weekly": read_json(C.ANALYSES / "weekly.json"),
        "backtest": read_json(C.DATA / "backtest.json"),
        "rules": {"min_ev": C.MIN_EV, "coinflip_band": C.COINFLIP_BAND, "coinflip_min_ev": C.COINFLIP_MIN_EV,
                  "min_odds": C.MIN_ODDS, "max_odds": C.MAX_ODDS, "max_stake": C.MAX_STAKE, "min_bets": C.MIN_BETS,
                  "max_bets": C.MAX_BETS, "kelly_fraction": C.KELLY_FRACTION, "model_weight": C.MODEL_WEIGHT,
                  "adj_cap": C.ADJ_CAP, "sports": {k: v["label"] for k, v in C.SPORTS.items()}},
        "system": {"credits_remaining": meta.get("credits_remaining"),
                   "last_actions": meta.get("last_actions", [])[-15:]},
    }
    # Nur schreiben, wenn sich inhaltlich etwas geändert hat (sonst kein Commit/Deploy)
    old = read_json(C.SITE_DATA / "state.json")
    if old:
        a = {k: v for k, v in old.items() if k != "generated_at"}
        b = {k: v for k, v in state.items() if k != "generated_at"}
        if json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str):
            return False
    return write_json(C.SITE_DATA / "state.json", state)
