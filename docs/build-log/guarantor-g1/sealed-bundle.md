# Guarantor G-1 — author proof bundle

**NOT EVALUATED. P7 and P11a pass, with deliberate reds and restored greens.** The ten previously accepted guards and mutations are retained. P11b retains its accepted live evidence. The transaction feature remains off; stop 1 remains discharged.

Branch: `drbang-iva/guarantor-g1`. Base: `e848450f93c4703c04f71187119a877b462a7408`. Application/test/ledger commit after rebase: `fbc97901`. The PR head, including evidence commits, is the exact target for independent evaluation. [Source hashes, rebase mapping, and boundary checks](rebase/source-verification.json) bind the refreshed live mutations to the submitted production bytes.

## Rebase verification

The branch was rebased from `6f8a45a1` onto `e848450f` without conflicts. All three existing commits replayed unchanged. The base delta contains only `mcp/package.json` and `mcp/package-lock.json`; both dependency files exactly match the new base. `npm ci` completed in the task worktree, installing direct csv-parse 7.0.2 and fast-uri 3.1.7. No application, test, or ledger bytes changed during the rebase.

The nine base suites were freshly measured in an isolated checkout of `e848450f`: **49 / 99 / 32 / 29 / 20 / 3 / 4 / 8 / 17**, totaling **261 passed**, with no disagreement. [Commands, counts, and per-file output](rebase/base-counts.json). P7 and P11a were then replayed with fresh real-server captures, including a new constant-failure base capture at `e848450f`; both produced **0 / 1 / 0**. The ten other accepted mutation cycles remain valid against identical source/test hashes and were not rerun. [Reproduction and provenance](rebase/README.md).

## Change and accepted permission delta

Registration creates one Person per non-self responsible party, using the same demographics builder as RelatedPerson and linking to that party's RelatedPerson with assurance level2. Self creates none; two identical guardians in separate registrations create separate Persons. Account still references RelatedPerson. No reader, matching, migration, editor, or second writer was added.

Person stays in the practice read list. Its standalone **staff practice-scoped create/update** rule replaces the ineffective patient-compartment grant. This explicitly permits staff to update any Person in their practice, broader than RelatedPerson's patient-compartment write scope. There is no delete grant or additional history/vread grant. A tighter editor constraint is deferred to G-2 by the supplied ruling.

Files changed: `mcp/src/authz/roles.ts`, `mcp/src/clinic/patient-registration-endpoint.ts`, `mcp/tests/guarantorPerson.test.ts`, `mcp/tests/patientRegistrationAuthz.test.ts`, `data/code-bindings/patient-identity-ledger.md`, and this evidence directory. The temporary census change returned exactly to base because Person writes no longer have a search criterion.

## Live P7

Real staff ClientApplication, ProjectMembership, generated AccessPolicy, and HTTP transport against disposable `medplum/medplum-server:5.1.30` on `127.0.0.1:19413`. All resources and identities are synthetic. Only audit recording is stubbed.

| Request | Rule present | Remove only Person write rule | Restore rule |
|---|---:|---:|---:|
| Staff GET Person | 200 | 200 | 200 |
| Staff PUT Person | 200 | **403** | 200 |
| Staff POST Person | 201 | **403** | 201 |
| Staff DELETE Person | 403 | 403 | 403 |
| Staff PUT RelatedPerson control | 200 | 200 | 200 |

The same live assertion exits **0 → 1 → 0**. Requests, responses, generated policies, and resolved Person links: [green](rebase/p7-ruled-green.json), [red](rebase/p7-ruled-red.json), [restored](rebase/p7-ruled-restored.json). The [mutation manifest](rebase/ruled-mutations.json) records exact commands and original/mutated source hashes. The revised declaration test also failed on the old compartment grant and passed with the ruled grant: [red](p7-ruled-unit-red.txt), [green](p7-ruled-unit-green.txt).

## Live P11a and accepted P11b

P11a holds the failing entry constant: RelatedPerson has the same invalid numeric name in both base and current requests. The server rejects that entry in each. The comparison checks complete persisted Patient/Account/RelatedPerson bodies and MRN state, normalizing only generated ids, MRN values, synthetic unique family suffixes, and server version/timestamp metadata. Additional Persons are counted and retained outside this comparison.

