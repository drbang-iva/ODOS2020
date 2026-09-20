# E1a fixback 1 sealed bundle — PR #634

Status: **needs-review — NOT EVALUATED**. Same branch/PR; no merge, deployment, bot trigger, or review-thread resolution.

Legacy stored transactional and marketing items now normalize to eyecare when classification is absent.
Fresh marketing publications still require explicit classification; real content/hash changes still refuse.
Promotional email refuses unconditionally until E1c implements the actual mechanism; the obsolete environment/dependency flag is removed.
Channel publication is checked before offer availability, restoring the established refusal reason.
G18's schema-byte drift tripwire is restored alongside behavioral fixture coverage.
All original a–f guard groups and the fixback guards were deliberately broken/restored: 29 pairs.
Full MCP/UI suites and builds completed; Staff web-tier evidence accompanies this bundle.

## Identity and scope

- Worktree: `/Users/ericr.bang/.codex/worktrees/email-e1a-envelope/ODOS2020`; branch `codex/email-e1a-envelope`.
- Fixback input head: `3b3bd7ce3c7e29fcb839bc33951be9cbf5d2cea3`; implementation/test commit: `b2d706a1b3286e44edf5be29596e739a4602e8da`.
- The following evidence commit changes only build-log artifacts. [Tested file hashes](tested-files.json) bind all changed application/test/config files to the tested code; the PR head is the independent evaluation target.
- Original branch base: `f2ef2c325e36d756759a525339431d70c7bcfde1`. Freshly fetched `origin/main`: `da799f4eb9c290cf6e6e270b0031562e2b432d8a`; no rebase/reset performed.
- Read the independent evaluation from companion commit `2d70cb9f`, `decisions/2026-09-20-odos-email-e1a-pr634-eval-needs-revision.md`. Companion checkout read-only.
- Open-PR scope query found only #626 besides this PR; it changes AGENTS.md, with no implementation overlap.
- All data/proof synthetic and local. No Iris, cloud, DNS, account configuration, real send, unsubscribe endpoint/header/token/KV, purpose mapping, matrix/default, or staff-override changes.
- No new medical codes, FHIR artifact URLs, regulatory assertions, or decisions introduced; no Mandate 14 ledger/decisions index changes. Existing legal-verification debt remains as recorded by the evaluator.

## Files touched in this fixback

- `.env.example`
- `docs/build-log/email-e1a-envelope/proof/browser.mjs`
- `docs/build-log/email-e1a-envelope/proof/mutations.py`
- `docs/build-log/email-e1a-envelope/proof/seed.ts`
- `mcp/src/comms/comms-api.ts`
- `mcp/src/comms/visionforge-education-catalog.ts`
- `mcp/src/index.ts`
- `mcp/tests/commsApi.test.ts`
- `mcp/tests/commsSuppression.test.ts`
- `mcp/tests/educationDispatchActor.test.ts`
- `mcp/tests/visionforgeEducationCatalog.test.ts`
- `scripts/fhir-read-grant-check.ts`
- `docs/build-log/email-e1a-envelope/HANDOFF.md` marks the original bundle as superseded.
- `docs/build-log/email-e1a-envelope/fixback-1/` contains the sealed bundle, test logs, mutation patches/results, Staff screenshot/identity, and source hashes.

## Choices and re-verified premises

**Blocking 1:** a stored-item preprocessor supplies `eyecare` only when the property is absent, then passes the result through the existing strict item schema. `loadBaseline` now uses the parsed `localCopy`. This migrates historical meaning in memory without rewriting the stored raw envelope or performing writes on load. Explicit cosmetic survives; null/unknown values and unrelated invalid fields still fail. Fresh envelopes continue to use the strict original entry schema, avoiding a permissive publication path.

- Before fix: `3b3bd7ce:mcp/src/comms/visionforge-education-catalog.ts:102` discarded the parse; line 104 cloned the raw row; line 142 compared unequal representations. [Executed before output](checks/regressions-before.log): **4 pass / 5 fail**, including unchanged upstream → `meaning-changed`, legacy marketing → `unavailable`, and nonempty flag → HTTP 200 instead of 409.
- Fixed: `mcp/src/comms/visionforge-education-catalog.ts:41` strict fresh entry, `:48` stored-only normalization, `:109` retained parse result, `:149` unchanged content/hash comparison. Tests at `mcp/tests/visionforgeEducationCatalog.test.ts:287` (R1), `:297` (R2), `:313` (R4).
- R1/R2/R4 use the real PostgreSQL snapshot store in per-test schemas and a loopback HTTP upstream. The malformed/foreign stored-row probes inject corrupted load results through the store interface; they assert no network or writes.

