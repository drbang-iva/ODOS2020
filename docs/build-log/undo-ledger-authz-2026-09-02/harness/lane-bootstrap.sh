#!/bin/zsh
set -e
ROOT="${ODOS_ROOT:?set ODOS_ROOT to the ODOS2020 checkout}"
S="${EVIDENCE_SCRATCH:?set EVIDENCE_SCRATCH to a scratch directory}"
export MEDPLUM_BASE_URL=http://localhost:18103/
export MEDPLUM_ADMIN_EMAIL=contract-admin@odos.local
export MEDPLUM_ADMIN_PASSWORD="${MEDPLUM_ADMIN_PASSWORD:?set MEDPLUM_ADMIN_PASSWORD to the ephemeral contract-admin password used by ci.yml}"
export MEDPLUM_CONTRACT_BOOTSTRAP=1
export ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15432/medplum
export GITHUB_ENV="$S/lane-github-env"
: > "$GITHUB_ENV"
cd "$ROOT/mcp"
echo "== smoke lane bootstrap =="
node --import tsx --test --test-concurrency=1 tests/searchParamMedplumSmoke.test.ts 2>&1 | tail -8
node --import tsx --test --test-concurrency=1 tests/profile-validation.test.ts 2>&1 | tail -4
cat "$GITHUB_ENV"
export MEDPLUM_PROJECT_ID=$(sed -n 's/^MEDPLUM_PROJECT_ID=//p' "$GITHUB_ENV")
echo "MEDPLUM_PROJECT_ID=$MEDPLUM_PROJECT_ID"
echo "== throttle wait 61s =="
sleep 61
cd "$ROOT"
echo "== repair-practice-roles =="
npm run -s repair-practice-roles -- --email "$MEDPLUM_ADMIN_EMAIL" --project "$MEDPLUM_PROJECT_ID" 2>&1 | tail -15
echo "== sync --apply --bootstrap-service-identity (BASE roles.ts) =="
npm run -s sync-practice-role-policy-rules -- --project "$MEDPLUM_PROJECT_ID" --apply --bootstrap-service-identity 2>&1 | tail -15
echo "== DONE =="
