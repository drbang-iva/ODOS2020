# SMS recipient integrity author evidence

Base: `21f7fc43b95f3927b374a5a4b711c01b8339d69a`. Code commit tested: `f4f882f87a57ba7445338d334f4ca74ac8081986`.

NOT EVALUATED — awaiting independent evaluation.

## Scope and search disposition

Only the four requested production files changed. The existing display first-match rule and typed recipient override remain. Existing telecom edits replace value in place, including an empty email value; absent empty email does not create an entry. New nonempty entries use home. The registration endpoint, editor controls, preference/hold rules, and voice call site are unchanged.

`rg -n "telecom" ui/src mcp/src` plus searches for first/last indexing and home-use readers found no consumer requiring append-last or forced-home behavior. Home-telecom reads were confined to the display/save helper. No existing test expectation was rewritten. The education override still chooses `overridden ?? recorded`.

## Inventory

Source declarations and runner totals are different in the API file: its 68 baseline declarations execute 87 tests, including generated cases/subtests.

| File | Declarations before → after | Runner before → after | Final failures / skipped |
|---|---:|---:|---:|
| `mcp/tests/commsSuppression.test.ts` | 23 → 28 | 23 → 28 | 0 / 0 |
| `mcp/tests/commsApi.test.ts` | 68 → 72 | 87 → 91 | 0 / 0 |
| `mcp/tests/commsConfig.test.ts` | 25 → 27 | 25 → 27 | 0 / 0 |
| `ui/tests/patientRegistration.test.tsx` | 9 → 15 | 9 → 15 | 0 / 0 |
| `ui/tests/demographicsConcurrency.test.tsx` | 3 → 3 | 3 → 3 | 0 / 0 |
| `ui/tests/patientRegistrationEndpoint.test.tsx` | 4 → 4 | 4 → 4 | 0 / 0 |
| `ui/tests/registrationCommunicationPreferences.test.tsx` | 8 → 8 | 8 → 8 | 0 / 0 |

Seven-file runner totals: 159 before; 176 after.

Commands: MCP files use `npm --prefix mcp test -- tests/<file>` individually. UI files use `cd ui && node --import tsx --test --test-concurrency=1 tests/<file>` individually.

### Runner output by file

`mcp/tests/commsSuppression.test.ts` — before:
```text
# tests 23
# suites 0
# pass 23
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 596.399416
```
After:
```text
# tests 28
# suites 0
# pass 28
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 179.208208
```

`mcp/tests/commsApi.test.ts` — before:
```text
# tests 87
# suites 0
# pass 87
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 797.564625
```
After:
```text
# tests 91
# suites 0
# pass 91
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 533.275167
```

`mcp/tests/commsConfig.test.ts` — before:
```text
# tests 25
# suites 0
# pass 25
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 464.08475
```
After:
```text
# tests 27
# suites 0
# pass 27
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 370.358083
```

`ui/tests/patientRegistration.test.tsx` — before:
```text
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 462.962084
```
After:
```text
# tests 15
# suites 0
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 394.77225
```

`ui/tests/demographicsConcurrency.test.tsx` — before:
```text
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 983.564041
```
After:
```text
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 881.671291
```

`ui/tests/patientRegistrationEndpoint.test.tsx` — before:
```text
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 340.393958
```
After:
```text
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 346.555167
```

`ui/tests/registrationCommunicationPreferences.test.tsx` — before:
```text
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 440.345583
```
After:
```text
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 451.907958
```

## Mutation guards

Every mutation was confirmed in the written source, executed, then restored byte-for-byte with SHA-256 checks before its green run. These are author checks.

