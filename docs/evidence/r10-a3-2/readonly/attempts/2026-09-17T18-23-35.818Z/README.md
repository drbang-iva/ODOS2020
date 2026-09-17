# Supplemental served-route proof

Command: `node --import tsx scripts/r10-served-route/readonly-proof.mjs seed`, then `node --import tsx scripts/r10-served-route/readonly-proof.mjs run` after final app readiness. Final run exit 0, five completed proof steps, zero browser page errors, 13 screenshots.

Served head: 97fe47994c15944f367bc13117ed17bf87929c29. Build manifest reports dirty=true; script locator/screenshot refinements followed build and are harness-only. UI asset `/assets/index-B6n-Vchx.js`, SHA256 `5a1158a74120e25886bc71dbea0aff308aed9e925535285bb1d8e309b143ecf5`. MCP build hash and exact resource ids/versions/content are in result.json.

- W147: actual provider login, checked disabled signed Nuclear Sclerosis chip, editable Remarks, successful save and reload. Full signed Observation before/after equality includes id, version, status and every field.
- W145: real encounter-less legacy snapshot excluded from scoped findings; patient-wide history reports unscopedCount and the app displays “Some older records could not be placed on a visit”.
- Section 10.4(f): separate closed and true pre-rebuild encounters show exact required labels in both doors, disabled actual diagnosis finding mutation control, disabled ocular Remarks, and no Ocular save control. Stored Observation resources remain identical.
- Staff: independent browser context logs in through the actual app and shows the closed diagnosis read-only label.

Complementary screenshots preserve the locked chip, Remarks value, read-only labels, and disabled diagnosis controls. Main proof encounters were not modified. Only separate same-patient synthetic encounters and one encounter-less synthetic legacy record were seeded; no policy or production source changes.

The retained attempt-staff-selector result is an earlier incomplete harness run: provider proof succeeded, then the staff text locator found two matching labels. The final run narrows that locator and completes. These are author-side checks, not an independent evaluation. Shared stack remains running for the parent’s other proof work.

Final serialized rerun on the Clear/Deferred build completed exit 0. Earlier artifacts are preserved in prior-ef3d276 and attempts directories. Authentication-refused attempts are historical and are not the current result.
Deferred is asserted enabled for the editable panel beside the signed witness, and disabled for closed/pre-rebuild panels. This does not imply the signed fact itself is editable.
