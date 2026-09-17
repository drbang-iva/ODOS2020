# Recorded overview expectations — V27 / overview parity

Only the authorized test file changed; its 14 missing literal expectations now accompany the existing JSON expectations. The projection was captured for inspection, then reviewed against each synthetic input and the existing overview contract. The assertion has no fallback to a capture result. Deleting capture1 is a failing mutation naming capture1.

| Capture | Reviewed expectation and input reason |
| --- | --- |
| 1 | Four deferred representations: explicit Other and dilation reasons retained; two notVisualized JSON values have no reason; all interpretations unknown. No configured sections. |
| 2 | One lids observation cannot complete the Ocular Health group: partial, zero resolved of one. |
| 10 | Input cornea/lids observations are ordered by section order (lids before cornea), not input order. Both remain examined with unknown interpretation. |
| 11 | Current IOP quantity18 and prior quantity16 retain their own dates, units and previous reference. No interpretation inferred from the numeric value. |
| 12 | Six configured sections resolve, including Assessment from diagnoses. Entrance is examined but still carries one missing deferred-reason documentation issue. |
| 13 | Unreasserted carried history is visible but does not complete History; carried count1, zero of six resolved. |
| 14 | Reasserted carried history completes History only; carried-unreasserted count0, one of six resolved. |
| 15 | Abnormal and borderline IOP remain distinct; both complete Pretest, but only abnormal increments abnormalCount. |
| 16 | Equivocal cup-disc interpretation maps to borderline. No configured sections. |
| 17–18 | Unknown and prototype-named visit categories have no configured requirements, empty findings/sections, unconfigured completeness. |
| 19 | Required History is not examined; optional Refraction is not indicated and excluded from the required count. |
| 20 | The entered-in-error OS CVF is removed; live OD CVF and pupils remain. |
| 21 | Both CVF rows are entered-in-error; only live pupils remain. |

The full literal snapshots also retain exact references, dates, display fields, raw component/value representations and prior evidence. No medical code or unit was invented; these are copies of the pre-existing fixtures.