| Residue | Base RP failure | Current RP failure | Compensation mutation | Restored |
|---|---:|---:|---:|---:|
| Patient count | 1 | 1 | **0** | 1 |
| RelatedPerson count | 0 | 0 | 0 | 0 |
| Person count | 0 | 1 | 0 | 1 |
| Account status | active | active | active | active |
| MRN on Account | yes | yes | yes | yes |
| MRN on Patient | yes | yes | **no** | yes |
| Pending allocation marker | absent | absent | absent | absent |

Mutation: change the existing client option `autoRollbackCreatedEntries: false` to `true`. It removes the Patient after the failed entry and makes the parity assertion fail. This option is restored to false in the submitted code. Assertion exits **0 → 1 → 0**: [green](rebase/p11a-green.txt), [red](rebase/p11a-red.txt), [restored](rebase/p11a-restored.txt). Full captures: [base](rebase/base-residue.json), [current](rebase/p11a-green-residue.json), [mutant](rebase/p11a-red-residue.json), [restored](rebase/p11a-restored-residue.json).

P11b's previously accepted [Person-failure capture](current-residue.json) retains Patient, active Account, MRN, and the successful RelatedPerson, with no Person persisted. That evidence was not reclassified as a regression or unnecessarily rerun.

A fresh post-rebase direct database read confirms the Project feature remains absent: [feature state](rebase/final-feature-state.json). The earlier [preflight capture](feature-preflight.json) remains historical evidence of the discharged stop.

## Accepted guards and mutation evidence

P1–P6, P8–P10, and P12 each have one passing test, one deliberately failing test, then one passing restored test; exits **0 / 1 / 0**. These accepted mutations were not rerun. [Manifest and exact commands](mutations/manifest.json).

| Guard | Demonstrated mutation |
|---|---|
| P1 | [Omit Person link](mutations/P1-red.txt) |
| P2 | [Create Person for self](mutations/P2-red.txt) |
| P3 | [Link both Persons to the first RelatedPerson](mutations/P3-red.txt) |
| P4 | [Reuse a name/birthDate match](mutations/P4-red.txt), producing one Person request instead of two |
| P5 | [Change the shared phone mapping](mutations/P5-red.txt); frozen base bytes catch a shared error |
| P6 | [Drop the project wrapper](mutations/P6-red.txt) |
| P8 | [Repoint Account to Person](mutations/P8-red.txt); the statement loses its recipient |
| P9 | [Change guardian phone bytes](mutations/P9-red.txt) |
| P10 | [Repoint Account guarantors to Person](mutations/P10-red.txt) |
| P12 | [Put Account first](mutations/P12-red.txt) |

The deliberately wrong P4 cache uses undefined birthDate because ResponsiblePartyInput has no birthDate field. Production has no matching/cache behavior. P8 and P9 also passed against actual base and restored source, two tests each: [base](regression-proofs/P8-P9-base.txt), [current](regression-proofs/P8-P9-current.txt).

The existing registration fixture is **decorative for Person policy coverage**: it stays 29/29 when the Person grants are removed because it uses a service fake, not AccessPolicy enforcement. [Observed output](regression-proofs/registration-role-grants-red.txt). Its changed entry assertions are enforced: omitting Person gives 24 pass / 5 fail; restoration gives 29/29. [Red](regression-proofs/registration-entry-counts-red.txt), [restored](regression-proofs/registration-entry-counts-restored.txt). No unaffected accepted guard was decorative.

## Checks and limits

