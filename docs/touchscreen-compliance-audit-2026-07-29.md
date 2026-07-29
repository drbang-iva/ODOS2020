# Touchscreen compliance audit — 2026-07-29

## Status

**Complete — static sweep and bounded rendered verification. Report only; no fixes.**

This report is based on ODOS2020 commit `0799b5971a016d9cef0a239a006b73b40b188f18`
(`origin/main` when the audit began). Pass 2 used the local synthetic clinician account
against the isolated audit stack at UI `127.0.0.1:5174` and MCP `127.0.0.1:3334`.
Screenshots are committed under
`docs/build-log/touchscreen-compliance-audit-2026-07-29/`.

## Coverage and method

- Reviewed **all 139 `.tsx` files under `ui/src`**. Nothing was sampled, truncated, or
  skipped.
- The current tree is larger than the kickoff's 129-file snapshot. Source inventory found
  **215 `<input>` elements, 132 `<select>` elements, and 27 `<textarea>` elements**.
- Reviewed all six files under `ui/src/components/inputs/` as the compliance baseline.
  Controls routed through those components were not flagged.
- Reviewed **27 `PowerDropdown` call sites** and did not flag them; the merged component is
  a thin `OdosSelect` alias and the kickoff explicitly marks those call sites compliant.
- Open-ended narrative, notes, names, addresses, dates, identifiers, and other genuinely
  free-text values were reviewed but are not findings merely because they use an input or
  textarea.
- Native selects with a 44px (`h-11`) interactive element and ordinary keyboard behavior
  were treated as compliant. `h-10`/`sidebar-input`/`scheduler-input` are 40px;
  `scheduler-select` and `h-9` are 36px; `h-8` is 32px. Those fail Rule 12.
- The static hover sweep found two non-findings: `IopTimeline` reveals only a decorative
  marker outline on hover, and scheduler appointment cards expose the hover card on focus
  and retain a click path. No hover-only interaction violation was confirmed statically.
- A repeated JSX helper or mapped field family is one finding row. The rendered labels
  column names every affected field family; totals below count finding rows, not the number
  of OD/OS or mapped runtime instances.
- Pass 2 rendered the encounter and most operational routes at **1440×1000**. The final
  insurance/scheduler routes reverted to the in-app browser's 402px responsive viewport;
  their controls were confirmed in the semantic DOM, but the W26 and W30-W32 edit overlays
  are clipped off-canvas in the PNGs. That evidence bound is explicit and is also a separate
  responsive-layout risk; it did not change the input-control classifications.
- The rendered sweep produced **52 PNG evidence artifacts**. Each BLOCKER and WARN row links
  to its screen; where a fixture-dependent subcontrol could not be instantiated, the row says
  so rather than presenting the screenshot as full control-level proof.
- Conditional controls were exercised where the synthetic fixtures allowed. Six clinical
  rows could not be fully instantiated: diagnosis association requires saved observations
  (B16), OCT refinement requires a saved imaging study (B38-B39), and the referral composer
  was obstructed by the encounter action layer (B63, B67-B68). Operational rows whose edit
  controls require a matching worklist/payment fixture are disclosed in their screenshot
  cells. Their source findings remain, but the bound is explicit.
- The provisional list had already excluded the six merged primitives and all 27
  `PowerDropdown` call sites. **No provisional finding rows were dropped in Pass 2**:
  rendered verification confirmed that the remaining native/custom controls were not
  secretly routed through a compliant wrapper.

## Findings totals

| Severity | Finding rows | Rendered verification |
|---|---:|---|
| BLOCKER | 68 | Screen-linked; conditional bounds disclosed per row |
| WARN | 35 | Screen-linked; conditional bounds disclosed per row |
| NIT | 20 | Rendered verification not required by kickoff |
| **Total** | **123** | **Pass 2 complete within stated fixture/state bounds** |

## BLOCKER

Clinically-facing controls used in patient selection, exam, chart, treatment, or clinical
record review. Per the kickoff, severity intentionally errs high.

