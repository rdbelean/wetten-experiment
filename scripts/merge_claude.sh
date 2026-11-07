#!/usr/bin/env bash
# Die Claude-Routine pusht Recherche/Analysen evtl. auf claude/*-Branches: nur diese Dateien übernehmen.
git fetch -q origin '+refs/heads/claude/*:refs/remotes/origin/claude/*' 2>/dev/null || true
for b in $(git for-each-ref --sort=committerdate --format='%(refname:short)' refs/remotes/origin/claude/); do
  for f in $(git diff --name-only HEAD "$b" -- 'data/days/*/adjustments.json' 'data/analyses/*.json' 2>/dev/null); do
    if git cat-file -e "$b:$f" 2>/dev/null; then
      mkdir -p "$(dirname "$f")"; git show "$b:$f" > "$f"; echo "übernommen: $f aus $b"
    fi
  done
done
