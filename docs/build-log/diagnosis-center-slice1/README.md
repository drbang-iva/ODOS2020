# Diagnosis-center slice 1 — sealed author bundle

Status: **needs-review**. Local implementation of accepted R5; no PR, push, merge, deployment, or independent evaluation. Branch: `drbang-iva/dx-status`. Worktree: `.worktrees/dx-status`.

Ten stored visit statuses now have nine clinician-selectable options, with `new` retained for provenance only. Both independent UI/server constants were updated. The ninth complexity choice, `not-addressed-no-mdm` / **Not addressed today / No MDM**, is explicitly answered but excluded from every MDM bucket and the missing-classification count. `sourceDiagnosisCount` still describes all source diagnoses. Existing MDM thresholds are unchanged.

Both controls render beside each other in the diagnosis header. Assessment's copies and obsolete save handlers/props were removed; its other diagnosis actions and protocol-status reads remain. A stored `new` value renders the disabled placeholder, is not rewritten on load, and is not present in the picker options. Signed/read-only/loading/busy controls cannot be edited. The existing `DiagnosisProblemStatusField` definition remains exported from Assessment, as before, but Assessment no longer renders it.

The additional consumer fixes are necessary vocabulary alignment: protocol validation now uses the server constant and its type derives from the same source, preventing newly selected statuses from being rejected by Assessment's existing protocol-offer request. Protocol Library's status-scope checkboxes still support `new` as a provenance trigger; they do not assign a clinician's diagnosis status.

## Source verification

Read the companion checkout at `../performance-od`; verified its `decisions/` directory. Read `core/operations/open-source-od/segments/diagnosis-center-workspace-design.md` §1, §2.1, §7 item 1, and `decisions/2026-09-14-odos-diagnosis-center-design-rulings-r1-r9.md` R5. This implements an accepted decision; no new decision or `decisions/INDEX.md` entry was created.

Fetched main: **`6baea1d51666461e3de94ded1287ffe8817d2f70`**. Compared with supplied `ddf6ba4a4f5e06efb13c59759d4941159fe49d0a`: one merge, **Guarantor link operations and recovery (#592)**. None of the cited diagnosis source files changed. Re-fetched during final checks: same main. No open PR at start; PR #593 appeared later and its file list has no overlap.

Reverified the two visit-status constants; both MDM constants and their extension readers; `computeMdmHint` and `incrementMdmCount`; DiagnosisWorkspace's existing complexity field; Assessment's status options, loader, save handlers, and header block; `diagnosis-visit-status-endpoint.ts`'s `z.enum` (currently line 35 rather than the supplied line 33); and the SQL `status TEXT NOT NULL` without CHECK constraint. No SQL migration.

Before edits, searched every direct consumer of `DIAGNOSIS_VISIT_STATUSES` and `MDM_PROBLEM_STATUSES` across `mcp` and `ui`. Follow-up search for `DiagnosisVisitStatus` and `resolved-this-visit` found the separately spelled protocol type and validator. The existing canonical-artifact parity test also requires the local CodeSystem to match the two MDM constants.

The existing local MDM CodeSystem and ValueSet are version 0.6.1, retaining their canonical URLs. The ValueSet includes the whole CodeSystem. The Mandate 14 ledger row in `data/code-bindings/extension-urls.md` was updated and a local-exclusion verification row added. FHIR publication mechanics were checked against [HL7 R4 CodeSystem](https://hl7.org/fhir/R4/codesystem.html) and [HL7 R4 ValueSet](https://hl7.org/fhir/R4/valueset.html), accessed 2026-09-14. These agree on definition versus selection and canonical identification. The exclusion's semantics come from the operator's accepted R5/design, not an external AMA/CMS code. No medical terminology code or E/M threshold was introduced. Ledger prose is documentation, not an enforced registry; the CodeSystem/constant parity is enforced and mutation-tested.

## Checks and guards

See [checks.txt](checks.txt) for exact commands and captured output/counts. Baselines: UI diagnosis workspace 37/37; MCP status/view-model 15/15. Expanded focused checks: UI 66/66; MCP 64/64. The initial full UI run had 1,500 passes and one selector failure in the adapted Assessment walkthrough (`Resolved` versus the existing lowercase label `resolved`); corrected and rerun. Final results are recorded in checks.txt.

| Guard | Deliberate break | Broken result | Restored result |
|---|---|---|---|
| No MDM exclusion | Remove `if (status === "not-addressed-no-mdm") continue;` | 0 pass / 1 fail; `High` instead of `None` | 1 pass / 0 fail |
| Provenance-only `new` | Remove `.filter((status) => status !== "new")` from the header options | 0 pass / 1 fail; option present | 1 pass / 0 fail |
| Server visit vocabulary | Remove `well-controlled` entry | 0 pass / 1 fail | 1 pass / 0 fail |
| UI visit vocabulary | Remove `well-controlled` entry | 0 pass / 1 fail | 1 pass / 0 fail |
| Server MDM vocabulary | Remove `not-addressed-no-mdm` entry | 0 pass / 1 fail | 1 pass / 0 fail |
| UI MDM vocabulary | Remove `not-addressed-no-mdm` entry | 0 pass / 1 fail | 1 pass / 0 fail |
| CodeSystem parity | Remove ninth concept | 0 pass / 1 fail | 1 pass / 0 fail |

Every broken/restored TAP transcript is included beside this file. The No-MDM test also checks a mixed addressed/excluded visit and an excluded/unanswered visit; the latter reports exactly one missing classification. The header test mounts the real DiagnosisWorkspace, checks no `new` option and nine selectable codes, invokes the real client, checks the selected Condition URL/body, and verifies reload. Endpoint coverage exercises all ten stored statuses, rejects an unknown value, and submits each valid status through protocol-offer validation.

## Browser evidence and limits

Run `node docs/build-log/diagnosis-center-slice1/browser-proof.mjs` from the worktree. The harness owns Vite on strict port 19971 and closes its browser/server. It mounts the real DiagnosisWorkspace in Chromium and intercepts all clinical HTTP with synthetic data. It verifies nine options/no New, the selected Condition's PUT, the Encounter complexity PATCH, both values after reload, and zero page errors/visible alerts. The port's listener was verified as the harness's Node process.

[Options screenshot](visit-status-options.png) · [Saved and reloaded screenshot](saved-reloaded.png) · [HTTP assertions](browser-proof.json).

This is **component browser proof**, not an authenticated app-route walkthrough or live Medplum/Postgres proof. The app route's existing DiagnosisWorkspace import/render was inspected in `ui/src/scenes/EncounterCharting.tsx`; no route or proxy was changed. The proxy census reported 25 backend route families and 28 proxy entries, all covered (advisory). No AccessPolicy was changed or live authorization claimed. No running server's terminology artifacts were installed; deployment must use the existing artifact installation process. The UI build retains its large-chunk warning.

Plans strip, findings, write-ups, R10/R11, the E&M footer/override, and cross-repo design changes remain out of scope. Independent evaluation by Fable/Opus is still required before merge. No bot review was requested because the operator withheld PR posting authorization.

## Every file touched

See [files.txt](files.txt), including all source, tests, terminology, ledger and evidence artifacts. Generated build output and dependency symlinks are ignored, not part of the patch. Commit identity is reported in the accompanying handoff; the commit contains this bundle and its evidence.