| ID | File:line | Rendered field label(s) | Screen | Rule | Target primitive | Screenshot / rendered result |
|---|---|---|---|---|---|---|
| B01 | `ui/src/components/ChartSidebar.tsx:305-306,567-568` | Allergy name / RxNorm code; Problem / SNOMED code | Chart sidebar — allergies and problems | 2, 12 (open clinical code sets are raw text) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B02 | `ui/src/components/ChartSidebar.tsx:360` | Smoking status | Chart sidebar — social history | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B03 | `ui/src/components/ChartSidebar.tsx:454` | Care-team role | Chart sidebar — care team | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B04 | `ui/src/components/ChartSidebar.tsx:459` | PractitionerRole | Chart sidebar — care team | 2, 12 (FHIR reference entered as raw text) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B05 | `ui/src/components/Hud.tsx:192,206` | Existing program; New program type | Start comprehensive exam | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/05-chart-visual-acuity-role-add-section.png) — Screen rendered; Start-exam program controls were not instantiated. |
| B06 | `ui/src/components/RoleSelector.tsx:10` | Role | Encounter header / clinical HUD | 12 (36px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/05-chart-visual-acuity-role-add-section.png) — Rendered; finding confirmed. |
| B07 | `ui/src/scenes/PatientPicker.tsx:97` | Search patients | Clinic patient picker and shared patient-search entry points | 2, 12 (custom open-set picker) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/01-patient-picker-and-office-search.png) — Rendered; finding confirmed. |
| B08 | `ui/src/components/OfficeChannel.tsx:191` | Find a patient | Persistent clinic patient search | 2, 12 (custom async picker) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/01-patient-picker-and-office-search.png) — Rendered; finding confirmed. |
| B09 | `ui/src/components/LongitudinalImagingCard.tsx:275` | Procedure or protocol | Chart — longitudinal imaging | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/30-chart-imaging.png) — Rendered; finding confirmed. |
| B10 | `ui/src/components/series-tracker/SeriesTrackerPanel.tsx:84` | Treatment protocol | Patient series tracker | 12 (36px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/02-patient-overview-series-diagnosis-filter.png) — Rendered; finding confirmed. |
| B11 | `ui/src/components/charting/AssessmentSection.tsx:489,493,744,773,797` | Diagnosis tier; Laterality; Diagnosis visit status; Problem laterality; Problem status | Chart — Assessment / Plan | 12 (32–40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/31-chart-assessment.png) — Rendered; finding confirmed. |
| B12 | `ui/src/components/charting/AssessmentSection.tsx:498-499,782-783` | ICD-10 code; Diagnosis label; Problem code; Problem label | Chart — Assessment / problem list | 2, 12 (open diagnosis set entered as paired raw text) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/31-chart-assessment.png) — Rendered; finding confirmed. |
| B13 | `ui/src/components/charting/AutoRefractionSection.tsx:174` | Source | Chart — Auto-refraction | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/07-chart-auto-refraction.png) — Rendered; finding confirmed. |
| B14 | `ui/src/components/charting/AutoRefractionSection.tsx:206,261,266` | OD/OS auto-refraction axis; Flat axis; Steep axis | Chart — Auto-refraction / keratometry | 1, 12 (numeric values use 40px native selects) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/07-chart-auto-refraction.png) — Rendered; finding confirmed. |
| B15 | `ui/src/components/charting/CoverTestSection.tsx:158` | Type / direction / laterality / comitancy coded fields | Chart — Cover test | 12 (40px native select helper) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/10-chart-cover-test.png) — Rendered; finding confirmed. |
| B16 | `ui/src/components/charting/DiagnosisPicker.tsx:148` | Search full diagnosis catalog | Cup/Disc and Refraction diagnosis association | 2, 12 (custom async/open-set picker) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/19-chart-cup-disc.png) — Screen rendered; diagnosis search requires a saved Observation. |
| B17 | `ui/src/components/charting/CupDiscSection.tsx:325-334` | Disc appearance descriptors | Chart — Cup/Disc | 9, 12 (multi-valued clinical field is a checkbox grid) | `OdosChips` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/19-chart-cup-disc.png) — Rendered; finding confirmed. |
| B18 | `ui/src/components/charting/CustomFindingSection.tsx:252` | Dynamic numeric finding | Chart — custom finding section | 1 (raw numeric input; no centered wheel) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/24-dry-eye-tear-volume.png) — Rendered; finding confirmed. |
| B19 | `ui/src/components/charting/CustomFindingSection.tsx:268` | Dynamic multi-select finding | Chart — custom finding section | 9, 12 (multi-valued field is a checkbox tree) | `OdosChips` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/29-dry-eye-staging-subtype.png) — Rendered; finding confirmed. |
| B20 | `ui/src/components/charting/CvfSection.tsx:143` | Method | Chart — Confrontation visual fields | 5, 12 (40px native method select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/09-chart-confrontation-fields.png) — Rendered; finding confirmed. |
| B21 | `ui/src/components/charting/DilationSection.tsx:76` | Dilation agent; Eyes | Chart — Dilation | 12 (each repeated administration row uses 40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/11-chart-dilation.png) — Rendered; finding confirmed. |
| B22 | `ui/src/components/charting/DilationSection.tsx:76` | Drops | Chart — Dilation | 1, 12 (raw numeric input 1–10) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/11-chart-dilation.png) — Rendered; finding confirmed. |
| B23 | `ui/src/components/charting/DryEyeGlandStructureSection.tsx:290,297,304,315` | Eye; Lid; Scoring system; Dropout grade | Chart — Dry eye gland structure / meibography | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/26-dry-eye-gland-structure.png) — Rendered; finding confirmed. |
| B24 | `ui/src/components/charting/DryEyeGlandStructureSection.tsx:311` | Meibography total score | Chart — Dry eye gland structure / meibography | 1, 12 (raw numeric score) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/26-dry-eye-gland-structure.png) — Rendered; finding confirmed. |
| B25 | `ui/src/components/charting/DryEyeSection.tsx:243,300` | Questionnaire instrument; Product | Chart — Dry eye | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/21-chart-dry-eye.png) — Rendered; finding confirmed. |
| B26 | `ui/src/components/charting/DryEyeSection.tsx:258` | Integer questionnaire answer | Chart — Dry eye questionnaire | 1, 12 (36px raw numeric input) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/22-dry-eye-symptoms.png) — Rendered; finding confirmed. |
| B27 | `ui/src/components/charting/EntranceMeasurementSection.tsx:120` | Dynamic numeric / axis measurement | Chart — Entrance measurement battery | 1, 12 (numeric list rendered as 40px native select) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/23-dry-eye-tear-stability.png) — Rendered; finding confirmed. |
| B28 | `ui/src/components/charting/EntranceMeasurementSection.tsx:128` | Dynamic coded measurement | Chart — Entrance measurement battery | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/23-dry-eye-tear-stability.png) — Rendered; finding confirmed. |
| B29 | `ui/src/components/charting/EntranceStateSection.tsx:222` | Dynamic coded state field | Chart — Entrance state battery | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/29-dry-eye-staging-subtype.png) — Rendered; finding confirmed. |
| B30 | `ui/src/components/charting/EomSection.tsx:82` | OD/OS nine-position gaze values | Chart — EOM / diplopia | 12 (36px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/08-chart-eom-diplopia.png) — Rendered; finding confirmed. |
| B31 | `ui/src/components/charting/EomSection.tsx:86` | Diplopia type; Direction; Comitancy; Worst gaze; Frequency | Chart — EOM / diplopia | 12 (40px native select helper) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/08-chart-eom-diplopia.png) — Rendered; finding confirmed. |
| B32 | `ui/src/components/charting/EyeGrowthSection.tsx:186,257` | Reference curve; Biometry method | Chart — Eye Growth | 5, 12 (36–40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/33-chart-eye-growth.png) — Rendered; finding confirmed. |
| B33 | `ui/src/components/charting/EyeGrowthSection.tsx:209,223` | OD/OS axial length; OD/OS corneal radius | Chart — Eye Growth | 1, 12 (raw numeric measurements, no centered wheel) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/33-chart-eye-growth.png) — Rendered; finding confirmed. |
| B34 | `ui/src/components/charting/HpiSection.tsx:330` | Search complaints | Chart — HPI | 2, 12 (custom async/open-set search field) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B35 | `ui/src/components/charting/HpiSection.tsx:358,427,432` | Review-of-systems status; Severity; Duration unit | Chart — HPI | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B36 | `ui/src/components/charting/HpiSection.tsx:431` | Duration value | Chart — HPI | 1, 12 (raw numeric input) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B37 | `ui/src/components/charting/HpiSection.tsx:437` | Referring physician | Chart — HPI | 2 (provider set entered as raw text) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/12-chart-hpi-and-sidebar.png) — Rendered; finding confirmed. |
| B38 | `ui/src/components/charting/ImagingSection.tsx:368` | OCT structure | Chart — Imaging refinement | 2, 12 (small enumerable anatomy list entered as raw text) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/30-chart-imaging.png) — Imaging screen rendered; OCT refinement requires a saved study. |
| B39 | `ui/src/components/charting/ImagingSection.tsx:369,376,423` | OCT laterality; Refinement confidence; Artifact type | Chart — Imaging refinement / artifact import | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/30-chart-imaging.png) — Imaging screen rendered; refinement fields require a saved study. |
| B40 | `ui/src/components/charting/IopTimeline.tsx:434,448` | Target percent; Direct target mmHg | Chart — IOP target editor | 1, 12 (32–36px raw numeric inputs) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/05-chart-visual-acuity-role-add-section.png) — Encounter rendered; target editor requires saved IOP history. |
| B41 | `ui/src/components/charting/MyopiaManagementSection.tsx:239,245,271` | Atropine concentration; Frequency; Education snippet | Chart — Myopia management | 2, 12 (40px selects plus enumerable frequency raw text) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/17-chart-myopia-management.png) — Rendered; finding confirmed. |
| B42 | `ui/src/components/charting/OcularHealthSection.tsx:281` | Numeric grade | Chart — Ocular health | 1 (raw numeric grade inside a composite control) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/18-chart-ocular-health-cornea.png) — Rendered; finding confirmed. |
| B43 | `ui/src/components/charting/OcularHealthSection.tsx:283` | Coded grade | Chart — Ocular health | 12 (sub-44px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/18-chart-ocular-health-cornea.png) — Rendered; finding confirmed. |
| B44 | `ui/src/components/charting/OcularHealthSection.tsx:308` | Multi-valued finding options | Chart — Ocular health | 9, 12 (multi-valued field is a checkbox tree) | `OdosChips` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/18-chart-ocular-health-cornea.png) — Rendered; finding confirmed. |
| B45 | `ui/src/components/charting/OrthoKSection.tsx:306` | Fitting finding | Chart — Ortho-K | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/16-chart-ortho-k.png) — Rendered; finding confirmed. |
| B46 | `ui/src/components/charting/PrescriptionSection.tsx:240,310` | Formulary; Directory entry | Chart — Prescription | 2, 12 (custom open-set drug and pharmacy queries) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/32-chart-prescriptions.png) — Rendered; finding confirmed. |
| B47 | `ui/src/components/charting/PrescriptionSection.tsx:294,299` | Route; Assessment diagnosis | Chart — Prescription | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/32-chart-prescriptions.png) — Rendered; finding confirmed. |
| B48 | `ui/src/components/charting/RefractionSection.tsx:238,262,276` | Source; Refraction type; Purpose | Chart — Refraction | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/13-chart-refraction.png) — Rendered; finding confirmed. |
| B49 | `ui/src/components/charting/RefractionSection.tsx:330` | OD/OS axis | Chart — Refraction | 1, 12 (numeric axis rendered as 40px native select) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/13-chart-refraction.png) — Rendered; finding confirmed. |
| B50 | `ui/src/components/charting/VaValueSelect.tsx:60,78` | Visual acuity value; Modifier | Visual Acuity, Wearing Rx, Refraction, Soft CL, Specialty CL | 12 (shared 40px custom native-select pair) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/05-chart-visual-acuity-role-add-section.png) — Rendered; finding confirmed. |
| B51 | `ui/src/components/charting/VaSection.tsx:101` | OD/OS visual acuity for non-Snellen numeric chart types | Chart — Visual Acuity | 1 (ETDRS/logMAR numeric values fall back to raw text) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/05-chart-visual-acuity-role-add-section.png) — Visual Acuity rendered; non-Snellen numeric mode was not selected. |
| B52 | `ui/src/components/charting/SoftContactLensSection.tsx:266-267,306,314-315,333` | Usage; Status; Underlying condition; Manufacturer; Product; Color/MF-PWR | Chart — Soft Contact Lenses | 3, 12 (40px native cascade selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/14-chart-soft-contact-lenses.png) — Rendered; finding confirmed. |
| B53 | `ui/src/components/charting/SoftContactLensSection.tsx:319,324` | Manual base curve; Manual diameter | Chart — Soft Contact Lenses | 1, 3, 12 (raw numeric text inputs) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/14-chart-soft-contact-lenses.png) — Rendered; finding confirmed. |
| B54 | `ui/src/components/charting/SoftContactLensSection.tsx:328-331,348-350` | Sphere; Cylinder; Axis; Add; Over-refraction values | Chart — Soft Contact Lenses | 1, 12 (numeric values rendered as 40px native selects) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/14-chart-soft-contact-lenses.png) — Rendered; finding confirmed. |
| B55 | `ui/src/components/charting/SpecialtyContactLensSection.tsx:444-445,505,513-518,546` | Usage; Status; Underlying condition; Manufacturer; Product; Lens type; Material; Additional coded fields | Chart — Specialty Contact Lenses | 3, 12 (40px native cascade selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/15-chart-specialty-contact-lens.png) — Rendered; finding confirmed. |
| B56 | `ui/src/components/charting/SpecialtyContactLensSection.tsx:527-530,574-576` | Sphere; Cylinder; Axis; Add; Over-refraction values | Chart — Specialty Contact Lenses | 1, 12 (numeric values rendered as 40px native selects) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/15-chart-specialty-contact-lens.png) — Rendered; finding confirmed. |
| B57 | `ui/src/components/charting/WearingSection.tsx:177,212,269` | Source; Eyeglass type; Prism base | Chart — Wearing Rx | 6, 12 (40px native selects; prism direction remains separate but undersized) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/06-chart-wearing-rx.png) — Rendered; finding confirmed. |
| B58 | `ui/src/components/charting/WearingSection.tsx:258` | OD/OS axis | Chart — Wearing Rx | 1, 12 (numeric axis rendered as 40px native select) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/06-chart-wearing-rx.png) — Rendered; finding confirmed. |
| B59 | `ui/src/scenes/EncounterCharting.tsx:466` | Add section group | Encounter chart | 12 (sub-44px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/05-chart-visual-acuity-role-add-section.png) — Rendered; finding confirmed. |
| B60 | `ui/src/components/LongitudinalImagingCard.tsx:279` | Anatomical structure | Chart — longitudinal imaging capture | 2 (small procedure-constrained anatomy set entered as raw text) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/30-chart-imaging.png) — Rendered; finding confirmed. |
| B61 | `ui/src/components/charting/GonioscopySection.tsx:150` | OD/OS quadrant grades | Chart — Gonioscopy | 12 (36px quadrant-specific native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/20-chart-gonioscopy.png) — Rendered; finding confirmed. |
| B62 | `ui/src/scenes/PatientOverview.tsx:259` | By diagnosis | Patient overview — procedure history filter | 12 (unstyled native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/02-patient-overview-series-diagnosis-filter.png) — Rendered; finding confirmed. |
| B63 | `ui/src/components/referral/ReferralCompose.tsx:418` | Name or organization | Chart — Referral compose | 2, 12 (custom async/open-set consultant search) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/31-chart-assessment.png) — Encounter rendered; referral composer was obstructed by the encounter action layer. |
| B64 | `ui/src/components/charting/DilationSection.tsx:76` | Administered dilation agents | Chart — Dilation | 9 (genuinely multi-valued medication list is assembled as repeated single-select rows) | `OdosChips` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/11-chart-dilation.png) — Rendered; finding confirmed. |
| B65 | `ui/src/components/LongitudinalImagingCard.tsx:345` | Baseline image; Follow-up image | Chart — longitudinal imaging comparison | 2, 12 (open, growing image set uses 40px native selects) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/30-chart-imaging.png) — Rendered; finding confirmed. |
| B66 | `ui/src/components/charting/SoftContactLensSection.tsx:321,326` | Catalog base curve; Catalog diameter | Chart — Soft Contact Lenses | 1, 3, 12 (bounded numeric catalog parameters use 40px native selects) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/14-chart-soft-contact-lenses.png) — Rendered; finding confirmed. |
| B67 | `ui/src/components/referral/ReferralCompose.tsx:510-529` | Packet contents | Chart — Referral compose | 9, 12 (multi-valued packet field is a sub-44px checkbox list) | `OdosChips` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/31-chart-assessment.png) — Encounter rendered; referral composer was obstructed by the encounter action layer. |
| B68 | `ui/src/components/referral/ReferralCompose.tsx:523-526` | History count | Chart — Referral compose | 1, 12 (bounded 1–50 value uses precision-sized +/− buttons) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/31-chart-assessment.png) — Encounter rendered; referral composer was obstructed by the encounter action layer. |

