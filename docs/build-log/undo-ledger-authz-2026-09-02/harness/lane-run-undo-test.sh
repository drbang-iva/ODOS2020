#!/bin/zsh
# Runs the new real-Medplum undo-ledger lane exactly as the CI step will.
S="${EVIDENCE_SCRATCH:?set EVIDENCE_SCRATCH to a scratch directory}"
source "$S/lane-env.sh"
cd "${ODOS_ROOT:?set ODOS_ROOT to the ODOS2020 checkout}"/mcp
echo "roles.ts undo-ledger grant lines: $(grep -c 'odos-encounter-undo-ledger' src/authz/roles.ts)"
echo "git HEAD: $(git rev-parse HEAD)  dirty: $(git status --porcelain | wc -l | tr -d ' ')"
node --import tsx --test --test-concurrency=1 tests/encounterUndoLedgerAuthzLive.test.ts
echo "EXIT $?"
