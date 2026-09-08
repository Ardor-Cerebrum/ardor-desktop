#!/usr/bin/env bash
set -euo pipefail

release_tag="${1:?release tag is required}"
manual_release_tag="${2:-}"

if ! [[ "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid release tag: $release_tag" >&2
  exit 2
fi

# Explicit recovery keeps the tag snapshot even after a reviewed UI update.
# The workflow validates the tag's provenance before calling this helper.
if [ -n "$manual_release_tag" ]; then
  echo true
  exit 0
fi

if git diff --quiet "refs/tags/$release_tag" HEAD -- desktop-ui-requirements.json; then
  echo true
else
  diff_status=$?
  if [ "$diff_status" -ne 1 ]; then
    exit "$diff_status"
  fi
  echo false
fi