## WARN

Operational, financial, insurance, claims, scheduling, optical, and patient-registration
controls with the right broad behavior but the wrong primitive, undersized target, or
missing shared keyboard/touch implementation.

| ID | File:line | Rendered field label(s) | Screen | Rule | Target primitive | Screenshot / rendered result |
|---|---|---|---|---|---|---|
| W01 | `ui/src/components/LensesOrderSurface.tsx:327` | Search lenses | Optical order — lens catalog | 2, 12 (custom open-set search) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/40-optical-lens-search.png) — Rendered; finding confirmed. |
| W02 | `ui/src/components/InlinePicker.tsx:121` | Payor organization; Rendering provider | Submit Claims | 2, 12, 13 (custom async picker with sub-44px result rows) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/46-submit-claims.png) — Rendered; finding confirmed. |
| W03 | `ui/src/components/CollectPanel.tsx:284` | Collection amount | Collect payment | 1, 12 (40px raw decimal input) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/39-optical-order.png) — Rendered; finding confirmed. |
| W04 | `ui/src/components/commercial/CreditBankDepositSheet.tsx:92,99` | Deposit amount; Bonus amount | Credit Bank deposit | 1, 12 (40px raw decimal inputs) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/04-credit-bank-deposit.png) — Rendered; finding confirmed. |
| W05 | `ui/src/components/commercial/SaleSheet.tsx:90` | Package | Package sale | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/03-package-sale-sheet.png) — Rendered; finding confirmed. |
| W06 | `ui/src/components/settings/CatalogFields.tsx:155` | Gender | New Patient / patient demographics | 12 (40px native select through shared field kit) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/34-new-patient.png) — Rendered; finding confirmed. |
| W07 | `ui/src/scenes/CloseDay.tsx:71` | Cash / Check / Card / Other counted | Close Day | 1 (raw decimal tender counts) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/35-close-day.png) — Rendered; finding confirmed. |
| W08 | `ui/src/scenes/LabOrdersWorklist.tsx:246` | Problem reason | Lab orders worklist | 12 (unstyled native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/36-lab-orders-worklist.png) — Worklist rendered; no editable problem-reason row in the synthetic fixture. |
| W09 | `ui/src/scenes/MarginLedger.tsx:195` | Manufacturer / Category / Lab filters | Margin ledger | 12 (tiny pill-embedded native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/37-margin-ledger.png) — Rendered; finding confirmed. |
| W10 | `ui/src/scenes/OpticalFrames.tsx:118` | SKU, GTIN, brand, model | Frames inventory | 2, 12 (custom open-set catalog search) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/38-frames-inventory-and-receipt.png) — Rendered; finding confirmed. |
| W11 | `ui/src/scenes/OpticalFrames.tsx:292-303` | Quantity; Sale price; Cost | Receive frames | 1, 12 (40px raw numeric/decimal inputs) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/38-frames-inventory-and-receipt.png) — Rendered; finding confirmed. |
| W12 | `ui/src/scenes/OpticalOrder.tsx:1073,1094,1131,1302,1368,1445,1461,1482` | Order status; Order type; Lab; Tender; Adjustment code; Job type; Frame source; Frame ownership | Optical order / checkout / lab capture | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/39-optical-order.png) — Rendered; finding confirmed. |
| W13 | `ui/src/scenes/OpticalOrder.tsx:1182,1189,1196` | Procedure; Modifier; Diagnosis | Optical order charge lines | 2, 12 (open code sets entered in 32px raw text inputs) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/39-optical-order.png) — Rendered; finding confirmed. |
| W14 | `ui/src/scenes/OpticalOrder.tsx:1205,1214,1222` | Units; Fee; Tax | Optical order charge lines | 1, 12 (32px raw numeric inputs) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/39-optical-order.png) — Rendered; finding confirmed. |
| W15 | `ui/src/scenes/OpticalOrder.tsx:1515` | Treatments | Optical lab capture | 2 (catalog-backed treatment list entered as repeated raw text) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/39-optical-order.png) — Rendered; finding confirmed. |
| W16 | `ui/src/scenes/OpticalOrder.tsx:1600-1602` | Dist PD; Near PD; Seg height | Optical lab fitting | 1, 12 (raw number inputs through shared `Field`) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/39-optical-order.png) — Rendered; finding confirmed. |
| W17 | `ui/src/scenes/claims/ClaimSearch.tsx:159` | Status | Claim search | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/42-claim-search.png) — Rendered; finding confirmed. |
| W18 | `ui/src/scenes/claims/ClaimSearch.tsx:175-178` | Minimum/maximum charged; Minimum/maximum days outstanding | Claim search | 1, 12 (40px raw numeric filters) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/42-claim-search.png) — Rendered; finding confirmed. |
| W19 | `ui/src/scenes/claims/ClaimsWorklist.tsx:295,378` | Resolution; Payer classification | Claims worklist | 12 (sub-44px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/43-claims-worklist.png) — Worklist rendered; no editable resolution/classification row in the synthetic fixture. |
| W20 | `ui/src/scenes/claims/CarrierPayments.tsx:254,357-361` | Total amount; Allowed; Paid; Deductible; Coinsurance; Copay | Carrier payments / ERA entry | 1, 12 (40px raw number inputs) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/44-carrier-payments.png) — Carrier-payment screen rendered; no EOB line-allocation fixture. |
| W21 | `ui/src/scenes/claims/PatientPayments.tsx:349,364` | From invoice; To invoice | Patient payment transfer | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/45-patient-payments.png) — Patient-payment screen rendered; no transferable invoice fixture. |
| W22 | `ui/src/scenes/claims/PatientPayments.tsx:345` | Amount to apply | Patient payment application | 1, 12 (40px raw number input) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/45-patient-payments.png) — Patient-payment screen rendered; no applicable credit/invoice fixture. |
| W23 | `ui/src/scenes/claims/SubmitClaims.tsx:680,867,961` | Payer classification; Relationship; Code set and other shared selects | Submit Claims | 12 (sub-44px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/46-submit-claims.png) — Rendered; finding confirmed. |
| W24 | `ui/src/scenes/claims/SubmitClaims.tsx:943,962` | ICD-10 code; CPT/HCPCS code | Submit Claims | 2 (open medical code sets entered as raw text) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/46-submit-claims.png) — Rendered; finding confirmed. |
| W25 | `ui/src/scenes/claims/SubmitClaims.tsx:964-965` | Fee; Quantity | Submit Claims | 1, 12 (raw numeric fields) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/46-submit-claims.png) — Rendered; finding confirmed. |
| W26 | `ui/src/scenes/insurance/PatientInsurance.tsx:264` | Coverage status / order / relationship enumerations | Patient Insurance | 12 (sub-44px native select helper) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/47-patient-insurance-edit.png) — Coverage editor rendered in the semantic DOM; 402px PNG clips the editor off-canvas. |
| W27 | `ui/src/scenes/insurance/VisionPlanBenefits.tsx:237` | Apply template | Vision Plan Benefits | 12 (sub-44px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/48-vision-plan-benefits.png) — Rendered; finding confirmed. |
| W28 | `ui/src/scenes/insurance/VisionPlanBenefits.tsx:263,272` | Allowance; Copay; Used; Frequency months | Vision Plan Benefits | 1, 12 (numeric benefits use raw text/number fields) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/48-vision-plan-benefits.png) — Rendered; finding confirmed. |
| W29 | `ui/src/scenes/SchedulerDayGrid.tsx:662,715,729` | Grid interval; Office; Clinic mode | Scheduler day grid | 12 (36px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/49-scheduler-day.png) — Rendered; finding confirmed. |
| W30 | `ui/src/scenes/scheduler/AppointmentDetailsModal.tsx:295,313,433,449,629` | Service type; Duration preset; Confirmation status; Appointment status; Coverage / plan choice | Appointment details | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/50-scheduler-appointment-editor.png) — Editor rendered in the semantic DOM; 402px PNG clips the editor off-canvas. |
| W31 | `ui/src/scenes/scheduler/AppointmentDetailsModal.tsx:336` | Custom duration minutes | Appointment details | 1, 12 (40px raw numeric input) | `OdosWheel` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/50-scheduler-appointment-editor.png) — Editor rendered in the semantic DOM; custom-minutes also requires the Custom preset. |
| W32 | `ui/src/scenes/scheduler/AppointmentDetailsModal.tsx:771` | Search patient | Appointment details | 2, 12 (custom async/open-set picker) | `OdosSearchPicker` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/50-scheduler-appointment-editor.png) — Editor rendered in the semantic DOM; patient-search subflow was not opened and the PNG clips the editor. |
| W33 | `ui/src/scenes/scheduler/FindOpenPanel.tsx:97,114` | Visit type; Resource | Find Open | 12 (40px native selects) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/51-scheduler-find-open.png) — Rendered; finding confirmed. |
| W34 | `ui/src/scenes/scheduler/SchedulerWeekGrid.tsx:98` | Resource | Scheduler week grid | 12 (40px native select) | `OdosSelect` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/52-scheduler-week.png) — Rendered; finding confirmed. |
| W35 | `ui/src/scenes/SchedulerDayGrid.tsx:797-805` | Show resource column | Scheduler day-grid column chooser | 9, 12 (multi-valued column selection uses approximately 28px checkbox rows) | `OdosChips` | [Screenshot](build-log/touchscreen-compliance-audit-2026-07-29/53-scheduler-columns.png) — Rendered; finding confirmed. |

