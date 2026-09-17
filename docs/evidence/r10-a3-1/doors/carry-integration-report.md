# Carry integration with findings doors

The existing 97-test door aggregate initially had 95 passes and two failures after §3.5 integration. The route already had a validated encounter context; passing its pre-rebuild flag into the carry reader avoids redundant context queries. The unchanged paging assertion then passed. The old W45 fixture had only legacy lineage; it now supplies the strict canonical command plan and exact version witness. All W45 assertions remain unchanged (fixture mapping: V25/W75).

Final aggregate: 97 tests, 97 pass, 0 fail, 0 skipped, 0 todo. This overlaps the earlier 45-test findings read, 42-test commands, and 10-test door runs; counts are not additive.

Command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs --test mcp/tests/diagnosisFindings.test.ts mcp/tests/diagnosisFindingsCommands.test.ts mcp/tests/r10A3DoorGuards.test.ts`

Raw final output: `carry-integration-green.txt`. No production carry behavior or test expectation was weakened.
