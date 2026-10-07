#!/usr/bin/env bash
# Graceful Litestream launcher for Stream Panel → R2/B2.
# Skips cleanly when unset — safe for local/dev without cloud credentials.
set -euo pipefail

if ! command -v litestream >/dev/null 2>&1; then
  echo "litestream: not installed; skipping remote replicate" >&2
  exit 0
fi

CONFIG="${LITESTREAM_CONFIG:-}"
if [[ -z "$CONFIG" ]]; then
  if [[ -f ./litestream.yml ]]; then
    CONFIG=./litestream.yml
  elif [[ -f ./litestream.yml.example ]]; then
    echo "litestream: copy litestream.yml.example to litestream.yml and set secrets via env; skipping" >&2
    exit 0
  else
    echo "litestream: no config; set LITESTREAM_CONFIG or add litestream.yml; skipping" >&2
    exit 0
  fi
fi

if [[ -z "${STREAM_PANEL_DB_PATH:-}" ]]; then
  echo "litestream: STREAM_PANEL_DB_PATH unset; skipping" >&2
  exit 0
fi

ACCESS="${AWS_ACCESS_KEY_ID:-${LITESTREAM_ACCESS_KEY_ID:-}}"
SECRET="${AWS_SECRET_ACCESS_KEY:-${LITESTREAM_SECRET_ACCESS_KEY:-}}"
if [[ -z "$ACCESS" || -z "$SECRET" ]]; then
  echo "litestream: access key / secret unset; skipping remote replicate" >&2
  exit 0
fi

export AWS_ACCESS_KEY_ID="$ACCESS"
export AWS_SECRET_ACCESS_KEY="$SECRET"

exec litestream replicate -config "$CONFIG"