| Command | Actual result | Exit | Output |
|---|---|---:|---|
| `npm --prefix mcp test -- tests/guarantorPerson.test.ts tests/patientRegistrationAuthz.test.ts ../tests/preflight/fhir-read-grant-check.test.ts` | 54 tests, 54 pass, 0 fail, 0 skipped | 0 | [log](rebase/focused.txt) |
| `npm --prefix ui test` | 1449 tests, 1449 pass, 0 fail, 0 skipped | 0 | [log](rebase/ui-full-summary.txt) |
| `npm --prefix mcp test`, task-owned PostgreSQL configured | 4704 tests, 4656 pass, 0 fail, 48 skipped | **1** | [log](rebase/mcp-full-summary.txt) |
| `npm --prefix mcp run build` | TypeScript build completed | 0 | [log](rebase/mcp-build.txt) |
| `npm --prefix ui run build` | 320 modules transformed; production assets built | 0 | [log](rebase/ui-build.txt) |
| New-base concurrency check | 3 tests, 3 pass, 0 fail | 0 | [log](rebase/base-demographicsConcurrency.txt) |
| `git diff --check` | No whitespace errors | 0 | Checked before commits |

**The full MCP gate is not green:** it retains exit 1 because 41 of the 48 skips belong to unconfigured general credentialed live lanes. No opt-out was used. The dedicated G-1 P7/P11a runs above are real-server proofs, not substitutes for every unrelated live lane. The UI build retains its large-chunk warning. The pre-change floor was freshly re-established at the new base: [261 passing tests across all nine requested files](rebase/base-counts.json).

## Reproduction and handoff

The reproduction directory contains script text copies for the live probes and mutation runner; see its [restore instructions](reproduction/README.md) and the [refreshed base capture instructions](rebase/README.md). Published output is path-sanitized; the commands, assertion results, and source hashes are preserved. Restore the `.txt` source copies to ignored `.odos/guarantor-g1/` without the `.txt` suffix and use the existing task-owned runtime/Compose configuration there; it contains local synthetic credentials and is deliberately excluded. `ruled-mutations.mjs` runs the current P7 and P11a cycles. `mutations.mjs` is historical accepted-proof source, not the revised P7 runner. Manifest `output` names the local `.log` file, `publishedOutput` names the committed `.txt` export, and `env` records explicit non-secret run settings. The evidence preserves actual statuses and failing assertions, not just command exit summaries. Early observer attempts encountered a deleted-resource response and a login rate limit; neither was counted as a guard red. Final recorded cycles completed normally.

F16 is byte-identical, the insurance writer is unchanged, and no If-Match assertion changed. Source hashes match the live mutation originals. No root-checkout dependencies, real practice, or production service was touched. The task-owned stack and synthetic volume are retained for review.

Mandate 14: three ledger rows, each with two primary sources and access date 2026-09-13. The ledger is documentary and not automatically enforced by deletion tests. No new design decision or decisions-index edit was made; the supplied rulings were implemented. G-2 editor constraints/search/linking and G-3 migration remain separate follow-ups.

**NOT EVALUATED.** CodeRabbit and PR-Agent are first-pass review signals only. An independent Fable, high session must evaluate the exact PR head before merge. This author cannot issue that verdict or apply an evaluation override.

## First bot review adjudication

CodeRabbit reviewed `0bdc7a62` and raised seven inline findings. PR-Agent reported no major issues or security concerns. Evidence-only fixes normalize workstation paths at the shared output writer and publication boundary, record explicit P7 output-path environment settings, distinguish local log names from published names, and clarify where source snapshots must be restored. No application permission or failure-path change followed this review.

The requested Person cleanup and exact additional-Person count were not applied: P11a explicitly permits additional Person residue and requires parity only for the pre-existing resources. P1/P3 separately enforce normal registration counts. The root-calculation concern assumed running a `.txt` snapshot from the documentation directory; the supported restore location is `.odos/guarantor-g1/`, where `../..` is the repository root.

The provider/admin authorization concern is not applicable to the registration service path. `registerPatientFromDemographics` calls `deps.serviceFhir.executeTransactionAsActor`; the actor role is audit attribution, while `performTransaction` uses that client's credential headers. It does not switch to a provider/admin credential. Additional real-server runs with provider and admin audit roles both returned registration 201 and persisted the linked Person: [provider](provider-registration.json), [admin](admin-registration.json). No additional grants were introduced.

The generic docstring-coverage warning conflicts with the repository's default-no-comments instruction and is not applied. The independent-evaluation gate remains intentionally unsatisfied by the author.