## NIT

Settings/admin-only or low-frequency controls. These were statically confirmed; the kickoff
does not require screenshots for NIT findings.

| ID | File:line | Rendered field label(s) | Screen | Rule | Target primitive | Verification |
|---|---|---|---|---|---|---|
| N01 | `ui/src/scenes/AuditLog.tsx:94,98` | Patient; Actor | Audit Log | 2 (FHIR identities entered as raw text) | `OdosSearchPicker` | Static |
| N02 | `ui/src/scenes/AuditLog.tsx:112` | Event Type | Audit Log | 9 (native multi-select rather than chips) | `OdosChips` | Static |
| N03 | `ui/src/scenes/AuditLog.tsx:122` | Outcome | Audit Log | 12 (sub-44px native select) | `OdosSelect` | Static |
| N04 | `ui/src/components/charting/CustomFieldEditor.tsx:59,69` | Type; Unit | Custom chart-field editor | 12 (40px native selects) | `OdosSelect` | Static |
| N05 | `ui/src/components/charting/CustomFieldEditor.tsx:75-77` | Minimum; Maximum; Step | Custom chart-field editor | 1, 12 (40px raw decimal inputs) | `OdosWheel` | Static |
| N06 | `ui/src/components/settings/CatalogFields.tsx:126,273` | Dynamic number/duration; Currency | Shared catalog editors | 1, 12 (40px raw numeric inputs) | `OdosWheel` | Static |
| N07 | `ui/src/components/settings/CatalogFields.tsx:155` | Dynamic enumerated field | Shared catalog editors | 12 (40px native select) | `OdosSelect` | Static |
| N08 | `ui/src/components/settings/CatalogFields.tsx:175-187` | Dynamic multi-select field | Shared catalog editors | 9, 12 (checkbox list rather than chips) | `OdosChips` | Static |
| N09 | `ui/src/components/settings/CatalogFields.tsx:393` | Dynamic reference search | Shared catalog editors | 2, 12 (custom async picker) | `OdosSearchPicker` | Static |
| N10 | `ui/src/scenes/ProtocolLibrary.tsx:347,410,497,567,620,651,666,692,718,756` | Item type; Trigger; Status; Action; Context; Route; Delivery mode; Interval unit | Protocol Library authoring | 12 (40px native selects) | `OdosSelect` | Static |
| N11 | `ui/src/scenes/ProtocolLibrary.tsx:715` | Interval | Protocol Library authoring | 1, 12 (40px raw numeric input) | `OdosWheel` | Static |
| N12 | `ui/src/scenes/ProtocolLibrary.tsx:427,469,480,743` | Diagnosis keys; Visit types; Categories; Charge-rule references | Protocol Library authoring | 9 (multi-valued data entered as comma-delimited text) | `OdosChips` | Static |
| N13 | `ui/src/scenes/ProtocolLibrary.tsx:663,678,689,704` | Medication key; Topic key; Asset reference; Instruction key | Protocol Library authoring | 2 (open catalog/reference sets entered as raw text) | `OdosSearchPicker` | Static |
| N14 | `ui/src/scenes/scheduler/SchedulingSettingsModal.tsx:190,423,457,517,579,634` | Resource; Default booking increment; Office/resource increments; Source; Block kind | Scheduling settings | 12 (40px native selects) | `OdosSelect` | Static |
| N15 | `ui/src/scenes/settings/BillingIdentitySettings.tsx:111` | Tax ID type | Billing identity settings | 12 (sub-44px native select) | `OdosSelect` | Static |
| N16 | `ui/src/scenes/settings/LensCatalogSettings.tsx:355,367,549` | Retail strategy; Retail rounding; Dynamic catalog select | Lens catalog settings | 12 (40px native selects) | `OdosSelect` | Static |
| N17 | `ui/src/scenes/settings/LensCatalogSettings.tsx:363` | Retail multiplier | Lens catalog settings | 1, 12 (40px raw numeric input) | `OdosWheel` | Static |
| N18 | `ui/src/scenes/settings/ProcedureDefinitionsSettings.tsx:74`; `ui/src/scenes/settings/StaffSettings.tsx:64` | Default photo view; Role | Procedure definitions / Staff settings | 12 (sub-44px native selects) | `OdosSelect` | Static |
| N19 | `ui/src/components/settings/FindingSectionGroupsSettings.tsx:323-344` | Default visit-type categories | Finding section-group settings | 9 (multi-valued category field is a checkbox grid) | `OdosChips` | Static |
| N20 | `ui/src/scenes/scheduler/SchedulingSettingsModal.tsx:702-716` | Selected resources | Scheduling block settings | 9, 12 (multi-valued resource scope uses undersized checkbox rows) | `OdosChips` | Static |

