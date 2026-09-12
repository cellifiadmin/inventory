#!/usr/bin/env bash
set -euo pipefail

stage="${CELLIFI_LOCAL_STAGE:-local}"
case "${stage}" in
  local|test) ;;
  *) printf '%s\n' 'CELLIFI_LOCAL_STAGE must be local or test.' >&2; exit 2 ;;
esac
for argument in "$@"; do
  case "${argument}" in
    --stage|--stage=*|-s*)
      printf '%s\n' 'Select the stage through CELLIFI_LOCAL_STAGE; forwarded stage flags are not allowed.' >&2
      exit 2
      ;;
  esac
done

service_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
infrastructure_root="${CELLIFI_INFRASTRUCTURE_ROOT:-${service_root}/../infrastructure}"
runtime_file="${CELLIFI_LOCAL_WORKFLOW_RUNTIME_FILE:-${service_root}/../.local/workflows/${stage}.json}"

cd "${service_root}"
exec python3 "${infrastructure_root}/scripts/run-local-workflow-service.py" \
  --service inventory --stage "${stage}" --runtime-file "${runtime_file}" \
  -- "${service_root}/node_modules/.bin/serverless" offline start --stage local "$@"
