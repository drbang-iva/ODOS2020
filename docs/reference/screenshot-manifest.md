# Screenshot Manifest — Eyefinity Reference Captures

110 screenshots from Eyefinity's two-app suite (ExamWriter EHR + Encompass PM), captured March 30, 2026 via Playwright automation and manual capture from IVA's live account.

**How to use:** When building an OSOD feature, find the relevant screenshots below and read them with the Read tool. Each entry maps to the structured reference doc section where the analysis lives.

**Structured reference docs (full analysis):**
- `performance-od/reference/domain/open-source-od/software-references/examwriter.md` — EHR clinical
- `performance-od/reference/domain/open-source-od/software-references/eyefinity-encompass-pm.md` — PM front desk
- `osod/docs/reference/examwriter-ehr-layout.md` — 478-line Playwright field-level EHR detail
- `performance-od/reference/domain/open-source-od/software-references/ui-paradigm-analysis.md` — paradigm naming

---

## Quick Lookup by OSOD Module

### Building Patient CRUD? Look at:
- `examwriter-screenshot-15.png` — Patient chart with demographics banner
- `examwriter-screenshot-16.png` — Full left sidebar + demographics
- `.playwright-mcp/page-2026-03-30T21-10-17-127Z.png` — PM patient search (empty)
- `.playwright-mcp/page-2026-03-30T21-12-37-613Z.png` — PM patient search (with results)
- `.playwright-mcp/page-2026-03-30T21-13-33-339Z.png` — Demographics top (contact info, Patient ID)
- `.playwright-mcp/page-2026-03-30T21-14-15-303Z.png` — Demographics bottom (personal info, MU fields)
- `.playwright-mcp/page-2026-03-30T21-16-40-322Z.png` — Demographics middle (communication preferences matrix)

### Building Scheduling? Look at:
- `.playwright-mcp/page-2026-03-30T21-05-51-074Z.png` — Schedule week view (empty/closed)
- `.playwright-mcp/page-2026-03-30T21-06-41-897Z.png` — Schedule day view with appointments (color-coded)
- `.playwright-mcp/page-2026-03-30T21-07-20-065Z.png` — Patient quick-view hover card from schedule
- `.playwright-mcp/page-2026-03-30T21-08-55-429Z.png` — Resource schedule setup (availability)
- `.playwright-mcp/page-2026-03-30T21-09-07-013Z.png` — Resource schedule template editor

### Building Clinical Exam (Pre-Test)? Look at:
- `examwriter-screenshot-1.png` — Binocular vision / cover test entry
- `examwriter-screenshot-2.png` — Phorias (scrolled)
- `examwriter-screenshot-3.png` — Phorias detail with test methods
- `examwriter-screenshot-4.png` — Phorias (vertical/near fields)
- `examwriter-screenshot-5.png` — AC/A ratio + near point testing
- `examwriter-screenshot-6.png` — NPC reliability dropdown options
- `examwriter-screenshot-7.png` — Fusion/stereopsis + Titmus stereo
- `examwriter-screenshot-8.png` — Misc tests (accommodative facility)
- `examwriter-screenshot-9.png` — MEM retinoscopy
- `examwriter-screenshot-10.png` — Accommodative lag coded values
- `examwriter-screenshot-11.png` — Motility test type selection
- `examwriter-screenshot-12.png` — 9-gaze position grid (ductions/versions)
- `examwriter-screenshot-13.png` — Test details (distance acuity)
- `examwriter-screenshot-14.png` — Confrontation VF grid

### Building Clinical Exam (Slit Lamp / Anterior Segment)? Look at:
- `examwriter-screenshot-19-virtual-exam-room.png` — Exam set selector modal
- `examwriter-screenshot-20-eye-exam.png` — External exam (lids, adnexae)
- `examwriter-screenshot-20b-fullpage.png` — Full-page eye exam layout
- `examwriter-screenshot-21.png` — Cornea SLE (full checkbox list)
- `examwriter-screenshot-22.png` — AC/Iris SLE
- `examwriter-screenshot-23.png` — Lens SLE (LOCS III grading)

### Building Clinical Exam (Posterior Segment)? Look at:
- `examwriter-screenshot-24.png` — Fundus (retinal exam overview)
- `examwriter-screenshot-25.png` — Optic nerve (C/D ratio, SVP, NRR)
- `examwriter-screenshot-26.png` — Iris/lens detail
- `examwriter-screenshot-27.png` — Vitreous + vascular
- `examwriter-screenshot-28.png` — Macula (drusen, AMD, ERM, etc.)
- `examwriter-screenshot-29.png` — Retina (DR, hemorrhages, NV)
- `examwriter-screenshot-30.png` — Periphery (lattice, tears, detachment)

