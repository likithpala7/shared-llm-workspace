#!/usr/bin/env bash
# Pull, build, restart. Run on the server as the slw user.
#
#   ./deploy/deploy.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> fetching"
git pull --ff-only

echo "==> installing"
npm ci

echo "==> checking"
npm run typecheck
npm run test:unit

echo "==> building"
npm run build   # server/dist and client/dist; the server serves the client

echo "==> restarting"
sudo systemctl restart slw

echo "==> waiting for health"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health > /dev/null; then
    curl -fsS http://127.0.0.1:3001/api/health; echo
    echo "==> up"
    exit 0
  fi
  sleep 1
done

echo "!! did not become healthy; last 40 log lines:" >&2
sudo journalctl -u slw -n 40 --no-pager >&2
exit 1
