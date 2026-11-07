#!/usr/bin/env bash
# Dauer-Schleife für GitHub Actions: alle INTERVAL Sekunden "tick" ausführen und Änderungen pushen.
# Läuft RUN_SECONDS lang (knapp unter dem 6-h-Limit), danach übernimmt der nächste Lauf.
set -uo pipefail
END=$(( $(date +%s) + ${RUN_SECONDS:-20400} ))
INTERVAL=${INTERVAL:-300}
git config user.name "rdbelean"
git config user.email "171094272+rdbelean@users.noreply.github.com"

sync() {
  git pull -q --rebase -X theirs origin main || { git rebase --abort 2>/dev/null; git fetch -q origin; git reset -q --hard origin/main; }
}

while [ "$(date +%s)" -lt "$END" ]; do
  sync
  bash scripts/merge_claude.sh
  python -m engine.run tick || echo "::warning::tick fehlgeschlagen"
  git add data site/data
  if ! git diff --cached --quiet; then
    git commit -qm "Daten-Update $(TZ=Europe/Berlin date '+%a %d.%m. %H:%M')"
    for i in 1 2 3; do sync && git push -q origin HEAD:main && break; sleep 5; done
  fi
  sleep "$INTERVAL"
done
echo "Laufzeit erreicht, der nächste Lauf übernimmt."
