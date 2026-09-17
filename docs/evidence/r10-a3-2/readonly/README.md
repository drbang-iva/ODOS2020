# Supplemental served-route proof

Command: `node --import tsx scripts/r10-served-route/readonly-proof.mjs seed`, then `node --import tsx scripts/r10-served-route/readonly-proof.mjs run` after final app readiness. Final run exit 0, five completed proof steps, zero browser page errors, 13 screenshots.

Served head: aefb6dbfc4cc1b5a0df70e75ba1dd25d4b82e2e2. Build manifest reports dirty=true; script locator/screenshot refinements followed build and are harness-only. UI asset `/assets/index-DkhlaMax.js`, SHA256 `a2a981902d7280205b2e6441649253622f24a267d9b0ecae561a004516448944`. MCP build hash and exact resource ids/versions/content are in result.json.

- W147: actual provider login, checked disabled signed Nuclear Sclerosis chip, editable Remarks, successful save and reload. Full signed Observation before/after equality includes id, version, status and every field.
- W145: real encounter-less legacy snapshot excluded from scoped findings; patient-wide history reports unscopedCount and the app displays “Some older records could not be placed on a visit”.
- Section 10.4(f): separate closed and true pre-rebuild encounters show exact required labels in both doors, disabled actual diagnosis finding mutation control, disabled ocular Remarks, and no Ocular save control. Stored Observation resources remain identical.
- Staff: independent browser context logs in through the actual app and shows the closed diagnosis read-only label.

Complementary screenshots preserve the locked chip, Remarks value, read-only labels, and disabled diagnosis controls. Main proof encounters were not modified. Only separate same-patient synthetic encounters and one encounter-less synthetic legacy record were seeded; no policy or production source changes.

The retained attempt-staff-selector result is an earlier incomplete harness run: provider proof succeeded, then the staff text locator found two matching labels. The final run narrows that locator and completes. These are author-side checks, not an independent evaluation. Shared stack remains running for the parent’s other proof work.

Final serialized rerun on the Clear/Deferred build completed exit 0. Earlier artifacts are preserved in prior-ef3d276 and attempts directories. Authentication-refused attempts are historical and are not the current result.
Deferred is asserted enabled for the editable panel beside the signed witness, and disabled for closed/pre-rebuild panels. This does not imply the signed fact itself is editable.

Latest same-app-head rerun: aefb6dbfc4cc1b5a0df70e75ba1dd25d4b82e2e2, exit 0; complete result and screenshots regenerated after supplemental auth-slot release. No app restart, build or source modification during these runs.

Final combined-head sequence: ran once after main proof released auth slot, exit 0. Current screenshots inspected for visible saved Remarks, locked encounter label, and superseded Undo message. Previous attempt files remain archived.