**Blocking 2:** removed the runtime environment read, public deps field, and `.env.example` advertisement; `mcp/src/comms/comms-api.ts:1107` now refuses marketing email unconditionally. This avoids asserting that configuration supplies a mechanism the code does not render. The staff-visible refusal wording is unchanged. R3 supplies unset, empty, `x`, and a URL through real provider environment settings and an unknown legacy deps property; all refuse before provider calls/reservations (`mcp/tests/commsApi.test.ts:2897`).

**Ordering:** `mcp/src/comms/comms-api.ts:1080` publication precedes `:1083` offer gating. R5 (`mcp/tests/commsApi.test.ts:2909`) expects the established publication error for unpublished marketing email; published marketing remains refused.

**G18:** the pin at `mcp/tests/visionforgeEducationCatalog.test.ts:346` now fails on any byte edit within the item-schema block, alongside the captured-fixture behavior test. It pins reviewed ODOS bytes as an explicit compatibility-assessment tripwire; it does not certify live VisionForge equivalence. The max-title-length mutation proves the tripwire is enforced.

**Original contracts retained:** Communication's frozen item/title remains at `comms-api.ts:1270`; Provenance stays ID@version without title at `:2561`. The neutral subject is resolved at `:1099`, passed to the preflight at `:1147` and send at `:1373`. Prepared marketing dispatch is refused at `:1267`; historical receipts reconcile before a new-send gate. Both original provenance functions are unchanged.

**Test-scope adjustment:** positive marketing-email dispatch fixtures cannot remain valid under unconditional refusal. The prior email default-ON/no-recorded-consent and explicit-OFF assertions now run directly through the actual suppression wrapper (`commsSuppression.test.ts:1226`); they are still mutation-demonstrated (e). SMS consent revocation/reconciliation remains covered. Separate actor tests refuse marketing email in either preference state, reject a legacy prepared marketing send before reservation, and reconcile a synthetic already-sent marketing email receipt without provider/catalog access. No public configuration bypass was retained solely for tests.

## Checks and commands

Commands ran from the worktree root. Exact commands and exit codes: [commands.json](checks/commands.json).

