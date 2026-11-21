#!/usr/bin/env bash
# Store a secret in .env, without the value passing through your shell history,
# this repo's git history, or an agent's transcript.
#
#   ./scripts/set-secret.sh ANTHROPIC_API_KEY             take it from your environment
#   ./scripts/set-secret.sh ANTHROPIC_API_KEY --prompt    type it, input hidden
#   ./scripts/set-secret.sh COOKIE_SECRET --generate      generate a random value
#
# Only the variable's name is ever printed.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env"
name="${1:-}"
mode="${2:-}"

if [[ -z "$name" ]]; then
  echo "usage: $0 NAME [--prompt|--generate]" >&2
  exit 64
fi
if [[ ! "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
  echo "error: '$name' is not a valid environment variable name" >&2
  exit 64
fi

case "$mode" in
  --generate)
    value="$(openssl rand -base64 32)"
    ;;
  --prompt)
    read -rsp "Value for $name (hidden): " value
    echo
    ;;
  '')
    value="${!name:-}"
    if [[ -z "$value" ]]; then
      echo "error: \$$name is not set in this shell." >&2
      echo "       export it first, or use --prompt to type it, or --generate." >&2
      exit 1
    fi
    ;;
  *)
    echo "error: unknown option '$mode'" >&2
    exit 64
    ;;
esac

if [[ "$value" == *$'\n'* ]]; then
  echo "error: value contains a newline" >&2
  exit 1
fi

umask 077
touch "$env_file"
tmp="$(mktemp "${TMPDIR:-/tmp}/env.XXXXXX")"
grep -v "^${name}=" "$env_file" > "$tmp" || true
printf '%s=%s\n' "$name" "$value" >> "$tmp"
mv "$tmp" "$env_file"
chmod 600 "$env_file"

echo "Stored $name in .env (${#value} characters). Restart the server to pick it up."