| Guard | Deliberate break | RED | Restored GREEN |
|---|---|---|---|
| G1 | Unchanged mobile save; restore append-last/force-home | `G1-ui`: 1 test, 0 pass, 1 fail | `G1-ui`: 1 test, 1 pass, 0 fail |
| G2 | Changed mobile remains in place; relabel it home | `G2-ui`: 1 test, 0 pass, 1 fail | `G2-ui`: 1 test, 1 pass, 0 fail |
| G3 | Edit the displayed home; force index zero | `G3-ui`: 1 test, 0 pass, 1 fail | `G3-ui`: 1 test, 1 pass, 0 fail |
| G4 | Append a new home phone; append mobile instead | `G4-ui`: 1 test, 0 pass, 1 fail; `G4-exact`: 1 test, 0 pass, 1 fail | `G4-ui`: 1 test, 1 pass, 0 fail; `G4-exact`: 1 test, 1 pass, 0 fail |
| G5 | Home email stays in place; restore old helper | `G5-ui`: 1 test, 0 pass, 1 fail | `G5-ui`: 1 test, 1 pass, 0 fail |
| G6 | Current home after expiry; loosen end boundary / restore education helper | `G6-resolver`: 1 test, 0 pass, 1 fail; `G6-education`: 1 test, 0 pass, 1 fail | `G6-resolver`: 1 test, 1 pass, 0 fail; `G6-education`: 1 test, 1 pass, 0 fail |
| G7 | Explicit SMS priority; prefer mobile | `G7-resolver`: 1 test, 0 pass, 1 fail; `G7-education`: 1 test, 0 pass, 1 fail | `G7-resolver`: 1 test, 1 pass, 0 fail; `G7-education`: 1 test, 1 pass, 0 fail |
| G8 | RelatedPerson current home; skip its period | `G8-education`: 1 test, 0 pass, 1 fail | `G8-education`: 1 test, 1 pass, 0 fail |
| G9 | Configured conversation parity; restore duplicated filter with mobile priority | `G9-config`: 1 test, 0 pass, 1 fail | `G9-config`: 1 test, 1 pass, 0 fail |
| G10 | Both wrapper errors; change each message | `G10-suppression`: 1 test, 0 pass, 1 fail; `G10-config`: 1 test, 0 pass, 1 fail | `G10-suppression`: 1 test, 1 pass, 0 fail; `G10-config`: 1 test, 1 pass, 0 fail |
| G11 | Voice wrapper selection; substitute old education selection | `G11-voice`: 1 test, 0 pass, 1 fail | `G11-voice`: 1 test, 1 pass, 0 fail |
| G12 | Duplicate homes first-match in place; restore old helper | `G12-ui`: 1 test, 0 pass, 1 fail | `G12-ui`: 1 test, 1 pass, 0 fail |

G3 retains the supplied home-first case and adds home-at-index-1 so index-zero replacement is observable. G11 retains mobile/work and adds expired-mobile and explicit-SMS cases: the supplied mobile/work case alone cannot distinguish the old education rule. G4 uses the exact value `555` directly against the transpiled production helper; the persisted editor guard uses `5550100` because existing phone validation is unchanged. G8 uses the existing route with a RelatedPerson reference and an email override; on the SMS channel this leaves phone selection recorded, without altering override parsing.

Additional guards cover resolver trimming/boundaries and explicit phone override with no active recorded phone. Both were mutated red and restored green.

### Real targeted runner output

