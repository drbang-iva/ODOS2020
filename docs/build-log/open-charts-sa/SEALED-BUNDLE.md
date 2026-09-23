# Open Charts A — sealed coder bundle

The practice time-zone setting is admin-only. Both Open Charts endpoints resolve it through the service identity, then project native Encounters into Today, last clinic day, Older and needs review. A finished Encounter without exact-instant sign-off is shown for seven local calendar days; the desk response contains only the allowed nonclinical fields. Older expansion adds rows but does not change counts. The existing sign-off and abandonment readers use shared helpers with no intended behavior change. The canonical extension registry contains the single R3 entry after age-of-majority.

Branch: `drbang-iva/open-charts-sa-projection`. Base: `0703ab17155dde01b5afa4582bdf7f96c4fb7794`. The PR URL and exact head SHA are in the handoff response. Coder status: **needs-review**. No merge or Iris policy sync occurred.

## Files and scope

- `data/canonical-extensions/registry.json`
- `mcp/src/authz/roles.ts`
- `mcp/src/clinic/clinic-routes.ts`
- `mcp/src/clinic/clinic-summary.ts`
- `mcp/src/clinic/encounter-sign-off.ts`
- `mcp/src/clinic/open-charts.ts`
- `mcp/src/clinic/patient-overview.ts`
- `mcp/src/clinic/practice-time-zone-config.ts`
- `mcp/src/clinical-graph/encounter-abandon-endpoint.ts`
- `mcp/src/clinical-graph/encounter-content.ts`
- `mcp/tests/encounterContent.test.ts`
- `mcp/tests/encounterSignOff.test.ts`
- `mcp/tests/openCharts.test.ts`
- `mcp/tests/openChartsLive.test.ts`
- `mcp/tests/practiceTimeZoneAuthzLive.test.ts`
- `mcp/tests/practiceTimeZoneConfig.test.ts`
- `ui/src/App.tsx`
- `ui/src/scenes/settings/PracticeTimeZoneSettings.tsx`
- `ui/src/scenes/settings/SettingsIndex.tsx`
- `ui/tests/practiceSettings.test.tsx`
- `ui/tests/practiceTimeZoneSettings.test.tsx`
- `docs/build-log/open-charts-sa/SEALED-BUNDLE.md`, `files.sha256`, `time-zone-before.png`, `time-zone-after.png`

G1 was withdrawn; `mcp/tests/schedulingRbacGrants.test.ts` remains unchanged. G2 changes only the expected Settings href list and count 18→19. `index.ts`, staff/provider policy lists, scripts, packages and the rest of the extension registry remain unchanged. The visit-type fallback is Appointment type text/display, then Encounter type text/display.

P1–P13 stand from the verified base. P11 live comma-joined searches returned both target Encounters and excluded the third for all 14 content types. P12 live Encounter date `lt` + `_sort=-date` ordered by `period.start`, and comma-separated statuses ORed. Initial seeder visibility finding stands: search 1/read 200 while ungranted provider, staff and admin humans search 0/read 404. R1's correction was applied: service read uses `deps.serviceFhir`, and any read error maps to Z6/502. R3's registry insertion is near the beginning of the array; PR #647's end append is a separate hunk.

## Checks

Every MCP suite used `ODOS_POSTGRES_URL=postgresql://medplum:medplum@127.0.0.1:15432/medplum` against the isolated `odos-sa-*` Postgres container. Both `.odos/operator.env` and `.odos/operator-identity.json` were moved aside for unit suites. The 59 skips in the full MCP suite include the two new live tests and the existing credentialed lane; `ODOS_ALLOW_UNGATED_MCP=1` acknowledged that scope. Live results below are separate.

| Check | Command | Real output |
|---|---|---|
| Base MCP | `ODOS_ALLOW_UNGATED_MCP=1 npm --prefix mcp test` | 6419 tests, 6362 pass, 0 fail, 57 skipped |
| Final-tree MCP | same | tests 6464, pass 6405, fail 0, skipped 59 ; exit 0 |
| Base UI | `npm --prefix ui test` | 1869 pass |
| Final-tree UI | same | tests 1871, pass 1871, fail 0, skipped 0 ; exit 0 |
| R2 unchanged summary/overview/abandon | `node --import tsx --test` on the three existing suites | 84 tests, 84 pass, 0 fail |
| Added O12/O18 tests | `node --import tsx --test --test-name-pattern='^(O12|O18)' mcp/tests/openCharts.test.ts` | tests 4, pass 4, fail 0, skipped 0 ; exit 0 |
| MCP typecheck | `tsc -p mcp/tsconfig.json --noEmit` | exit 0 |
| UI typecheck | `tsc -p ui/tsconfig.json --noEmit --skipLibCheck` | exit 0 |
| Scripts typecheck | `npm run typecheck:scripts` | exit 0 |
| Preflight | `npm run preflight` | 0 warnings, 0 hard blocks; exit 0 |
| Fresh live smoke | included in `npm --prefix mcp run test:live-integration` | tests 12, pass 12, fail 0, skipped 0 |
| Fresh live integration total | same command | tests 218, pass 218, fail 0, skipped 0 ; exit 0 |
| Fresh live authorization | `MEDPLUM_CONTRACT_BOOTSTRAP=1 npm --prefix mcp run test:live-authz` | tests 78, pass 78, fail 0, skipped 0 ; exit 0 |
| New O19/O21/O23/O26 live controls | `node --import tsx --test --test-concurrency=1` on the two new live suites | tests 2, pass 2, fail 0, skipped 0 ; exit 0 |

