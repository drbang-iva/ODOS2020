# Education sequence operations — author evidence

Base `cf3a4f0a`, isolated branch `drbang-iva/seq2-operations`. No PR, push, merge, deployment, live service mutation, or independent verdict.

## Scope and behavior

- `createEducationSequenceOperations({fhir,practiceProjectId,now?})` persists stable conditional-create FHIR Tasks and lists them through project-scoped pagination. Returned project identity is checked on Tasks, Basic records, Patients, Encounters, and Communications. The existing shared FHIR page collector handles origin validation and pagination cycles.
- Task identity is `education-sequence-<hash(project,enrollment,row,reason)>` without a new canonical URL. The Task code is a local workflow label, not medical terminology. Task status/intent are requested/order; focus is the enrollment Basic. Only a parsed enrollment plus same-practice Patient proof can supply Task.for. A malformed enrollment has no fabricated patient.
- The list derives open/settled status, current version, row disposition/hold, exact held encounter and allowedActions from current enrollment state. Old Task status cannot claim the row is still actionable after review; repeat holds can reopen the same logical item without duplicate Tasks.
- New GET `/communications/education/sequence-work` and POST `/communications/education/enrollments/:enrollmentId/scheduled-sends/:rowId/review` use the existing `withStaff` wrapper unchanged. No dependency means refusal. Only a held provider role can perform clinical review; non-provider lists expose no actions. Review runs through caller FHIR policy enforcement and required enrollment If-Match.
- Clinician skip closes an authorized unsent logical row, resolves linked pending attempts as not-sent, and records explicit `runtime.clinicianSkip:{at,by,reason}` plus a released/clinician-skip event. It changes neither stage nor enrollment status, and counts as no delivery. It refuses unresolved in-flight work and recorded acceptance, including a Communication acceptance not yet projected onto the enrollment.
- Resume only releases a held row when current guards permit scheduling. Patient-seen requires the exact held Encounter reference and verifies its patient and practice. Print/expired work, terminal suppressed/not-sent attempts and own acknowledged-indeterminate attempts cannot be resumed into an unsupported fresh-key path. A clinician can skip instead when otherwise eligible. Other acknowledged blockers do not prevent review of a separate unsent row.
- Stored attempt validation now requires exact sendIndex/key/content/channel/lane binding, unique indices and keys across rows, predecessors earlier in the same row, valid acceptance instants, and exact true provider-never-invoked evidence. Clinician skip metadata validates actor, reason, instant and closed row state; it is never inferred from not-sent state.

## Integration interface

`EducationSequenceOperations` exposes:

```ts
staffItem(input: SequenceStaffItem): Promise<void>
list(): Promise<EducationSequenceWorkItem[]>
review(enrollmentId, rowId, input, callerFhir)
// input: {action:'skip'|'resume',reason,expectedVersion,actorReference,reviewedEncounterReference?}
// return: {enrollment,expectedVersion}
```

GET returns `{items}`. Item fields are `id`, `enrollmentId`, optional `rowId` and verified `patientReference`, `reason`, `at`, `state:'open'|'settled'`, required `allowedActions:('skip'|'resume')[]`, optional `expectedVersion`, `disposition`, `holdReason`, `channel`, and `encounterReference`. POST returns `{enrollment,expectedVersion}`. Conflict/refusal uses the existing typed HTTP 409 `{outcome:'refused',reason}` response; malformed request fields remain validation errors.

## Test-first and guard evidence

Initial operations import absent: harness exit 1. First three implementation tests then passed: malformed deduplication, explicit pending skip, and claim-winning stale conflict.

New actions/route tests initially failed because actions were absent and the new path reached the old catalog route. Added exact routes ahead of the generic education-detail route; 8/8 passed. Additional malformed metadata/binding probes initially failed with missing expected exceptions. One duplicate-binding test initially used a noncanonical row ID and was corrected to use `educationSequenceRowId` so it reached the intended binding guard; no production rule was weakened. No existing SEQ-1 fixture contract contradicted the strengthened validation.

Command for each guard:

```sh
npm --prefix mcp test -- tests/educationSequenceOperations.test.ts
```

1. Remove the Task If-None-Exist header: duplicate Task regression fails.
2. Remove the review-side assertReviewable invocation: skipping in-flight work becomes possible and its refusal regression fails.
3. Remove the added stored-attempt integrity block: all eight corruption probes fail.
4. Restore all code: 22/22 pass.

### Task dedup broken

```text
  ...
1..22
# tests 22
# suites 0
# pass 21
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 532.334208
```

### Clinical review guard broken

```text
  ...
1..22
# tests 22
# suites 0
# pass 21
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 398.760375
```

### Attempt-binding guard broken

```text
  ...
1..22
# tests 22
# suites 0
# pass 14
# fail 8
# cancelled 0
# skipped 0
# todo 0
# duration_ms 396.145542
```

### All guards restored

```text
  ...
1..22
# tests 22
# suites 0
# pass 22
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 370.6925
```

## Verification limits and handoff

These are author-side tests with synthetic records. The fake issues opaque UUID versions, enforces conditional Task creation, and rejects stale If-Match writes. It does not prove real Medplum policy, installed Task code search behavior, or real-server concurrency; the parent runtime/live proof and independent evaluator remain separate gates. The UI is a separate agent's change.

A later acceptance arriving after an indeterminate attempt was acknowledged remains a worker evidence-projection concern. Operations refuses skip/resume once that recorded acceptance is visible; it does not reopen or reinterpret the acknowledgement or expand the four-state model. Parent owns projection of acceptance evidence while preserving history.

No medical terminology or new canonical artifact URL was added. No strategy decision or decisions index change was made in this code checkout.

## Final author checks

```sh
npm --prefix mcp run build
npm --prefix mcp test -- tests/educationSequenceOperations.test.ts tests/educationSequence.test.ts tests/educationSequenceWorkerStore.test.ts tests/educationSequenceWorker.test.ts tests/educationEnrollmentApi.test.ts tests/commsApi.test.ts
```

Build exit 0. Regression exit 0:

```text
  ...
1..147
# tests 147
# suites 0
# pass 147
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2730.333166
```

`git diff --check` exit 0 with no output.
