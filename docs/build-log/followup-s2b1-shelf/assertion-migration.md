# S2b-1 assertion migration — REV 3

All test names below refer to `ui/tests/examOverviewBoard.test.tsx` unless another file is named. This records author changes and their guards; independent acceptance remains NOT EVALUATED. Mutation outputs are in [guards.md](guards.md).

| Changed assertion or helper | What it guarded before | Where that behavior is asserted now |
| --- | --- | --- |
| `by-exception board...`: finding count 8 → 9 and ordered pattern list gains an eye-pair | Exact finding inventory and presentation order; previously omitted carried IOP | Same count and exact ordered list now include carried IOP, as required by BD-8. |
| Same test: IOP row count 0 → 1 | Previous exclusion of carried data | Explicit carried IOP presence; detailed confirmed/unconfirmed rendering and completeness count in `examShelf.test.tsx` G7. |
| Same test: Assessment row count 0 → 1 | Previous empty-row suppression | Same row-count assertion now enforces always-drawn Assessment under §3.1; History assertion remains. |
| Same test: disclosure count 1 → 0, adds shelf count 1 | Access to otherwise undrawn editors | Always-visible shelf replaces disclosure; G1/G2 inventory partition and no-disclosure assertions in `examShelf.test.tsx`. |
| `five row patterns...`: `EOMfull` exact whole-row text and no OD/OS scoped to the value node | Collapsed normal EOM value without redundant per-eye values, plus exact label | Value remains exactly `full`, with no OD/OS in the value; separate eye/date metadata assertion added. Separate exact `EOM` name-node assertion retained. |
| Same test: normal CVF exact whole-row text changed to exact `full` value plus eye/date metadata | Normal CVF label/value and absence of an unnecessary diagram | Exact value and zero diagrams remain; new metadata assertion. Separate exact `Confrontation fields` name-node assertion retained. |
| `manual keratometry...`: exact displayed string includes OD/OS dates | Allowlisted measurement formatting, OD-before-OS, no machine identifiers | Same exact measurement string remains the prefix; appended metadata is asserted exactly; identifier-exclusion assertion remains. |
| `single-slot Refraction...`: one disclosure → none; editor list removes already-drawn Refraction | Remaining Refraction editors stay reachable, read-only history stays out of blank rows | Shelf Refraction list equals history + eye growth; exactly one Refraction control asserted; read-only blank exclusion unchanged. |
| `structure view...`: section order includes Assessment; row count 2 → 3 | Exact drawn row order and performed-finding inventory | Same ordered row list includes required Assessment; exact finding count adds carried CVF, whose presence is separately asserted. |
| `charted findings...`: one disclosure → zero plus one shelf | Sibling editor affordances stay available alongside charted findings | Same sibling-editor and row assertions retained; shelf replaces the disclosure surface. |
| `distributed board rows...`: inventory query uses drawn editor IDs plus shelf IDs; expected list adds dilation/imaging | Complete editor exposure without losing full-page fallbacks | Exact sorted inventory now includes mapped-data lines and imaging; existing editor opening/presentation assertions remain. G1 separately checks full inventory partition and duplicates. |
| `editorControl` helper: dilation-only fallback → drawn-line finding fallback | Locate native editor affordance for existing cancel/save/focus tests | Same callers and assertions remain; helper handles any mapped finding line. |
| `entrySheets.test.tsx`: `openChartAnotherGroup` → `openFromShelf`; all callers retained; adjacent second click removed | Pristine swap, dirty-state Keep/Discard, focus-only and presentation-only swaps through a real board affordance | Helper requires shelf entry visibility and clicks it once; each caller retains dialog, value, dirty-state, and focus assertions. |
| `entrySheets.test.tsx`: launch geometry test's positive disclosure count/summary expansion replaced | Affordances become reachable and retain 44px geometry and presentation hints | Shelf visibility, zero old disclosures, zero shelf `details`; all existing launch-row dimensions, pill labels, and colors remain asserted. |
| `entrySheets.test.tsx`: active VA hidden → visible; closed-disclosure assertion removed | Modal should not create a second competing launcher | Exactly one active in-place VA control; no duplicate VA on shelf; zero disclosures. Always-visible drawn line is the intended changed behavior. |
| `entrySheets.test.tsx`: hover target uses shelf entry; then opens through helper | Visible hover border resolves to document accent | Same hover-color assertion against the visible shelf IOP entry, followed by actual IOP dialog assertion. |

## REV 3 fixture inputs

| File | Input migration and retained guards |
| --- | --- |
| `ui/tests/visitTypeResolverBoard.test.tsx` | **Input migration, not a weakening:** replace `editorEntries={[]}` with `chartEditorInventory()`. No assertion changes: History, Pretest, Refraction, Ocular Health, and Assessment each render exactly once; Ocular Health text is present; fresh board has zero finding rows. |
| `ui/tests/fixtures/exam-chart-bar-responsive.tsx` | **Input migration, not a weakening:** replace the empty inventory with `chartEditorInventory()`. This gives the responsive browser test the same editor inventory as the app. |
| `ui/tests/examChartBarResponsive.test.tsx` | No assertion or source change needed. Every existing populated-column containment and responsive-header assertion runs unchanged against the migrated fixture. |
| `ui/tests/fixtures/entry-sheets.tsx` | No input migration needed: already uses `chartEditorInventory({ ocularHealthSections: ... })`. File remains unchanged; REV 2's `openFromShelf` tests continue using this real fixture. |

No pre-existing test or caller was deleted. The completed full UI run has 1,779 passing tests, zero failures, zero skips. The two name-node assertions called out as pending in the earlier blocked bundle are now present and passing.
