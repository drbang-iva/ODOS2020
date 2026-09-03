#!/bin/zsh
# Re-syncs the lane's canonical policies from the CURRENT roles.ts using the fresh container's
# seeded Medplum super admin (the contract admin is policy-bound after repair and cannot PATCH).
S="${EVIDENCE_SCRATCH:?set EVIDENCE_SCRATCH to a scratch directory}"
source "$S/lane-env.sh"
export MEDPLUM_ADMIN_EMAIL=admin@example.com
export MEDPLUM_ADMIN_PASSWORD=medplum_admin
cd "${ODOS_ROOT:?set ODOS_ROOT to the ODOS2020 checkout}"
echo "roles.ts undo-ledger grant lines: $(grep -c 'odos-encounter-undo-ledger' mcp/src/authz/roles.ts)"
npm run -s sync-practice-role-policy-rules -- --project "$MEDPLUM_PROJECT_ID" --apply --bootstrap-service-identity 2>&1 | grep -v "^$" | tail -12
