export MEDPLUM_BASE_URL=http://localhost:18103/
export MEDPLUM_ADMIN_EMAIL=contract-admin@odos.local
export MEDPLUM_ADMIN_PASSWORD="${MEDPLUM_ADMIN_PASSWORD:?set MEDPLUM_ADMIN_PASSWORD to the ephemeral contract-admin password used by ci.yml}"
export MEDPLUM_CONTRACT_BOOTSTRAP=1
export ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15432/medplum
# The contract project is created fresh by lane-bootstrap.sh, which records its id in
# "$EVIDENCE_SCRATCH/lane-github-env" exactly as the CI bootstrap exports it to GITHUB_ENV.
# Read it from there; never pin a run-specific UUID here.
_LANE_ENV_FILE="${EVIDENCE_SCRATCH:?set EVIDENCE_SCRATCH to a scratch directory}/lane-github-env"
if [ -z "${MEDPLUM_PROJECT_ID:-}" ] && [ -f "$_LANE_ENV_FILE" ]; then
  export MEDPLUM_PROJECT_ID="$(sed -n 's/^MEDPLUM_PROJECT_ID=//p' "$_LANE_ENV_FILE" | tail -1)"
fi
export MEDPLUM_PROJECT_ID="${MEDPLUM_PROJECT_ID:?run lane-bootstrap.sh first; it records MEDPLUM_PROJECT_ID in $_LANE_ENV_FILE}"
