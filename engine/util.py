import json
import os
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from . import config as C


def load_env():
    """Lokale .env laden (in GitHub Actions kommen die Keys aus Secrets)."""
    p = C.ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def read_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj) -> bool:
    """Schreibt nur, wenn sich der Inhalt geändert hat. Gibt True bei Änderung zurück."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=False)
    if path.exists() and path.read_text() == text:
        return False
    path.write_text(text)
    return True


def now_utc() -> datetime:
    fake = os.environ.get("FAKE_NOW")  # für Tests: "2026-11-07T10:00:00+01:00"
    if fake:
        return datetime.fromisoformat(fake).astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_window(d: date):
    start = datetime.combine(d, time(C.DAY_START_HOUR), tzinfo=C.TZ)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def experiment_days():
    return [C.START_DAY + timedelta(days=i) for i in range(C.NUM_DAYS)]


def day_dir(d: date) -> Path:
    return C.DAYS / d.isoformat()


def log(*a):
    print(f"[{datetime.now(C.TZ).strftime('%H:%M:%S')}]", *a, flush=True)
