# S3a profiles as data — blocked premise bundle

NOT EVALUATED. No application implementation, commit, push or PR was made.

## Summary

Freshly fetched origin/main exactly matches the requested b217714c base.
P2–P10 are verified; the content checker reproduces 85 matches and all rulings.
P1 overstates the section-group store's concurrency protection at this exact base.
The exact-module probe accepts two concurrent creates and two first seed overlays without conditional headers.
A stale client edit also succeeds because save reads the current version itself.
G9's literal unchanged full-suite count conflicts with adding the required new UI tests.
Implementation stopped under kickoff §1.2 and §1.10; no guard was weakened.
Only this evidence directory changed; no stack was started and no chart surface changed.

## Identity and files

- Branch: `drbang-iva/followup-s3a-profiles`.
- HEAD and refreshed origin/main: `b217714c2f8963a3c87d537fd00910133257c2a8`.
- PR URL: none; stopped before implementation.
- Changed files: `docs/build-log/followup-s3a-profiles/BLOCKED.md`, `premise-probe.mjs`, `premise-probe-results.json` (uncommitted).
- Open PR scope check: #626 changes AGENTS.md; #636 changes ephemeral-stack tooling. Neither overlaps the S3a allowlist.
- Companion design read at `9e1913b4`, including design §2.1–§2.3 and profiles.json. Companion files were not edited.

## Corrections needed

### 1. P1 is inaccurate at the pinned base, not changed by an upstream commit

`mcp/src/clinical-graph/finding-section-group-store.ts:77–107` does the following:

- `create()` performs an existence read and then an unconditional FHIR create. Its only header is `X-ODOS-Source`.
- The first `save()` of a seed overlay also performs an unconditional create.
- Updating an existing Basic sends `If-Match`, using the version just read inside `save()`. The returned group has no client `versionId`, and save accepts no expected version.

The existing concurrency test in `mcp/tests/findingSectionGroup.test.ts:352` injects a version bump **between the store read and update**. It correctly proves that narrower guard; it does not prove stale Settings-client protection or concurrent creation.

Reproducer (no source mutation, no server):

```sh
node --disable-warning=ExperimentalWarning docs/build-log/followup-s3a-profiles/premise-probe.mjs
```

Exit 0. The probe obtains the module with `git show origin/main:...`, checks the exact base, transforms that source in memory, and executes the real class against a synthetic client. Source SHA-256: `7620b123ba3c41184d031d43d8f1b5d41197f6ac15f8b7660c27d11e8fcb9fe4`.

```text
concurrentNewKey: acceptedCreates=2, conditionalHeaders=false
concurrentFirstSeedOverlay: acceptedCreates=2, conditionalHeaders=false
staleClientEdit: accepted=true, versionExposedToClient=false, updateIfMatch=W/"2"
```

These are observations of the base, not new S3a guard results or live-FHIR proof. Full structured output: [premise-probe-results.json](premise-probe-results.json).

Recommended correction: retain the seed-overlay/build/parse pattern, but explicitly permit the new profile store to require the caller's expected version, guard initial creation/first overlay against a competing creator, and preserve If-Match for updates. The existing section-group store remains unchanged. The existing exam-scope store demonstrates expected-version and conditional-create handling at `exam-scope-store.ts:38–58`; it need not be edited.

### 2. G9 needs to distinguish existing tests from added tests

G9 requires the full UI suite to pass "at the same counts as the base". Section 4 requires `ui/tests/followUpProfilesSettings.test.tsx`, and §1.5 forbids removing or shortening existing assertions. At the base, `ui/package.json` discovers `tests/**/*.test.tsx` in `npm test`, so new executable UI tests increase the total.

Recommended correction: all existing base tests must remain present and pass; report the base count, added-test count and new total. Keep G9 a verification of the chart-file allowlist plus the full UI suite, with no chart mutation.

## P1–P10 re-verification at origin/main

