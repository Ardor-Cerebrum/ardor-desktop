#!/usr/bin/env bash

set -euo pipefail

repository="${1:?repository is required}"
tag="${2:?release tag is required}"

matches="$(
  gh api --paginate "repos/${repository}/releases?per_page=100" \
    | jq -s --arg tag "$tag" '[.[][] | select(
        .tag_name == $tag
        or (.draft == true and .name == $tag and (.tag_name | startswith("untagged-")))
      )]'
)"
match_count="$(printf '%s' "$matches" | jq 'length')"

if [ "$match_count" -eq 0 ]; then
  exit 1
fi
if [ "$match_count" -ne 1 ]; then
  echo "Expected exactly one GitHub Release for ${tag}, found ${match_count}" >&2
  exit 2
fi

printf '%s' "$matches" | jq '.[0]'
