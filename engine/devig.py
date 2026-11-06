"""Buchmacher-Marge entfernen ("de-vig"): Quoten -> faire Wahrscheinlichkeiten."""
from scipy.optimize import brentq


def implied(odds):
    return [1.0 / o for o in odds]


def margin(odds):
    return sum(implied(odds)) - 1.0


def power(odds):
    """Power-Methode: finde k mit sum((1/o)^k) = 1.

    Robuster als proportionales Herausrechnen, weil sie den
    Favorite-Longshot-Bias berücksichtigt (Außenseiter tragen mehr Marge).
    """
    ip = implied(odds)
    s = sum(ip)
    if abs(s - 1) < 1e-9:
        return ip
    if s < 1:  # Arbitrage/fehlerhafte Daten: proportional normalisieren
        return [p / s for p in ip]
    f = lambda k: sum(p ** k for p in ip) - 1.0  # noqa: E731
    k = brentq(f, 1.0, 5.0)
    return [p ** k for p in ip]