| Premise | Result |
| --- | --- |
| P1 | Partial: 405-line module, constants, constructor seeds, key overlay and coded Basic JSON build/parse confirmed. The claimed create/client-version protection is absent, as detailed above. |
| P2 | Confirmed: strict create/update schemas at lines 37/42/51; catalogue allows chart.read or finding-definitions.write; write gates at lines 121/152. |
| P3 | Confirmed: FindingSectionGroupsSettings exists and is mounted at ChartFieldsSettings.tsx:137, within the loaded catalogue surface; read-only indication at line 136. |
| P4 | Confirmed: index.ts imports the catalogue handler at line 272 and wires GET at line 6153, create at 6177, update at 6194. |
| P5 | Confirmed: preflight-lint.ts:423–437 hard-blocks unregistered ODOS StructureDefinition URLs; the existing section-group extension is a Basic string JSON extension. |
| P6 | Confirmed: CI runs blocking check-frontdoor-coverage.mjs at lines 299–300; it discovers backend route families and checks Caddy routes. Existing clinical-graph routes share /clinical-graph*. A new top-level profile prefix would need the requested new block. |
| P7 | Confirmed: plan-set-generator.test.ts:31–32 checks PROCEDURE_FEE_SEEDS membership or PENDING_ORDERABLES and names the offending key. |
| P8 | Confirmed: read-only profiles.json contains the five specified profiles. Replayed its unmodified checker from the pinned companion commit using origin/main; 85 checked, 85 match, 0 mismatch, all rulings hold. The checker was executed from a disposable temporary directory; it was not ported into ODOS or used as a replacement for G1/G2. |
| P9 | Confirmed: exam-overview-projection.ts:135–153 keys completeness by comprehensive/office-visit; office-visit requires History and Assessment only. exam-scope-store.ts:38–58 uses per-encounter expected-version, If-Match and conditional-create handling. Neither file changed. |
| P10 | Confirmed: design §2.1/§2.3 prohibits profile MDM; recursive source checker reports all rulings hold, including no MDM field. No new seed or accepted request body has been implemented. |

P8 observed output:

```text
ODOS ref: origin/main = b217714c2f8963a3c87d537fd00910133257c2a8
keys checked: 85   match: 85   mismatch: 0
rulings checked: all hold
checker exit: 0
```

## Unavailable content inventory from the source

No TypeScript seeds have been created. These are source references to preserve, not new orderable or clinical concepts.

| Reference | Why unavailable |
| --- | --- |
| oct-retina | No OCT retina orderable. |
| erg | Named only in the existing pending-orderables set. |
| ocular-surface-staining | Result section exists; no orderable. |
| tear-osmolarity | Result section exists; no orderable. |
| inflammadry-mmp-9 | Result section exists; no orderable. |
| meibography | Capture/result section exists; no orderable. |
| group:binocular-vision | Proposed section group, not built. |
| group:sensory | Proposed section group, not built. |
| anterior-segment-photography | Global shelf source entry: capture exists, no orderable. |
| punctal-plug-status | Proposed finding, not built; the existing procedure is not this finding. |
| dry-macular-degeneration, dry-eye, red-eye, binocular-vision history templates | Source marks these templates unbuilt. |
| rose-bengal | Source marks this dye choice absent from the shipped list. |
| vision-therapy episode type | Source explicitly marks it unbuilt; no new episode type created. |

Fundus photography already resolves. No billing code, clinical interval or new medical code was asserted. Mandate 14 ledger additions: 0.

## G1–G9 and proof status

G1–G8: not implemented or mutated because the premise gate stopped implementation. No red/green claims are made. G1's eventual oracle test location and imports remain to be implemented within the allowed test files.

G9 is a **verification**, as instructed: the allowlist prevents an in-slice chart mutation. Its diff check currently passes; its suite-count requirement needs the correction above.

```sh
git diff --name-only b217714c..HEAD
```

Exit 0, empty output. All uncommitted changes are under this build-log directory. No chart code changed.

Proof 1–4: not run; no Settings implementation or stack, no screenshots. Proof 5: full UI/MCP suites, typecheck and preflight not run at this premise stop; no baseline or after counts are claimed. This is a blocked bundle, not completion evidence or permission to omit those checks after resumption.

## Scope, risks and follow-ups

No outside-§4 edit has been made or identified as necessary for the two proposed corrections. Whether later full checks need another file remains untested.

Not done: profile store, five TypeScript seeds, endpoint, extension registration, Settings screen, key guards. Also not done, as required by the slice boundary: shape record; What are we following picker; board reading profiles; test queue; right-panel Follow-up tab; any change to how a visit opens or renders.

Related decision/design documents describe the intended follow-up profile, but this catalogue-only slice does not repair a chart shape. No decision was added, and decisions/INDEX.md is unchanged. The kickoff author owns design updates; the companion checkout remains read-only.

The base store observations are not authority to repair the existing section-group store. A resumed implementation still requires all requested suites, mutation guards, real synthetic-stack proof and independent Claude Opus 5 evaluation.

## Cleanup

No S3a stack or proof process was started. Command:

```sh
docker ps --filter name=odos-s3a- --format 'table {{.Names}}\t{{.Status}}'
```

Output:

```text
NAMES     STATUS
```

blocked