Preflight NOT SCOPE-VERIFIED: **244 base → 245 final**. Basic changed from 121 total / 8 scope-verified / 113 unverified to 123 / 9 / 114. The single added unverified read is the admin settings page's Basic search. The service singleton search is marked and scope-verified.

## Mutation proofs

For each row, the specified production source or new-test harness was broken, its matching test went red, the original bytes were restored and the same test went green. All mutations ran with the dedicated Postgres environment. Live policy changes were synced only to the disposable localhost project with the privileged synthetic seeder; final stored policy readback is admin 2 setting rules, staff 0, provider 0. No Iris sync.

| Guard | Red TAP | Green TAP |
|---|---|---|
| O1 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O2 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O3 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O4 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O5-noshow | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O5-cancelled | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O5-entered-in-error | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O6 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O7 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O8 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O9 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O10 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O11 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O12 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O13 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O14 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O15 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O16 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O17 | 2 tests / 0 pass / 2 fail; exit 1 | 2 tests / 2 pass / 0 fail; exit 0 |
| O18-keys | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O18-reads | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O19 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O20-Z1 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O20-Z2 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O20-Z3 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O20-Z4 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O20-Z5 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O20-Z6 | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O22 | 7 tests / 5 pass / 2 fail; exit 1 | 7 tests / 7 pass / 0 fail; exit 0 |
| O23-unit | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O24 | 2 tests / 1 pass / 1 fail; exit 1 | 2 tests / 2 pass / 0 fail; exit 0 |
| O25 | 48 tests / 46 pass / 2 fail; exit 1 | 48 tests / 48 pass / 0 fail; exit 0 |
| R4 | 2 tests / 0 pass / 2 fail; exit 1 | 2 tests / 2 pass / 0 fail; exit 0 |
| O19-live | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O26-live | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O21-readback | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O21-no-admin-write | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O21-staff-read | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |
| O23-no-admin-read | 1 tests / 0 pass / 1 fail; exit 1 | 1 tests / 1 pass / 0 fail; exit 0 |

O26 red showed **both** provider doctor and staff desk returning `timeZoneSource: environment` when the resolver was changed to caller scope. O21's new readback mutant replaced the refused caller's PUT with a seeder PUT; the assertion failed on a changed `meta.versionId`, then passed after restoration. Removing admin read gave admin GET 404 against expected 200; granting staff read made the 0-entry staff search fail. Removing admin write made the create assertion fail. O23's unit pin independently went red on deletion of admin read.

R3 registry entry deleted → `npm run preflight` exit 1, **1 hard block**. Preserved red report text:

```text
hard-block: odos-extension-url-shape (mcp/src/clinic/practice-time-zone-config.ts:6) - ODOS-authored StructureDefinition URL is missing from data/canonical-extensions/registry.json.
```

Entry restored → preflight exit 0, **0 hard blocks**. G2 link removed → 2 tests / 1 pass / 1 fail; restored → 2 pass / 0 fail. R4's two tests went 0/2 on counting expanded Older and returned 2/2 after restoration, including a failing Older-content read that does not alter main counts.

## Fresh synthetic live and browser proof

Compose project `odos-sa-opencharts-premise` used local port 18103 and byte-identical `MEDPLUM_BASE_URL=http://localhost:18103/`. Health polling at 2-second intervals passed **1/90** on restart after fresh volume creation. The live order was smoke+integration → canonical role repair (`GITHUB_ACTIONS=true` only there) → authorization 78/78 → single-role caller and browser proof. Human callers had actual Practitioner profiles and exactly `[provider]`, `[staff]`, `[admin]` roles, without project-admin membership.

O19: unauthenticated 401 both; provider-only 200 both; staff-only/admin-only 403 doctor and 200 desk. O21: admin create 201, read 200, update 200; staff/provider creates and updates returned 403 or 404 and the seeder readback kept the same version and `America/Denver` after **each** refusal; staff/provider setting searches returned 0 entries. O26: provider doctor and staff desk returned `environment` / `America/New_York` before the seeded setting and `setting` / `America/Denver` afterward. The O19/O26 seeded setting was cleaned up.

Nine synthetic visits were created with `now` real. Signed and cancelled visits were absent; no-show went to needs review; the finished unsigned visit showed `signature-missing`; the accepted synthetic OCT proposal/order without interpretation showed `needs-interpretation`. Provider doctor and staff desk returned this trimmed JSON (synthetic names only):

