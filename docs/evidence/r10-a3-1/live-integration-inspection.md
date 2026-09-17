# §7 live draft integration inspection — read-only, not executed

Inspected `mcp/tests/r10OcularHealthDoorAuthzLive.test.ts` against current OH/carry/lifecycle interfaces. No live suite, capability gate, process, stack or credentials were run or changed in this inspection. The void/protocol work remains concurrent, so its final runtime behavior is not asserted here.

## Definite fixture defect

The `visit()` helper (line 129 in the inspected draft) creates every Encounter without `period.start`. Provider carry at lines 174–182 therefore cannot reach its expected Step 1 success: `diagnosis-carry-forward-endpoint.ts` lines 257–259 requires full source and destination start instants, and strictly earlier source time, otherwise returning `source-not-prior`. Supply explicit, deterministically ordered instants for source and destination. Using successive `Date.now()` values alone can still produce equal timestamps in a fast test. Staff carry remains an earlier authorization refusal and does not reveal this defect.

## Integration checks for the authorized live run

- OH's current `{commandId, patientReference, encounterReference, eyes:{OD:{loaded,selected,panel?,negativeAct?}}}` wire and history `eyes.OD.facts/panel` access match the draft. Clear/revive use the canonical baseline returned by history. No legacy wire fallback is needed.
- The current void response supplies `voidActionId`; undo expects that ID and the section key. Observation void records the canonical definition section key, matching the draft's section undo. Reconfirm after the void agent releases its final code; do not weaken superseded-undo zero-write checks if runtime fails.
- Carry response step fields and two command-tagged Provenances match the implemented plan/witness contract. Resend currently checks persisted fact versions and Condition/witness counts. The live lane's source/destination dates must be fixed first.
- The process lane uses the real `amend_observation` dispatch and session binding, checks both bundle entry statuses, and reads persisted Provenance. Its generic `create_observation` case intentionally proves public-schema refusal; the additional real append case exercises the shared-finding guard. Do not describe the create case alone as dispatch guard proof.
- Stored canonical policy equality, real Staff/Provider FHIR permissions (including Basic undo-ledger writes), and actual child-process service authentication still require execution. Static inspection cannot establish those facts. The authorized next action is the existing private own-stack live launcher once void/protocol are released; no G-gate rerun or new stack is needed.

No other definite wire mismatch was identified in this bounded inspection. This is an author integration note, not an independent evaluation or a live-pass claim.
