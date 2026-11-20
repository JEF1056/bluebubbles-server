#!/usr/bin/env bash
set -euo pipefail

FETCH=0
REPOS=()
for arg in "$@"; do
  case "$arg" in
    --fetch) FETCH=1 ;;
    *) REPOS+=("$arg") ;;
  esac
done
[ "${#REPOS[@]}" -eq 0 ] && REPOS=(bluebubbles-app bluebubbles-server bluebubbles-helper)

ROOT="/Users/jfan/Documents"
for r in "${REPOS[@]}"; do
  dir="$ROOT/$r"
  echo "=== $r ==="
  [ "$FETCH" -eq 1 ] && git -C "$dir" fetch upstream --quiet
  read -r behind ahead < <(git -C "$dir" rev-list --left-right --count upstream/master...HEAD)
  echo "ahead: $ahead | behind: $behind"

  set +e
  mt_out=$(git -C "$dir" merge-tree --write-tree --name-only HEAD upstream/master 2>&1)
  mt_rc=$?
  set -e
  if [ "$mt_rc" -eq 0 ]; then
    echo "conflicts: none (clean merge-tree)"
  else
    echo "conflicts:"
    printf '%s\n' "$mt_out" | awk '/^$/{p=1;next} p{print "  " $0}' | grep -v '^  CONFLICT ' || true
  fi

  mb=$(git -C "$dir" merge-base HEAD upstream/master)
  overlap=$(comm -12 \
    <(git -C "$dir" diff --name-only "$mb"..HEAD | sort -u) \
    <(git -C "$dir" diff --name-only "$mb"..upstream/master | sort -u) | head -n 10)
  echo "top overlapping files (up to 10):"
  if [ -n "$overlap" ]; then
    printf '%s\n' "$overlap" | sed 's/^/  /'
  else
    echo "  (none)"
  fi
done
