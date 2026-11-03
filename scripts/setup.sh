#!/usr/bin/env bash
# Kept for backwards compatibility: the single-instance deployment is scripts/deploy.sh
# (the workshop site is part of the Helm chart). For a multi-attendee lab use scripts/lab.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/deploy.sh" "$@"
