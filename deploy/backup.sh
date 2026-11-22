#!/usr/bin/env bash
# Nightly backup of everything that is not reproducible: the database, the
# workspace files, and the Yjs document state.
#
# Needs restic and a repository, e.g.
#   export RESTIC_REPOSITORY=s3:s3.example.com/slw-backups
#   export RESTIC_PASSWORD_FILE=/srv/slw/.restic-password
set -euo pipefail

DATA_DIR="${DATA_DIR:-/srv/slw/data}"

restic backup "$DATA_DIR" \
  --tag slw \
  --exclude "$DATA_DIR/**/node_modules"

# Keep a month of dailies and a year of monthlies.
restic forget --tag slw --keep-daily 30 --keep-monthly 12 --prune

restic check --read-data-subset=5%