## Aesthetics module coverage

`ui/src/components/charting/AestheticsConsentSection.tsx` is present on the shared ODOS
encounter spine. Its only input is a boolean acknowledgement checkbox inside a padded,
clickable label; it does not produce a finding under Rules 1, 2, or 9, and its effective
touch target is larger than the 16px checkbox glyph.

No Aesthetics treatment, procedure-parameter, product, photo-series, or follow-up input
scenes exist under `ui/src` at this head. The universal standard was therefore applied to
the built consent scene, but the future Aesthetics clinical pack is **not covered by this
audit and must be audited when those scenes land**.

## Risks and follow-ups

1. Six clinical rows and several operational edit rows remain **fixture/state bounded**, as
   disclosed above and in their table cells. A follow-up pass with saved OCT/IOP/Observation
   data, an unobstructed referral composer, editable lab/claims rows, and transferable
   payment fixtures should re-capture those exact conditional controls.
2. At the in-app browser's default 402px width, the fixed encounter layout hid the main
   work area, and the insurance/appointment editors were clipped off-canvas. This audit
   widened the viewport to 1440×1000 for the clinical sweep, while the final responsive
   captures are explicitly bounded above. Narrow-screen behavior is a separate release risk
   not scored as an additional input-control finding here.
3. Several shared helpers multiply one source defect across many runtime fields. In
   particular, `VaValueSelect`, `CatalogFieldKit`, `InlinePicker`, `PatientPicker`, and the
   charting `SelectField` helpers should be triaged as shared fixback seams rather than as
   isolated per-screen redesigns.
4. Money fields are reported against the standard's numeric rule, but very large/open-ended
   currency ranges may need an explicit product decision about whether `OdosWheel` remains
   practical. The required target primitive is named here; any exception should be decided
   explicitly rather than silently retaining raw numeric text.
5. No built Aesthetics treatment or procedure-parameter scenes exist at this head. The
   consent section was covered; the future Aesthetics clinical pack needs its own rendered
   audit when it lands.
6. This is a report-only pass. No component, scene, schema, CSS, or behavior was changed.
