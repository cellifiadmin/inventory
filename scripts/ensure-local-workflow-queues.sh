#!/usr/bin/env bash
set -euo pipefail
inventory_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
infrastructure_root="${CELLIFI_INFRASTRUCTURE_ROOT:-${inventory_root}/../infrastructure}"
bootstrap="${infrastructure_root}/scripts/ensure-local-workflow-queues.py"
if [[ ! -f "${bootstrap}" ]]; then
  echo 'Set CELLIFI_INFRASTRUCTURE_ROOT to the infrastructure checkout containing the workflow queue bootstrap.' >&2
  exit 1
fi
python3 "${bootstrap}" --stage "${CELLIFI_LOCAL_STAGE:-local}"
