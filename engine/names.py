"""Team-Namen zwischen Quellen (Odds API, football-data.co.uk, ESPN) abgleichen."""
import re
import unicodedata
from difflib import SequenceMatcher

ALIASES = {
    "man united": "manchester united", "man utd": "manchester united", "man city": "manchester city",
    "nott'm forest": "nottingham forest", "nottm forest": "nottingham forest", "wolves": "wolverhampton wanderers",
    "spurs": "tottenham hotspur", "brighton": "brighton hove albion", "west brom": "west bromwich albion",
    "sheffield weds": "sheffield wednesday", "sheffield utd": "sheffield united", "qpr": "queens park rangers",
    "m'gladbach": "monchengladbach", "mgladbach": "monchengladbach", "ein frankfurt": "eintracht frankfurt",
    "fc koln": "koln", "fortuna dusseldorf": "dusseldorf", "greuther furth": "furth", "hertha": "hertha berlin",
    "ath madrid": "atletico madrid", "ath bilbao": "athletic bilbao", "sociedad": "real sociedad",
    "betis": "real betis", "espanol": "espanyol", "celta": "celta vigo", "vallecano": "rayo vallecano",
    "inter": "inter milan", "internazionale": "inter milan", "milan": "ac milan", "roma": "as roma",
    "paris sg": "paris saint germain", "psg": "paris saint germain", "st etienne": "saint etienne",
    "nijmegen": "nec nijmegen", "for sittard": "fortuna sittard", "sparta rotterdam": "sparta rotterdam",
    "bayern munich": "bayern munchen", "bayern": "bayern munchen", "leverkusen": "bayer leverkusen",
    "dortmund": "borussia dortmund", "hamburg": "hamburger sv", "mk dons": "milton keynes dons",
    "wycombe": "wycombe wanderers", "bristol rvs": "bristol rovers", "afc wimbledon": "wimbledon",
}

STOP = {"fc", "afc", "cf", "sc", "sv", "vfl", "vfb", "tsg", "fsv", "bv", "bsc", "ssc", "ac", "as", "us",
        "rc", "rcd", "ud", "cd", "sd", "ca", "club", "de", "the", "1", "05", "04", "1899", "1846", "fk",
        "calcio", "hsc", "ogc", "losc", "stade", "and", "&", "hove"}


def norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = s.replace(".", " ").replace("-", " ").strip()
    s = re.sub(r"\s+", " ", s)
    s = ALIASES.get(s, s)
    return s


def tokens(name: str):
    return [t for t in norm(name).split() if t not in STOP] or norm(name).split()


def similarity(a: str, b: str) -> float:
    na, nb = norm(a), norm(b)
    if na == nb:
        return 1.0
    ta, tb = set(tokens(a)), set(tokens(b))
    jac = len(ta & tb) / max(1, len(ta | tb))
    seq = SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()
    contain = 0.8 if (" ".join(tokens(a)) in " ".join(tokens(b)) or " ".join(tokens(b)) in " ".join(tokens(a))) else 0
    return max(jac, seq * 0.95, contain)


def best_match(name: str, candidates, threshold=0.62):
    best, score = None, 0.0
    for c in candidates:
        s = similarity(name, c)
        if s > score:
            best, score = c, s
    return (best, score) if score >= threshold else (None, score)