```json
{
  "provider": {
    "timeZoneSource": "environment",
    "timeZone": "America/New_York",
    "today": [
      {
        "patient": "SaR5Walkin",
        "kind": "nothing-charted",
        "reasons": [
          "nothing-charted"
        ]
      },
      {
        "patient": "SaR5Oct",
        "kind": "open",
        "reasons": [
          "needs-interpretation"
        ]
      },
      {
        "patient": "SaR5Today",
        "kind": "open",
        "reasons": [
          "none-found"
        ]
      },
      {
        "patient": "SaR5Unsigned",
        "kind": "signature-missing",
        "reasons": [
          "signature-missing"
        ]
      }
    ],
    "lastClinicDay": [
      {
        "patient": "SaR5Last",
        "kind": "nothing-charted",
        "reasons": [
          "nothing-charted"
        ]
      }
    ],
    "older": [
      {
        "patient": "SaR5Older",
        "kind": "nothing-charted",
        "reasons": [
          "nothing-charted"
        ]
      }
    ],
    "needsReview": [
      {
        "patient": "SaR5NoShow",
        "reason": "Appointment noshow, chart still open"
      }
    ],
    "counts": {
      "open": 5,
      "nothingCharted": 3,
      "signatureMissing": 2,
      "needsReview": 4
    }
  },
  "staff": {
    "timeZoneSource": "environment",
    "timeZone": "America/New_York",
    "today": [
      {
        "patient": "SaR5Walkin",
        "status": "chart open",
        "priorDay": false
      },
      {
        "patient": "SaR5Oct",
        "status": "chart open",
        "priorDay": false
      },
      {
        "patient": "SaR5Today",
        "status": "chart open",
        "priorDay": false
      }
    ],
    "lastClinicDay": [
      {
        "patient": "SaR5Last",
        "status": "chart open",
        "priorDay": true
      }
    ],
    "older": {
      "count": 2
    }
  }
}
```

The desk `older.count` is 2 because one earlier synthetic authorization visit is also Older; one Older row belongs to this nine-case fixture. Counts reflect the complete returned set, while the listed rows are filtered to these nine cases. The setting was absent during this readback, so source was `environment`.

The admin page on the actual app route showed “Not set — the server default is used until you save one.” Playwright then selected `America/Denver`, saved, showed “Practice time zone saved.”, and a credentialed Basic search returned one entry. Both inspected 1440×900 screenshots are in this directory. The server setting remained only in the disposable stack. The own stack was stopped after proof; final `docker ps --format '{{.Names}} {{.Ports}}'` listed only `vf-prac1b-walk-db 127.0.0.1:55481->5432/tcp`, which was untouched.

## Existing reds and harness corrections

R2 existing overview regressions: the new local `signedEncounterIds` declaration shadowed its imported helper, producing 23 overview `ReferenceError`s and one route 500. Alias import to `findSignedEncounterIds` fixed the product code; no existing test changed; unchanged summary/overview/abandon returned 84/84 green.

Three existing `searchParamContract.test.ts` assertions failed because the first bounded-reader draft forwarded unresolved search parameters. Product code now names its Encounter/Provenance searches explicitly and passes the first page to the bounded collector. No test or search registry changed, and the 42-test audit/projection focus and final full MCP suite returned green.

Harness corrections did not change product code or accepted outputs: the first authorization invocation omitted CI's `MEDPLUM_CONTRACT_BOOTSTRAP=1` and failed two synthetic cleanup assertions (76/78); the corrected fresh lane returned 78/78. A private policy-sync script initially used an unprivileged bootstrap caller and got 403; using the privileged seeder allowed actual policy red/green checks. The first staff-read mutation matched both provider and staff source anchors and stopped before editing; a staff-only anchor then ran successfully. The first private readback script import could not resolve Express from `.odos`; its path was corrected and the same requests then completed. No production request failure was waived. The initial 403-only O21 assertion was the coder's unsupported exact-status assumption; R5 authorized 403 or 404 plus the seeder version/zone readback. The current test passed live.

## Deployment and follow-ups

The Iris policy sync remains a deployment dependency for the settings page. Before it, no admin can create the setting; the service read finds none, and both endpoints use valid `ODOS_TIMEZONE=America/New_York` with Z4 / HTTP 200 / `timeZoneSource: environment`. After sync, admin can save one and Z1 selects it. Any service read error is Z6 / HTTP 502 without fallback. No Iris policy changes were made here.

Still outside this slice: doctor card B, desk badge/panel C, Close as incomplete D, waiting on results E, the Q4 admin-home view, migrating `/clinic/summary` or other env readers to the resolver, sign-gate/claim-hold/abandon behavioral changes, and #661's separate evidence follow-up. The PR still needs CodeRabbit/PR-Agent and an independent Claude Opus evaluation at the final head. Codex authored this code and cannot evaluate it.

⚠️ NOT EVALUATED — hand to Claude Opus for independent exact-head evaluation before merge.

needs-review