### Building Specialized Evaluations? Look at:
- `examwriter-screenshot-31.png` — Dilation documentation options
- `examwriter-screenshot-32.png` — Cranial nerve testing (part 1)
- `examwriter-screenshot-33.png` — Cranial nerve testing (part 2)
- `examwriter-screenshot-34.png` — Eyelid evaluation (MRD, levator)
- `examwriter-screenshot-35.png` — Eyelid evaluation (Hering's, laxity)
- `examwriter-screenshot-36.png` — Exophthalmometer / orbit
- `examwriter-screenshot-37.png` — Orbit evaluation detail
- `examwriter-screenshot-38.png` — IOP + dilating drops
- `examwriter-screenshot-39.png` — Gonioscopy (view 1)
- `examwriter-screenshot-40.png` — Gonioscopy (view 2, Shaffer grades)
- `examwriter-screenshot-41.png` — Gonioscopy (view 3, TM pigment)
- `examwriter-screenshot-42.png` — Gonioscopy (Van Herick)
- `examwriter-screenshot-43.png` — Skin inspection
- `examwriter-screenshot-44.png` — Vital signs

### Building Drawing/Annotation Tools? Look at:
- `examwriter-screenshot-45.png` — Drawing: External Eyes (4 photos)
- `examwriter-screenshot-46.png` — Drawing: Slit Lamp (concentric rings)
- `examwriter-screenshot-47.png` — Drawing: Fundus (with warning dialog)
- `examwriter-screenshot-48.png` — Drawing: Cross Section (full anatomy)
- `examwriter-screenshot-49.png` — Drawing: Gonioscopy (4-quadrant)
- `examwriter-screenshot-50.png` — Drawing: Head (4 views, 3D)
- `examwriter-screenshot-51.png` — Drawing: Lateral Left (profile)
- `examwriter-screenshot-52.png` — Drawing: Normalized Fundus (zonal)
- `examwriter-screenshot-53.png` — Drawing: Sensorimotor Exam (9-gaze)

### Building Diagnosis/Assessment/Plan? Look at:
- `examwriter-screenshot-54-dx.png` — Main diagnosis panel (ICD-10 Expert)
- `examwriter-screenshot-55-dx.png` — Tear film osmolarity: Details tab
- `examwriter-screenshot-56-dx.png` — Tear film osmolarity: Diagnosis tab
- `examwriter-screenshot-57-dx.png` — Tear film osmolarity: Assessment (diagnosis dropdowns)
- `examwriter-screenshot-58-dx.png` — KCS: Assessment/Plan (treatment checkboxes)
- `examwriter-screenshot-59-dx.png` — Punctal occlusion: Details tab
- `examwriter-screenshot-60-dx.png` — Punctal occlusion: Billing tab
- `examwriter-screenshot-61-dx.png` — Punctal occlusion: Consent tab
- `examwriter-screenshot-62-dx.png` — E-prescribing: Select Prescription modal
- `examwriter-screenshot-63-dx.png` — Diagnosis panel with fundus view
- `examwriter-screenshot-64-dx.png` — Disc photos: Details tab
- `examwriter-screenshot-65-dx.png` — Disc photos: Diagnosis dropdown
- `examwriter-screenshot-66-dx.png` — Disc photos: Full diagnosis list
- `examwriter-screenshot-67-dx.png` — Disc photos: Assessment/Plan tab
- `examwriter-screenshot-68-dx.png` — Gonioscopy: Details tab
- `examwriter-screenshot-69-dx.png` — Visual field test type selection
- `examwriter-screenshot-70-dx.png` — Visual field: Findings checkboxes
- `examwriter-screenshot-71-dx.png` — Visual field: Findings (duplicate)
- `examwriter-screenshot-72-dx.png` — Automated perimetry: Assessment/Plan
- `examwriter-screenshot-73-dx.png` — OCT: Details (RNFL thickness fields)
- `examwriter-screenshot-74-dx.png` — OCT: Diagnosis checkboxes
- `examwriter-screenshot-75-dx.png` — OCT optic nerve: Diagnosis tab
- `examwriter-screenshot-76-dx.png` — OCT: Assessment/Plan (progression)
- `examwriter-screenshot-77-dx.png` — OCT: Billing (medical necessity)
- `examwriter-screenshot-78-dx.png` — Rx search modal (glaucoma meds)
- `examwriter-screenshot-79-dx.png` — Full diagnosis list (diabetic patient)
- `examwriter-screenshot-80-dx.png` — DR sub-diagnoses expanded
- `examwriter-screenshot-81-dx.png` — DR sub-types (ICD-10 hierarchy)

### Building Contact Lens Module? Look at:
- `examwriter-screenshot-17.png` — Specialty CL prescriptions (all fields)

### Building Billing/Claims? Look at:
- `.playwright-mcp/page-2026-03-30T21-17-57-775Z.png` — Claim search (CMS-1500 refs)
- `.playwright-mcp/page-2026-03-30T21-18-17-879Z.png` — EDI transmission queue

### Building Inventory/Optical? Look at:
- `.playwright-mcp/page-2026-03-30T21-10-33-322Z.png` — Order management (invoiced orders)
- `.playwright-mcp/page-2026-03-30T21-15-40-666Z.png` — Inventory: Stock orders
- `.playwright-mcp/page-2026-03-30T21-16-27-910Z.png` — Inventory: Frame lookup
- `.playwright-mcp/page-2026-03-30T21-16-40-322Z.png` — Inventory: Adjustments
- `.playwright-mcp/page-2026-03-30T21-16-52-698Z.png` — Inventory: Physical count

### Building Admin/Setup? Look at:
- `.playwright-mcp/page-2026-03-30T21-21-48-654Z.png` — Admin home (setup dashboard)
- `.playwright-mcp/page-2026-03-30T21-22-15-147Z.png` — Provider setup
- `.playwright-mcp/page-2026-03-30T21-22-28-134Z.png` — Edit provider modal (NPI, DEA, e-sig)
- `.playwright-mcp/page-2026-03-30T21-23-36-569Z.png` — Staff setup
- `.playwright-mcp/page-2026-03-30T21-25-34-183Z.png` — Service/exam setup (CPT codes)

### Building Reports? Look at:
- `.playwright-mcp/page-2026-03-30T21-19-09-046Z.png` — Report categories (7 types)

### Building Visit Overview / Patient Chart? Look at:
- `visit-overview-full.png` — Complete visit summary (full page)
- `.playwright-mcp/page-2026-03-30T21-35-14-646Z.png` — EHR note history with filters

### PM Dashboard:
- `.playwright-mcp/page-2026-03-30T21-05-40-145Z.png` — Message center / dashboard tiles

---

## Full Screenshot Index

### ExamWriter EHR (82 files) — `examwriter-screenshot-*.png`

| # | File | Shows |
|---|------|-------|
| 1 | `examwriter-screenshot-1.png` | Pre-test: binocular vision, cover test, phorias |
| 2 | `examwriter-screenshot-2.png` | Phorias (scrolled detail) |
| 3 | `examwriter-screenshot-3.png` | Phorias: test method options |
| 4 | `examwriter-screenshot-4.png` | Phorias: vertical/near fields |
| 5 | `examwriter-screenshot-5.png` | AC/A ratio + near point convergence |
| 6 | `examwriter-screenshot-6.png` | NPC reliability dropdown |
| 7 | `examwriter-screenshot-7.png` | Fusion/stereopsis + Titmus stereo test |
| 8 | `examwriter-screenshot-8.png` | Misc tests: accommodative facility |
| 9 | `examwriter-screenshot-9.png` | MEM retinoscopy |
| 10 | `examwriter-screenshot-10.png` | Accommodative lag coded values |
| 11 | `examwriter-screenshot-11.png` | Motility: test type selection |
| 12 | `examwriter-screenshot-12.png` | Motility: 9-gaze grid (ductions/versions) |
| 13 | `examwriter-screenshot-13.png` | Test details: distance acuity |
| 14 | `examwriter-screenshot-14.png` | Confrontation visual field grid |
| 15 | `examwriter-screenshot-15.png` | Patient chart with demographics banner |
| 16 | `examwriter-screenshot-16.png` | Full left sidebar + tonometry |
| 17 | `examwriter-screenshot-17.png` | Specialty contact lens prescriptions |
| 18 | `examwriter-screenshot-18.png` | Diagnostic drops section |
| 19 | `examwriter-screenshot-19-virtual-exam-room.png` | Virtual exam room: exam set selector |
| 20 | `examwriter-screenshot-20-eye-exam.png` | Eye exam: external (lids, adnexae) |
| 20b | `examwriter-screenshot-20b-fullpage.png` | Full-page eye exam layout |
| 21 | `examwriter-screenshot-21.png` | Cornea SLE (full checkbox list) |
| 22 | `examwriter-screenshot-22.png` | AC/Iris SLE |
| 23 | `examwriter-screenshot-23.png` | Lens SLE (LOCS III cataract grading) |
| 24 | `examwriter-screenshot-24.png` | Fundus exam overview |
| 25 | `examwriter-screenshot-25.png` | Optic nerve: C/D ratio, SVP, NRR, vessels |
| 26 | `examwriter-screenshot-26.png` | Iris/lens detail + melanocytosis |
| 27 | `examwriter-screenshot-27.png` | Vitreous + vascular exam |
| 28 | `examwriter-screenshot-28.png` | Macula: drusen, AMD, ERM, macular hole |
| 29 | `examwriter-screenshot-29.png` | Retina: DR staging, hemorrhages, NV |
| 30 | `examwriter-screenshot-30.png` | Periphery: lattice, tears, detachment |
| 31 | `examwriter-screenshot-31.png` | Dilation documentation / exam controls |
| 32 | `examwriter-screenshot-32.png` | Cranial nerve testing (part 1: CN II-VI) |
| 33 | `examwriter-screenshot-33.png` | Cranial nerve testing (part 2: CN VII-XII) |
| 34 | `examwriter-screenshot-34.png` | Eyelid: palpebral fissure, MRD, levator |
| 35 | `examwriter-screenshot-35.png` | Eyelid: Hering's, orbicularis, laxity |
| 36 | `examwriter-screenshot-36.png` | Exophthalmometer / orbit evaluation |
| 37 | `examwriter-screenshot-37.png` | Orbit evaluation detail |
| 38 | `examwriter-screenshot-38.png` | IOP + dilating drops dropdown |
| 39 | `examwriter-screenshot-39.png` | Gonioscopy: angle grades (view 1) |
| 40 | `examwriter-screenshot-40.png` | Gonioscopy: Shaffer grades (view 2) |
| 41 | `examwriter-screenshot-41.png` | Gonioscopy: TM pigment (view 3) |
| 42 | `examwriter-screenshot-42.png` | Gonioscopy: Van Herick (view 4) |
| 43 | `examwriter-screenshot-43.png` | Skin inspection |
| 44 | `examwriter-screenshot-44.png` | Vital signs |
| 45 | `examwriter-screenshot-45.png` | Drawing: External Eyes |
| 46 | `examwriter-screenshot-46.png` | Drawing: Slit Lamp |
| 47 | `examwriter-screenshot-47.png` | Drawing: Fundus (+ dx-required warning) |
| 48 | `examwriter-screenshot-48.png` | Drawing: Cross Section |
| 49 | `examwriter-screenshot-49.png` | Drawing: Gonioscopy |
| 50 | `examwriter-screenshot-50.png` | Drawing: Head (4 views) |
| 51 | `examwriter-screenshot-51.png` | Drawing: Lateral Left |
| 52 | `examwriter-screenshot-52.png` | Drawing: Normalized Fundus |
| 53 | `examwriter-screenshot-53.png` | Drawing: Sensorimotor Exam |
| 54 | `examwriter-screenshot-54-dx.png` | Diagnosis: main panel + ICD-10 Expert |
| 55 | `examwriter-screenshot-55-dx.png` | Dx: tear film osmolarity Details |
| 56 | `examwriter-screenshot-56-dx.png` | Dx: tear film osmolarity Diagnosis |
| 57 | `examwriter-screenshot-57-dx.png` | Dx: tear film osmolarity Assessment dropdowns |
| 58 | `examwriter-screenshot-58-dx.png` | Dx: KCS treatment plan checkboxes |
| 59 | `examwriter-screenshot-59-dx.png` | Dx: punctal occlusion Details |
| 60 | `examwriter-screenshot-60-dx.png` | Dx: punctal occlusion Billing |
| 61 | `examwriter-screenshot-61-dx.png` | Dx: punctal occlusion Consent |
| 62 | `examwriter-screenshot-62-dx.png` | E-prescribing: Select Prescription |
| 63 | `examwriter-screenshot-63-dx.png` | Diagnosis panel (fundus view) |
| 64 | `examwriter-screenshot-64-dx.png` | Dx: disc photos Details |
| 65 | `examwriter-screenshot-65-dx.png` | Dx: disc photos Diagnosis dropdown |
| 66 | `examwriter-screenshot-66-dx.png` | Dx: disc photos full diagnosis list |
| 67 | `examwriter-screenshot-67-dx.png` | Dx: disc photos Assessment/Plan |
| 68 | `examwriter-screenshot-68-dx.png` | Dx: gonioscopy Details |
| 69 | `examwriter-screenshot-69-dx.png` | Dx: VF test type selection + billing |
| 70 | `examwriter-screenshot-70-dx.png` | Dx: VF findings checkboxes |
| 71 | `examwriter-screenshot-71-dx.png` | Dx: VF findings (duplicate of 70) |
| 72 | `examwriter-screenshot-72-dx.png` | Dx: automated perimetry Assessment/Plan |
| 73 | `examwriter-screenshot-73-dx.png` | Dx: OCT Details (RNFL thickness) |
| 74 | `examwriter-screenshot-74-dx.png` | Dx: OCT Diagnosis checkboxes |
| 75 | `examwriter-screenshot-75-dx.png` | Dx: OCT optic nerve Diagnosis |
| 76 | `examwriter-screenshot-76-dx.png` | Dx: OCT Assessment (progression tracking) |
| 77 | `examwriter-screenshot-77-dx.png` | Dx: OCT Billing (medical necessity) |
| 78 | `examwriter-screenshot-78-dx.png` | Rx search: glaucoma medications |
| 79 | `examwriter-screenshot-79-dx.png` | Full diagnosis list (diabetic patient) |
| 80 | `examwriter-screenshot-80-dx.png` | DR sub-diagnoses expanded |
| 81 | `examwriter-screenshot-81-dx.png` | DR ICD-10 hierarchy (sub-types) |

### Eyefinity Encompass PM (26 files) — `.playwright-mcp/page-*.png`

| Time | File | Shows |
|------|------|-------|
| 21:05:40 | `page-2026-03-30T21-05-40-145Z.png` | Dashboard: Message Center tiles |
| 21:05:51 | `page-2026-03-30T21-05-51-074Z.png` | Schedule: week view (empty/closed) |
| 21:06:41 | `page-2026-03-30T21-06-41-897Z.png` | Schedule: day view with appointments |
| 21:07:20 | `page-2026-03-30T21-07-20-065Z.png` | Schedule: patient quick-view hover |
| 21:08:55 | `page-2026-03-30T21-08-55-429Z.png` | Resource schedule setup |
| 21:09:07 | `page-2026-03-30T21-09-07-013Z.png` | Resource schedule template editor |
| 21:09:29 | `page-2026-03-30T21-09-29-815Z.png` | Resource schedule (alternate view) |
| 21:10:17 | `page-2026-03-30T21-10-17-127Z.png` | Patient search (empty state) |
| 21:10:33 | `page-2026-03-30T21-10-33-322Z.png` | Order management: invoiced orders |
| 21:12:37 | `page-2026-03-30T21-12-37-613Z.png` | Patient search (with results) |
| 21:12:49 | `page-2026-03-30T21-12-49-560Z.png` | Demographics: contact info (top) |
| 21:13:33 | `page-2026-03-30T21-13-33-339Z.png` | Demographics: personal info (bottom) |
| 21:14:15 | `page-2026-03-30T21-14-15-303Z.png` | Demographics: communication prefs |
| 21:15:40 | `page-2026-03-30T21-15-40-666Z.png` | Inventory: stock orders |
| 21:16:27 | `page-2026-03-30T21-16-27-910Z.png` | Inventory: frame lookup |
| 21:16:40 | `page-2026-03-30T21-16-40-322Z.png` | Inventory: adjustments |
| 21:16:52 | `page-2026-03-30T21-16-52-698Z.png` | Inventory: physical count |
| 21:17:57 | `page-2026-03-30T21-17-57-775Z.png` | Claim search (CMS-1500 field refs) |
| 21:18:17 | `page-2026-03-30T21-18-17-879Z.png` | EDI transmission queue |
| 21:19:09 | `page-2026-03-30T21-19-09-046Z.png` | Reports: 7 report categories |
| 21:21:48 | `page-2026-03-30T21-21-48-654Z.png` | Admin: setup dashboard |
| 21:22:15 | `page-2026-03-30T21-22-15-147Z.png` | Admin: provider setup |
| 21:22:28 | `page-2026-03-30T21-22-28-134Z.png` | Admin: edit provider (NPI, DEA) |
| 21:23:36 | `page-2026-03-30T21-23-36-569Z.png` | Admin: staff setup |
| 21:25:34 | `page-2026-03-30T21-25-34-183Z.png` | Admin: service/exam setup (CPT) |
| 21:35:14 | `page-2026-03-30T21-35-14-646Z.png` | EHR: note history with filters |

### Visit Overview (1 file)

| File | Shows |
|------|-------|
| `visit-overview-full.png` | Complete visit summary — demographics, VA chart, refraction, Rx, clinical findings, diagnosis, plan, billing |
