# Browser evidence

All captures use synthetic identities and local HTTP responses with actual components and clients. They are visual/transport proof, not a live AccessPolicy or real-send verdict. The matrix/default payloads in the multi-screen harness come from the server resolver and constants. Every configured proxy is redirected to the disposable synthetic transport.

The editor before/after uses the same synthetic identity, component entry, and 1440 × 1600 viewport on separate base and branch servers. The after image additionally illustrates the newly available explicit/legacy/evidence states. The evidence page is captured through the actual RouteSwitch and AppShell at its direct route, at 1280 × 1000. All images were inspected after capture.

| Required state | Screenshot |
|---|---|
| Before, clean base | [Edit demographics](demographics-before.png) |
| Default, explicit, legacy; amber Marketing Text gap; paper evidence badge | [Mixed grid](screenshots/mixed.png) |
| STOP locks Text cells | [STOP grid](screenshots/stop.png) |
| Paper form confirmation and date | [Paper form](screenshots/paper.png) |
| 403 leaves visible read-only grid | [Permission refusal](screenshots/denied.png) |
| GET 5xx, no editable grid | [Malformed record](screenshots/malformed.png) |
| D1 outside-write notice | [Version notice](screenshots/outside.png) |
| New Patient server defaults | [New Patient](screenshots/new.png) |
| Education Text withheld, Email override, Marketing Email ON without legacy record | [Engage](screenshots/engage.png) |
| Marketing Email OFF | [Engage withheld](screenshots/engage-marketing-off.png) |
| Per-number STOP chip, expanded demographic detail | [Chart chip](screenshots/chip.png) |
| Evidence counts, truncated banner and filters | [Consent evidence](screenshots/evidence-page.png) |
| Draft survives preferences write and demographics save | [Saved draft](screenshots/sync.png) |

The chart capture deliberately supplies no unrelated overview payload; its lower fixture notice is not an application failure claim. The production chip reads the opt-out summary independently.

Reproduce the branch screens from the repository root:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs docs/build-log/comms-matrix-2/capture-screens.ts
```

Exit 0: eleven screens and the editor save sequence. [Request evidence](screenshots/browser-proof.json) records the demographics PUT using `W/"opaque-after"`; the harness asserts one save and the edited draft name. This is a synthetic conditional-write check, separate from the real server source proof.

For the evidence page, set `CONSENT_EVIDENCE_CAPTURE` to the desired output PNG, then run from `ui`:

```sh
node --import tsx --test --test-name-pattern='consent evidence direct navigation' tests/consentEvidence.test.tsx
```

Exit 0, one test: document navigation, API/child-path proxy preservation, drawer route, downloaded CSV contents and partial-export notice. The full UI suite also runs this test.

Capture preparation encountered a missing stylesheet working directory, a collapsed chart panel, and an unlabeled pre-existing name input. Those were harness corrections. Visual inspection additionally found unreadable native controls; the U2/U7 styling follow-ups use existing input styles. One concurrent capture/focused-test run timed out on the new route test (22/23, exit 1); isolated final capture and the full suite passed. No existing assertion changed to address it.
