# V25 / V36 / W135 / W143 carry integration

Author-side integration follow-up, NOT EVALUATED. No commits.

Changes: confirmed carry progress dispatches the same encounter-findings-changed event consumed by overview/completeness, Assessment and Ocular Health. A lost response with no confirmation dispatches no event. Existing frozen retry request is unchanged. On remount a provider now verifies a checked carry via a normal new command; the server returns alreadyPresent for completed/manual existing diagnoses or carry-incomplete for interrupted plans. That response exposes reload/replan. Checked read-only callers still select without a POST. After completion in this component session, repeated selection sends no extra POST. Initial checked-provider action is labeled Check carry and select.

Existing test migration: `checked prior diagnoses select without POST while unchecked pulls are idempotent and row-specific` becomes `read-only checked prior diagnoses select without POST while provider pulls are idempotent and row-specific`. Initial fixture omits canWriteDiagnosis; following the existing no-POST assertions it enables that capability before the original unchecked pull actions. Every existing assertion remains unchanged. Mapping V25/V36/W143: a checked row is identity proof, not carry-completion proof.

Added evidence:
- Complete carry emits one event naming destination encounter.
- Partial carry with applied steps emits one event even while a finding response remains unconfirmed.
- Fully unconfirmed network failure emits none.
- Remounted checked provider row receives carry-incomplete, offers explicit recovery, reloads before new replan UUID.
- Completed checked carry returns existing Condition and never replans; subsequent clicks select without POST.

Commands from ui/:
- Before event change: `node --import tsx --test --test-name-pattern='V25 W135 carry refresh' tests/diagnosisCarryForward.test.tsx`: 1 pass / 2 fail.
- Before checked-provider change: `node --import tsx --test --test-name-pattern='remounted checked' tests/diagnosisCarryForward.test.tsx`: 0 pass / 2 fail.
- After both: `node --import tsx --test tests/diagnosisCarryForward.test.tsx`: 25 pass / 0 fail.
- `npx tsc --noEmit --skipLibCheck`: exit 0, empty output.
