# W144 actual-route superseded Undo proof

Command: `node --import tsx scripts/r10-served-route/undo-superseded-proof.mjs`. Final exit 0, three screenshots, zero page errors. Served app aefb6dbfc4cc1b5a0df70e75ba1dd25d4b82e2e2; build and served bundle identity are in result.json.

A separate synthetic encounter and canonical preliminary fact are seeded through the verified operator. Two independent browser contexts log in as the actual provider. Context B uses authenticated server APIs to clear the encounter. Context A opens the real app route and shows its Undo slot. Context B restores that exact action, then clears again with a new action ID. Context A clicks its still-displayed actual Undo button.

The captured UI request sends the original displayed voidActionId, not the new slot ID; the server returns 409 with code undo-superseded. The actual route displays “This undo no longer applies”; the strip has no buttons and there is no Retry. Full Observation, Encounter, undo-ledger Basic and related Provenance resources are identical before/after the refusal, including their versions. Exact action IDs, request, response, before/after resources and screenshots are recorded in result.json.

The initial clear is setup through the real endpoint, not a claim that the Clear UI was tested. An earlier harness attempt found the canonical-only Ocular Clear control absent; the parent/ocular author is handling that separate source defect. Its failed attempt result is retained. This supplemental proof exercises actual stale Undo UI without intercepting requests or mocking responses.

The 1600px screenshot preserves actual header message compression; the wide screenshot provides complementary readable framing. No production source or policies changed. Shared app and Docker stack remain running. Author-side verification only; NOT EVALUATED.

Final serialized rerun on the Clear/Deferred build completed exit 0. Earlier artifacts are preserved in prior-ef3d276 and attempts directories. Authentication-refused attempts are historical and are not the current result.

Latest same-app-head rerun: aefb6dbfc4cc1b5a0df70e75ba1dd25d4b82e2e2, exit 0; complete result and screenshots regenerated after supplemental auth-slot release. No app restart, build or source modification during these runs.

Final combined-head sequence: ran once after main proof released auth slot, exit 0. Current screenshots inspected for visible saved Remarks, locked encounter label, and superseded Undo message. Previous attempt files remain archived.