| Command | Actual result | Output |
| --- | --- | --- |
| `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:29433/medplum ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | exit 0; 6,144 tests, **6,089 pass / 0 fail / 55 skipped**, 151,170.681ms | [summary](checks/mcp-full.summary.txt), [complete raw gzip](checks/mcp-full.log.gz) |
| `npm --prefix ui test` | exit 0; **1,771 pass / 0 fail / 0 skipped**, 210,806.546ms | [summary](checks/ui-full.summary.txt), [complete raw gzip](checks/ui-full.log.gz) |
| `npm --prefix mcp run build` | exit 0, TypeScript compilation | [output](checks/mcp-build.log) |
| `npm --prefix ui run build` | exit 0, TypeScript + Vite, 333 modules; existing large-chunk warning | [output](checks/ui-build.log) |
| `npm run typecheck:scripts` | exit 0 | [output](checks/scripts-typecheck.log) |
| `npm run preflight` | exit 0, **0 warnings / 0 hard blocks** | [output](checks/preflight.log) |
| `node .claude/skills/tier0-census/scripts/check-proxy-coverage.mjs` | exit 0, 25 route families / 28 proxy entries, no missing family; advisory checker | [output](checks/proxy-census.log) |
| `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:29433/medplum npm --prefix mcp test -- --test-name-pattern='R[12345] |stored migration|G18' tests/visionforgeEducationCatalog.test.ts tests/commsApi.test.ts` | exit 0, **19 pass / 0 fail** | [output](checks/regressions-after.log) |
| `git diff --check` | exit 0 | run before commits |

The earlier four root-dependency TypeScript errors remain resolved by the root dependency installation from the original slice. No dependency/lockfile change was needed in this fixback; both MCP build and root script typecheck were re-executed successfully. This is not being classified as an untouched-main build failure.

The MCP run explicitly acknowledges **47 credential-gated live-stack skips** within 55 total skips. It does not prove the entire live-authorization lane. The separate browser proof below verifies the requested Staff route, not every policy action. No real Google send was attempted.

Published-consumer/fixture and wrapper census was refreshed in [consumer-census.txt](consumer-census.txt). The full suite includes catalog/picker/pinned dispatch, sequence worker, configured provider wrapper, plan-set/protocol fixture guards, and persisted restart cases. The only catalog-reader product change is stored normalization; the existing seed versus published-reader wiring is unchanged.

## Deliberate break/restore pairs

Runner: `E1A_EVIDENCE="$PWD/docs/build-log/email-e1a-envelope/fixback-1" python3 docs/build-log/email-e1a-envelope/proof/mutations.py /tmp/odos-email-e1a-fixback-proof` — exit 0.

The separate checkout contained the exact candidate application/tests, with local dependencies linked. Each case changes **product code**, runs the named test, restores exact original bytes in `finally`, and re-runs it. Every broken run exited **1**; every restored run exited **0**, with zero restored failures. Product hashes match the implementation checkout after restoration. Full test names, real commands/output, and source hashes are in the linked logs and [results.json](mutations/results.json); each mutation patch is retained as `.diff.gz`. Original guard groups **a–f** are all re-run. R3 shares the unconditional marketing-gate mutation with d; R4 tests both title and hash.

| Guard / named failing output | Deliberate product break | Broken pass / fail | Restored pass / fail |
| --- | --- | --- | --- |
| [a-subject](mutations/a-subject-broken.log) | Return the condition-bearing title as subject | 0 / **1** | [1 / 0](mutations/a-subject-restored.log) |
| [a-footer](mutations/a-footer-broken.log) | Remove appended footer | 0 / **2** | [2 / 0](mutations/a-footer-restored.log) |
| [a-chart-title](mutations/a-chart-title-broken.log) | Erase frozen item title | 0 / **1** | [1 / 0](mutations/a-chart-title-restored.log) |
| [a-provenance-title](mutations/a-provenance-title-broken.log) | Add title to Provenance display | 0 / **1** | [1 / 0](mutations/a-provenance-title-restored.log) |
| [b-required](mutations/b-required-broken.log) | Allow blank required fields | 0 / **2** | [2 / 0](mutations/b-required-restored.log) |
| [b-unresolved](mutations/b-unresolved-broken.log) | Allow unresolved template values | 0 / **3** | [3 / 0](mutations/b-unresolved-restored.log) |
| [c-cosmetic](mutations/c-cosmetic-broken.log) | Disable cosmetic refusal | 0 / **4** | [4 / 0](mutations/c-cosmetic-restored.log) |
| [d-unsubscribe](mutations/d-unsubscribe-broken.log) | Disable marketing refusal (d + R3 + sequence/prepared) | 0 / **7** | [7 / 0](mutations/d-unsubscribe-restored.log) |
| [e-consent-wrapper](mutations/e-consent-wrapper-broken.log) | Require recorded consent for email | 1 / **1** | [2 / 0](mutations/e-consent-wrapper-restored.log) |
| [e-explicit-off](mutations/e-explicit-off-broken.log) | Ignore explicit preference OFF | 0 / **1** | [1 / 0](mutations/e-explicit-off-restored.log) |
| [f-override](mutations/f-override-broken.log) | Remove transactional staff override | 0 / **1** | [1 / 0](mutations/f-override-restored.log) |
| [f-write-on](mutations/f-write-on-broken.log) | Skip preference write ON | 0 / **1** | [1 / 0](mutations/f-write-on-restored.log) |
| [sequence-probe](mutations/sequence-probe-broken.log) | Pass item title to suppression preflight | 0 / **2** | [2 / 0](mutations/sequence-probe-restored.log) |
| [sequence-send](mutations/sequence-send-broken.log) | Pass item title to prepared send | 0 / **2** | [2 / 0](mutations/sequence-send-restored.log) |
| [wrapper-validation](mutations/wrapper-validation-broken.log) | Drop envelope-validation hook | 0 / **4** | [4 / 0](mutations/wrapper-validation-restored.log) |
| [scheduled-detail](mutations/scheduled-detail-broken.log) | Discard scheduled hold detail | 0 / **1** | [1 / 0](mutations/scheduled-detail-restored.log) |
| [catalog-required](mutations/catalog-required-broken.log) | Accept fresh marketing without classification | 0 / **4** | [4 / 0](mutations/catalog-required-restored.log) |
| [catalog-default](mutations/catalog-default-broken.log) | Remove transactional eyecare default | 0 / **3** | [3 / 0](mutations/catalog-default-restored.log) |
| [catalog-propagation](mutations/catalog-propagation-broken.log) | Overwrite explicit cosmetic with eyecare | 0 / **1** | [1 / 0](mutations/catalog-propagation-restored.log) |
| [ui-disclosure](mutations/ui-disclosure-broken.log) | Remove confirmation disclosure | 0 / **1** | [1 / 0](mutations/ui-disclosure-restored.log) |
| [write-inventory](mutations/write-inventory-broken.log) | Remove enforced FHIR-write inventory entry | 0 / **1** | [1 / 0](mutations/write-inventory-restored.log) |
| [R1-normalized-baseline](mutations/R1-normalized-baseline-broken.log) | Discard normalized stored parse result | 0 / **1** | [1 / 0](mutations/R1-normalized-baseline-restored.log) |
| [R2-legacy-marketing](mutations/R2-legacy-marketing-broken.log) | Use strict fresh schema for stored marketing | 0 / **1** | [1 / 0](mutations/R2-legacy-marketing-restored.log) |
| [R4-real-meaning](mutations/R4-real-meaning-broken.log) | Disable content/hash comparison | 0 / **2** | [2 / 0](mutations/R4-real-meaning-restored.log) |
| [R5-publication-order](mutations/R5-publication-order-broken.log) | Run offer refusal before publication check | 0 / **1** | [1 / 0](mutations/R5-publication-order-restored.log) |
| [G18-schema-pin](mutations/G18-schema-pin-broken.log) | Change schema title max from 200 to 201 | 0 / **1** | [1 / 0](mutations/G18-schema-pin-restored.log) |
| [stored-invalid-class](mutations/stored-invalid-class-broken.log) | Replace every stored class with eyecare | 0 / **2** | [2 / 0](mutations/stored-invalid-class-restored.log) |
| [stored-practice-isolation](mutations/stored-practice-isolation-broken.log) | Disable stored-practice check | 0 / **1** | [1 / 0](mutations/stored-practice-isolation-restored.log) |
| [legacy-receipt-recovery](mutations/legacy-receipt-recovery-broken.log) | Apply new-send refusal to historical receipt recovery | 0 / **1** | [1 / 0](mutations/legacy-receipt-recovery-restored.log) |

## WHAT DID THIS FIX BREAK?

The intended behavior change is that previously flag-enabled marketing email can no longer send. This also invalidates old positive email-dispatch fixtures; their preference contract was retained at the suppression boundary, rather than weakening the new refusal.

The following are plausible regressions from touching the entire catalog rehydration path, with checks that would detect them. Executed checks reported no failures; that is author verification, not an independent evaluation verdict.

| Potential regression | Check and actual result |
| --- | --- |
| Legacy transactional snapshots falsely change meaning | R1 accepts identical upstream; removing normalized baseline gives 1 failure, restoring gives 1 pass |
| Legacy marketing disappears, or fresh marketing becomes permissive | R2 loads one active item, preserves retained/withdrawn split, rejects missing fresh class, accepts explicit eyecare; stored-schema removal gives 1 failure; fresh-schema mutation gives 4 failures |
| Invalid class/fields become silently repaired | Eight `stored migration rejects…` cases cover null/unknown class, extra item key, empty title, lifecycle, hash, absence flag, foreign practice; all pass in full MCP. Class-normalization mutation: 2 fail → 2 pass |
| Practice isolation is bypassed | Foreign stored-practice case refuses before network/writes; mutation: 1 fail → 1 pass |
| Withdrawal, retained versions, or absent-upstream carry-forward is lost | C0, G2/G20, G12, G24 all pass in full MCP; R2 additionally checks retained and withdrawn entries after legacy migration |
| Unread/corrupt baseline is overwritten during retry | G24 asserts boot failure/retry/refusal/no writes, then healthy recovery; eight malformed baseline cases assert no fetch and no accept/attempt writes; all pass |
| Genuine title/hash changes no longer refuse | R4 title and hash both refuse; disabling comparison: 2 fail → 2 pass |
| Stored raw evidence is rewritten merely by loading | R1/R2 compare the entire persisted row before refresh; both pass |
| Already-sent marketing email cannot reconcile after upgrade | Synthetic historical frozen receipt test returns original outcome with no new send or mutable reads; mutation: 1 fail → 1 pass |
| Prepared dispatch bypasses refusal or leaks title to preflight | d/R3 includes legacy prepared rejection; sequence subject tests cover default/custom preflight and actual prepared send; all restored runs pass |
| SMS/print/transactional override behavior changes | Original d tests SMS with/without consent plus print; e tests actual email suppression boundary; f tests actual provider override and persisted ON; full suites and mutations pass |

## Staff web-tier proof

Reused the task-owned disposable Docker project `odos-email-e1a-proof` with local synthetic identities and data. No primary account, policy, or credential changes. The seed step uses the pre-existing scoped synthetic seeder; browser requests use **Staff credentials only**, never an admin token.

Exact replay commands (from task root):

```sh
node .odos/email-e1a-proof-scripts/stack.mjs up
node .odos/email-e1a-proof-scripts/stack.mjs build
E1A_EVIDENCE="$PWD/docs/build-log/email-e1a-envelope/fixback-1" node --import tsx docs/build-log/email-e1a-envelope/proof/seed.ts
node .odos/email-e1a-proof-scripts/stack.mjs serve
E1A_EVIDENCE="$PWD/docs/build-log/email-e1a-envelope/fixback-1" node docs/build-log/email-e1a-envelope/proof/browser.mjs after
```

The harness serves built UI and MCP through the production-map Caddy web tier at `http://127.0.0.1:32190`, with `/communications` requests routed through that front door. Playwright/Chrome signs in as the disposable Staff user, checks `/auth/me` membership `admin:false`, matches the expected Staff membership and Practitioner, opens `/clinic` → Engage → education Email → confirmation. The test asserts the disclosure is visibly inside the viewport **above the enabled confirm button**, with **zero dispatch requests and no confirm click**. It records real communications endpoint responses, served JS hash and screenshot. A read-only stored membership/policy check verifies the actual Staff policy binding; its policy ID/version match the earlier proof. Authentication is established from the server identity and stored binding, not the visual role picker.