`G6-resolver`
```text
RED (exit 1)
not ok 1 - G6: the shared SMS resolver skips an expired mobile for a current home
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G6: the shared SMS resolver skips an expired mobile for a current home
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G7-resolver`
```text
RED (exit 1)
not ok 1 - G7: the shared SMS resolver prefers an explicit SMS entry over mobile
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G7: the shared SMS resolver prefers an explicit SMS entry over mobile
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`resolver-boundaries`
```text
RED (exit 1)
not ok 1 - SMS resolution retains active-period boundaries, trimming, and first-candidate fallback
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - SMS resolution retains active-period boundaries, trimming, and first-candidate fallback
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G10-suppression`
```text
RED (exit 1)
not ok 1 - G10: the suppression wrapper retains its no-active-phone error
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G10: the suppression wrapper retains its no-active-phone error
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G11-voice`
```text
RED (exit 1)
not ok 1 - G11: voice retains mobile, active-period, and explicit-SMS selection through its wrapper
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G11: voice retains mobile, active-period, and explicit-SMS selection through its wrapper
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G1-ui`
```text
RED (exit 1)
not ok 1 - G1: an unchanged demographics save keeps the mobile recipient and byte-identical telecom
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G1: an unchanged demographics save keeps the mobile recipient and byte-identical telecom
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G2-ui`
```text
RED (exit 1)
not ok 1 - G2: a changed mobile value stays at its original position with metadata intact
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G2: a changed mobile value stays at its original position with metadata intact
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G3-ui`
```text
RED (exit 1)
not ok 1 - G3: the displayed home entry is updated in place even when it is not the first phone
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G3: the displayed home entry is updated in place even when it is not the first phone
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G4-ui`
```text
RED (exit 1)
not ok 1 - G4: a missing phone appends exactly one home entry
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G4: a missing phone appends exactly one home entry
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G5-ui`
```text
RED (exit 1)
not ok 1 - G5: the displayed home email changes or clears in place without moving work email
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G5: the displayed home email changes or clears in place without moving work email
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G12-ui`
```text
RED (exit 1)
not ok 1 - G12: duplicate home entries keep the first displayed entry in place on unchanged and changed saves
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G12: duplicate home entries keep the first displayed entry in place on unchanged and changed saves
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G4-exact`
```text
RED (exit 1)
not ok 1 - G4: the exact pure-helper fixture appends phone home 555
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G4: the exact pure-helper fixture appends phone home 555
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G9-config`
```text
RED (exit 1)
not ok 1 - G9: configured conversation lookup selects the same mobile, current home, and explicit SMS numbers
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G9: configured conversation lookup selects the same mobile, current home, and explicit SMS numbers
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G10-config`
```text
RED (exit 1)
not ok 1 - G10: the conversation wrapper retains its no-active-phone error and reference fallback
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G10: the conversation wrapper retains its no-active-phone error and reference fallback
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G6-education`
```text
RED (exit 1)
not ok 1 - G6: education records the current home instead of an expired mobile using the injected clock
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G6: education records the current home instead of an expired mobile using the injected clock
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G7-education`
```text
RED (exit 1)
not ok 1 - G7: education records the explicit SMS entry instead of mobile
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G7: education records the explicit SMS entry instead of mobile
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`G8-education`
```text
RED (exit 1)
not ok 1 - G8: education records the RelatedPerson current home instead of an expired mobile
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - G8: education records the RelatedPerson current home instead of an expired mobile
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`override-preservation`
```text
RED (exit 1)
not ok 1 - education keeps an explicit phone override even when no active phone is recorded
# tests 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
GREEN (exit 0)
ok 1 - education keeps an explicit phone override even when no active phone is recorded
# tests 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Broader checks

`npm --prefix ui test`:
```text
# tests 1427
# suites 0
# pass 1427
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 215002.852584
```

Eleven related MCP files (persistence, conversation adapter, education actor/enrollment, and sequence execution/storage/timing) via the MCP runner:
```text
# tests 183
# suites 0
# pass 183
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4517.492792
```

`cd mcp && node_modules/.bin/tsc --noEmit --pretty false`: exit 0, no diagnostics.

`npm --prefix ui run build`: exit 0; 317 modules transformed. Vite reports its large-chunk warning.

## Browser evidence

The actual PatientDemographicsEditor rendered in a synthetic component fixture, using the same data and viewport against separate base/current Vite servers. Each save made exactly one conditional PUT and reopened the returned Patient. FHIR responses were intercepted; ancillary communications requests returned synthetic refusals. This is component/save-path proof, not a full authenticated app-route, AccessPolicy, Docker-stack, or message-delivery verdict.

G1: base changes `[mobile, work]` to `[work, home]`; current retains `[mobile, work]`. G12: base reopens the second home after an unchanged save; current reopens the first and retains both entries in order. Four browser scenarios passed.

| Base after unchanged save (G12) | Current after unchanged save (G12) |
|---|---|
| ![Base selects second home](item0-sms-recipient-integrity/before.png) | ![Current retains first home](item0-sms-recipient-integrity/after.png) |

## Limitations and follow-up

Two intermediate API suite runs had `fetch failed` in different pre-existing tests; their failed output is retained locally. Immediate repeats passed. Three diagnostic runs at the base passed 87/87, and a diagnostic current run passed 91/91; the socket cause was not reproduced, so its origin remains unproven. The final unmodified seven-file run passed, with zero skips.

No terminology bindings, FHIR artifact URLs, or regulatory citations were introduced. No new architecture decision or cross-repository change was made. Independent evaluation and external review status remain separate delivery gates.
