# Rev 2.5 live assertion migration

Author evidence only — NOT EVALUATED. [Exact ledger](rev25-live-assertion-migrations.json) compares the preserved private `live-before-rev25.ts` snapshot to `mcp/tests/r10OcularHealthDoorAuthzLive.test.ts`; both file hashes and every exact assertion/line are included. This supplements the base-commit assertion audit because the live test is new in this slice.

TypeScript AST inventory: **101 before / 111 after direct `assert.*` calls**; 97 unchanged calls have old/new anchors, 4 removed/replaced calls map to 14 added/replacement calls. The separately recorded new `assertResponse` helper invocation validates creation of the canonical pre-rebuild control. No existing `assertResponse` invocation was removed or changed. All changes map to **V35/W115, rev 2.5 §7 and §3.13**.

| Before line | After line | Authorized migration |
|---|---|---|
| — | 191–193 | Require successful canonical control setup, owner presence and signed version advancement before adding a pre-rebuild sibling |
| 198 | 206–210 | Replace optional dedicated credential-pair check with session lookup success, actual user identity, exclusion of super admin and active target-project equality; dispatch now uses the same project admin credentials |
| 206 | 217–218 | Replace policy-or-admin alternative with project admin membership and authenticated actor equality |
| 218 | 231 | Replace both transaction entries 2xx with Observation PATCH entry exactly 200; retain two-entry count |
| 220 | 228–233 | Remove mandatory persisted Provenance target assertion; retain actual entry statuses and successful/failed readback as diagnostic evidence without requiring success or a particular failure status |
| — | 242–244 | Require pre-rebuild dispatch refusal, expected refusal reason, zero attempted FHIR writes, unchanged Observation and unchanged Provenance state |

The status/version and byte-identical identifier/component/extension assertions are unchanged (before 219 → after 232). The active-project assertion is unchanged (201 → 212). Mismatching-practitioner refusal and attempted/persisted zero-write assertions are unchanged (226 → 248). They are now reached in the real live run because the obsolete Provenance-success assertion no longer stops execution. Exact positions and source text in the JSON ledger take precedence over this grouped summary.