Evidence: [Staff result](staff-after.json), [screenshot](staff-after.png), [stored Staff binding](staff-policy.json), [served build identity](served-identity.json), [browser output](checks/staff-browser.log). The prior [base screenshot](../staff-before.png) remains historical before-evidence at `f2ef2c32`; this fixback recaptures the changed side. The web proof proves visibility before confirmation, not delivery to an external mailbox.

## Risks and follow-ups

- **E2 PRECONDITION:** move mandatory footer enforcement into a shared provider wrapper before adding SMTP; it must not depend on every adapter remembering to append it. Not implemented here, as instructed.
- **E1c:** implement and test the actual unsubscribe mechanism/rendering before replacing unconditional marketing-email refusal. No flag can currently enable it.
- `EducationContentItem` remains `z.input`; manually constructed marketing values are not compile-time forced to carry `offerClass`. Runtime publication parsing remains strict; type changes explicitly deferred.
- G18 pins ODOS schema bytes and requires explicit compatibility assessment on drift; it does not compare against a live VisionForge checkout. Existing captured fixtures/behavioral tests remain in place.
- 55 MCP skips, including 47 credential-gated live-stack tests; the entire live policy lane is unproven by this run. Actual Google delivery remains untested by this local synthetic proof.
- Existing Vite large-chunk warning and the evaluator's HHS-only legal-verification debt are unchanged.
- CodeRabbit threads are left unresolved for the evaluator. No bot trigger or own evaluation marker. Next step: independent Fable/Opus evaluation of the final PR head before merge.

⚠️ NOT EVALUATED — hand to Fable/Opus in Claude for the independent eval before merge. I wrote it; I can't be the judge.
