# ExamWriter (Eyefinity EHR) — Complete Layout Reference

Reverse-engineered via Playwright browser automation on 2026-03-30 from live IVA ExamWriter instance.
This document captures the full UI structure, field-level detail, and clinical workflow patterns for OSOD development reference.

**Version:** 7.13.4 | **Practice:** Integrated Vision Optical | **URL:** integratedvision.eyefinityehr.com

---

## System Architecture

### Two-App Structure
1. **Eyefinity Encompass** (PM side) — pm.eyefinity.com — Practice management, scheduling, billing
2. **ExamWriter** (EHR side) — integratedvision.eyefinityehr.com — Medical records, exam documentation

### Global Header (all EHR pages)
- Patient Search (combobox, top-left)
- User: Eric R Bang | Help | Feedback | Reset Password | Preferences | Logout

---

## Main Navigation (11 Tabs)

| # | Tab | Badge | URL Pattern | Purpose |
|---|-----|-------|-------------|---------|
| 1 | Home | — | /dashboard | Note History — today's visits, filter/search |
| 2 | OfficeFlow | — | /office-flow | Room management — patient flow tracking |
| 3 | Tasks | 12 | /tasks | Received/Sent/All Tasks — clinical task queue |
| 4 | Patients | — | /patient/list | Patient search — 30,769 patients |
| 5 | Rx | 55 | /RxOverview.action | Prescriptions, ePA, Refill Requests, Rx Changes |
| 6 | Mail | 9 | /mail/intramail/inbox | Intramail + Direct Mail |
| 7 | Document Mgmt | — | /document-management | Attachments, Referrals, Faxes, Consents |
| 8 | Orders | 1 | /order-log | Order tracking |
| 9 | Path / Labs | — | /biopsy-log | Path + Lab results (4 sub-views each) |
| 10 | Radiology / Other | — | /result-log | Imaging results |
| 11 | Reminders | — | /reminders | Patient recall/reminders |

---

## Home (Note History)

**Toolbar:** Regulatory Reporting, General Reminder, CSV, EM Benchmark

**Quick filters:** My Preliminary Today (1), All Preliminary Assigned to Me (0), My Finalized Today (14), All My Preliminary (16)

**Filters:** Patient, Type, Encounter Type, Scribe, Date, Method, Note Status, Include Visit Code, Author, Facility, Assigned To, AI Output

**Actions:** Finalize Selected, Assign Notes, Billing Summaries, Download Notes, Review and Finalize, Print Table

**Table:** Checkbox | Date | Note Author | Patient Name | Type | Note | Bill | Status | Action | OfficeFlow | Assigned To | Facility

---

## Tasks

**Sub-tabs:** Received | Sent | All Tasks
**Toolbar:** Filters, Manage Quick Tasks, Create New Task
**Table:** Patient Name | Task | Details | Priority | Due Date | Created On | Assigned To | Sender | Status | Last Updated

---

## Patients

**Toolbar:** Advanced Search, Patient Handout Library, Quick List
**Search:** Search By (Name default), Patient Status (Active/Inactive)
**Table:** Last Name | First Name | Preferred Name | MRN | PMS ID | DOB | Phone | Email | Status | Last Visit

---

## Rx

**Dropdown:** Rx Overview, Add Rx, ePA, Refill Request, Denied Refill With New Rx, Rx Change Requests, Rx Audit Confirmation
**Sub-tabs:** Rx (21) | ePA | Refill Req. (30) | Refill Denied w/ New Rx | Rx Change Requests (4) | Rx Audit Confirmation
**Filters:** Provider, Status (Pending/Printed/eRx/Voided/Canceled), Patient, Written Date From/To, Visit, eRx, DOB, Controlled Substance
**Table:** Checkbox | Patient | Drug | Written On | Last update | Written By | Status | Additional detail | ePA Status | Actions

---

## Mail

**Two sections:**
- **Intramail** — Inbox | Drafts | Sent | Archived | Settings
- **Direct Mail** — Inbox | Sent | Archived | Patient Authorizations | Directory Opt-In

**Toolbar:** New Message, Archive, Mark Read/Unread, Flag/Unflag
**Filters:** From, Date, Flagged, Priority, Patient, Read, Subject
**Table:** Checkbox | Priority/Read icon | Received On | From | Subject | Attachment | Flag

---

## Document Mgmt

**Sections:**
- **Attachments:** Upload New, Associate With Patient
- **Specialties and Referrals:** Manage Referral Contacts, Manage Physician Specialties
- **Faxes:** Pending Approval, Pending Authorization, Sent, Received, Archived
- **Consents:** Add New, Manage

---

## Orders

**Toolbar:** Filters, Refresh View, Select Action
**Table:** Checkbox | Order Date | Patient Name | Order Number | Order Name | Provider | Facility | Perform At | Due Date | Scheduled Date | Workflow Status | Order Status

---

## Path / Labs

**Sections:** Path | Lab (each with: Pending Results, Pending Plan Completion, Completed, Unresolved)
**Filters:** Provider, Patient, Facility (Preferred/All), Entry Date, Results Processed Date
**Table:** Date | Patient | Facility | Ddx | Procedure | Location | Results | Results Processed | Photos

---

## Radiology / Other

**Toolbar:** Filters, Select Columns, Select Action
**Table:** Checkbox | Received Date | Visit Date | Patient Name | Result Name | Result Status | Workflow Status | Portal

---

## Reminders

**Filters:** Status, Patient, Reminder Type, Provider, Start/End Date
**Table:** Checkbox | Remind On | Patient | Doctor's Note | Reminder | Type | Preferred Contact Method | Notified On | Action

---

## Patient Chart Overview

### Patient Header (persistent across all views)
- Photo, Name (linked), PCP, REF
- DOB, Email, Phone, Birth Sex, MRN, PMS ID, Patient Portal status
- Alerts, Allergies
- Actions: Call Buttons, Create Task, Select Room, Enable Kiosk

### Clinical Summary (collapsible)
- GP, Dilation date, Target IOP, T-Max, Level 4 date
- Visit history table: Date | VA | IOP | Diagnostic | Procedure | Provider | Visit

### Sticky Note
- Persistent per-patient note (e.g., "Pt plays guitar")

### Patient Chart Sub-tabs (16 tabs)
Overview | Chart Notes (14) | Tasks | Orders Log (0) | Path/Labs (0) | Radiology/Other | Clinical Trends | Cancer Log (0) | Patient Data | Eye History | Rx Plans | Rx History | Attachments | Visit Summaries | Global Period | Release of Information

### Patient Toolbar (17 buttons)
Patient Clipboard, Create New Visit, New Non-Visit Order, Edit Patient Data, Eye Log, Image Management, Patient Rx, New Note, Manage Attachments, Create Consents, PDF Manager, Send Intramail, Send DirectMail, Glasses and Contacts, View Current Drug Warnings, Create Auto Letter, Face Sheet, Print Attachments

### Overview Content
- **Patient Clipboard** — full medical/ocular history, meds, allergies, family history
- **Active Optical Rx** — historical Rx with Sphere/Cyl/Axis/Add/VA tables
- **Upcoming Appointments** table
- **Patient Activity** — visit history with Dx summaries

---

## Visit Note Overview (Pretest Landing Page)

**Breadcrumb:** Patients > [Name] > Visit Note (date) - Preliminary

### Visit Info
- Bill as: Established/New Patient
- Facility, Transition of Care, Attendees, Additional Visit Notes

### Right Column Sections
1. **CC/HPI | ROS** — Add CC/HPI or ROS, Additional HPI Comments
2. **Vision Summary** — Mark Pupils/Motility/VF Normal, Add Tests
3. **Exam** — Simple Eye Exam, Perform Exam
4. **Impressions and Plans** — Diagnoses/Special Plans radio, Dx search, Plans search, Findings
5. **Data Reviewed**
6. **Patient Eye Charts** — tabs: Visual Acuity Dcc | IOP | Central Retinal Thickness | RNFL Thickness | Keratometry | Pachymetry
7. **Vitals** — Manage link
8. **Rx** — Refill, Send ePrescription
9. **Tests and Results** — table
10. **Attachments**
11. **Clinical Notes**

### Left Column
- Patient Clipboard (collapsible)
- Active Optical Rx
- Billing (procedure codes, charges, total due)
- Automated Quality Measures
- Eye Code Calculation (92002/92004/92012/92014 justification table)

---

## CC/HPI/ROS (History Section)

### Exam Navigation Buttons
Visit Note | Vision Exam | Ocular Exam

### Left Sidebar (14 sections)
1. **Chief Complaint / HPI** — Follow Up CC table (35 prior Dx) + Add New CC/Secondary/Historical/Independent Historian
2. **Past Medical History** — Past Medical Conditions (34 checkboxes + SNOMED) | Past Surgeries (40+ checkboxes) | Pediatric History
3. **Ocular History** — Ocular History (30+ checkboxes, checked: Dry eyes, Glaucoma R/L) | Ocular Surgical History (40+ checkboxes)
4. **Medications** — Ophthalmic + Non-ophthalmic
5. **Allergies**
6. **Social History**
7. **SDOH Care Planning**
8. **Quality Measures**
9. **Implantable Devices**
10. **Review of Systems**
11. **Family History**
12. **Problem List**
13. **Procedures And Plans**
14. **Immunizations**

### Pattern
- All sections: checkbox lists with SNOMED codes
- Search-to-add for items not in default list
- Notes fields expand when checked
- Save and Continue / Save / Cancel

---

## Vision Exam (Pretesting) — 20 Tabs

### Toolbar
Visit Note, Ocular Exam, Eye Log, Image Management, **Mark Pupils Motility and Visual Fields Normal** (one-click normal), Add Cover Ortho, Equipment Interface, Print Final G&CL Rx's

### Tab Details

#### 1. Wearing (WRx)
**Sub-tabs:** Glasses | Contact Lenses | Specialty Contact Lenses
- Recorded On, Time, Binocular PD Dist/Near, Usage
- **Refractions grid:** OD/OS — Sphere | Cylinder | Axis | Add | Dist VA | Near VA
- **Quick buttons:** Copy OD to OS, 20/20 OU, J1+ OU, Refraction History, Clear VA, Clear All
- **Prisms/PDs (expandable):** HPrism | Base | VPrism | Base | Slab Off | VD | Mono PD Dist | Mono PD Near | Other
- **Eyeglass Details:** Type dropdown + checkboxes (AR Coating, Hi-Index, Polarized, Polycarbonate, Scratch Coating, Slab Off, Sunglasses, Transition, UV Coating)
- **Additional Visual Acuity** | **Notes** sub-tabs

#### 2. Auto Refraction (ARx)
- Same grid as WRx + Auto Refraction Type dropdown + Reading Distance

#### 3. Keratometry
- **Method:** Auto (dropdown)
- **Table per eye:** Flat | Flat Axis | Steep | Steep Axis | Mires Quality | Recorded On
- Notes field

#### 4. Visual Acuity (Va)* — REQUIRED
- **Distance section** (expandable): Corrected + Uncorrected
  - Test Type (Snellen Chart default), Correction Type
  - Per row (DccOD/DccOS/DccOU, DscOD/DscOS/DscOU): VA | PH Value | Glare | BAT | PAM | RAM | Other
- **Near section** (expandable): Corrected + Uncorrected
  - Near Test Type, Near Correction Type
  - Same per-row pattern (NccOD/etc.)
- **Infant Vision - CSM Method** (expandable)

#### 5. Refractions (MRx/CRx)
- Refraction Type* dropdown + "Create Final Rx" option
- Same Sphere/Cyl/Axis/Add/VA grid + Prisms/PDs
- Binocular PD, Reading Distance, Eyeglass Usage

#### 6. Soft Contact Lenses
- **Per eye (OD/OS):** Manufacturer/Product search, BC, Diameter, Sphere, Cyl, Axis, Add, Color/MF PWR, VA fields
- Start/Expiration dates
- **Over Refraction** (expandable): Sphere/Cyl/Axis/VA per eye
- **Sub-tabs:** Details | Assessment and CL Regimen | Notes
- Last Manifest Refraction auto-displayed

#### 7. Specialty Contact Lens
- Usage/Status dropdowns
- **Sub-tabs:** Lens Fitting | Assessment and CL Regimen | Notes
- **Per eye:** Manual Entry, Underlying Condition, Product, Manufacturer, Lens Type (auto), Base Curve, Diameter, Sphere, Cylinder, Axis, Add
- **Last Keratometry** auto-displayed (Flat/Flat Axis/Steep/Steep Axis)
- Copy OD to OS, Refraction History, Additional Fields, Clear

#### 8. Binocular
**Sub-sections (anchor links):** Binocular | Cover-Uncover | Phorias | AC/A Ratio | Near Point | Vergence | Cross-Cylinder | Relative Accommodations | Fusion/Stereopsis

- **Eye Dominance** dropdown
- **Cover Uncover:** Near/Distance — Finding (Ortho/Esotropia/Intermittent Esotropia/Esophoria/Exotropia/Intermittent Exotropia/Exophoria) + Laterality (Right/Left/Alternating) + Magnitude
- **Phorias:** Distance + Near — Test Method (Coincidence/Maddox Rod/Polarized Cross/Polarized Cross w/Fix./Schober/Von Graefe/Optec 2000), Horiz, Measurement, Deviation, Vertical OD/OS (Value + Base Up/Down)
- **AC/A Ratio:** Ratio dropdowns + Other
- **Near Point Convergence:** Test (Push-up w/Light, Push-up w/Accom.), Reliability (Good/Acceptable/Poor/Not Recorded), Blur, Break, Recover
- **Near Point Accommodation:** OD/OS/OU dropdowns
- **PRA:** dropdowns + Add/Acuity
- **Fusion/Stereopsis:** Test Type (Stereo Fly/Random Dot/Randot/Reindeer/Optic 2000), Reliability, Distance, Near
- **Titmus Stereo Test:** Mark All Correct/Clear All — Stereo Fly Wings, Animals Row A/B/C, Circles 1-9

#### 9. Misc Tests
- **Accommodative Facility:** Method (Accommodative Rock Cards/Bernell #9 Vectogram), Results, Rock Power (+/-1.00 to +/-3.00 in 0.50 steps), Reliability, Other
- **MEM Retinoscopy:** Accommodative Lag (5 Very Strong +0.25D → 1 Very Weak +1.25D), Accommodative Excess

#### 10. Pupils* — REQUIRED
- Result dropdown, **Mark As Normal** button
- **OD/OS table:** Light(mm) | Dark(mm) | Near(mm) | Size | Round | Regular | Reacts | APD | RAPD | Other

#### 11. Motility* — REQUIRED
- Result dropdown, **Test Type** (Alignment/Ductions and Versions/Cover-Uncover/Alternate Cover/Light Reflex), Mark As Normal, Recorded By
- **Ductions and Versions:** 9-position gaze X diagram per eye, numeric grading (-6 to +4) per position
- **Cover-Uncover:** Near/Distance grid with tropia/phoria findings
- **Alternate Cover:** Full 9-position gaze grid (Top Right/Center/Left, Tilt Right, Middle Right/Center/Left, Tilt Left, Bottom Right/Left) — paired dropdowns per position

#### 12. Visual Fields* — REQUIRED
- **Test** (sticky: Confrontation VF), **Mark As Normal**, Result dropdown
- **Visual diagram:** OD/OS quadrants (T/N from provider's perspective)
- Additional Notes

#### 13. IOP* — REQUIRED
- OD/OS Measurement fields (combobox)
- **Method** (sticky): Applanation, Goldmann, Tonopen, McKay-Marg, Perkins, Dynamic Contour Tonometer (DCT), Non-contact tonometer (NCT), Icare tonometer, Palpation, Pascal, Pneumotonometer, Other, None
- Reliability, Copy OD to OS, Recorded By, Date/Time

#### 14. Diagnostic Drops
- Radio: "No drops instilled in clinic" / "Drops instilled in clinic"

#### 15-20. Central Retinal Thickness, RNFL Thickness, Pachymetry, Endothelial Counts, Amsler Grid, Color Vision
- OD/OS numeric fields (similar patterns)

---

## Virtual Exam Room (Doctor's Exam Form)

### Toolbar
Back to Visit Overview, Vision Exam, Image Management, Eye Log, EMA Photos, Create Auto Letter, Save and Create Protocol, Protocols

### Four-Column Layout

#### Column 1: Exam
- **Perform Exam** → opens Select Exam Set modal (Eye Exam, Preoperative, Postop, Eye Exam text)
- **Data Reviewed**
- **View/Import Previous**

#### Column 2: Diagnoses
**Pre-built quick-pick buttons** (25 common Dx): Astigmatism, Myopia, Hyperopia, Cataract Nuclear, KCS, Ocular Hypertension, Pseudophakia, Dry Eye Syndrome, Borderline Glaucoma (Low/High Risk), Hypertensive Retinopathy, Type II DM, Controlled Type II DM with Ophthalmic Manifestations, Drusen, MGD, POAG, Low Tension Glaucoma Suspect/Full, Amblyopia Refractive, Dry Macular Degeneration, Presbyopia, Macular Drusen, Subjective visual disturbance, Allergic Conjunctivitis, SPK

**Below:** DDx, Assoc. Dx, New Dx, Status + Find Dx search + More Diagnosis...

#### Column 3: Findings + Glyphs + Special Plans
- **Findings:** Awaiting Next Diagnosis (populates per Dx)
- **Glyphs:** Slit Lamp Drawing, Gonioscopy Drawing, Fundus Drawing, External Drawing
- **Special Plans:** Advance Care Planning, All Tests, Anterior Seg Tests, Comprehensive annual exam, Consultation, Contacts, Data Reviewed, Follow Up, Glaucoma Tests, MIPS, Neuro Tests, Oculoplastics Tests, Paper note, Postop, preOp, Print label, Procedures, Records reviewed, Retina Tests, Return to work/school, Screening Testing, Surgery orders, Surgical notes, Telemedicine

#### Column 4: Plans + Follow Up + MDM
- **Search Plans, Popular Plans, Plans** — all Dx-driven
- **Follow Up:** Yes / No / PRN + Set Follow Up
- **MDM Calculation:** auto-calculates E/M level

### Finalization Bar
- No Rx (disabled), No Fees (disabled), **Finalize Visit** button

---

## Eye Exam Form (Structured Slit Lamp/Fundus)

### Exam Controls
- Focus OD / Focus OS toggles
- Advanced Mode On/Off
- Toggles: slit lamp, discs, fundus, dilated, pt declines dilation, deferred (contraindication)

### Exam Sections (left sidebar — 25+ sections)

| Section | Key Fields | Pattern |
|---------|-----------|---------|
| **External** | Lid checkboxes (blepharospasm, ptosis, dermatitis, dermatochalasis, ectropion, entropion, etc.) + External Drawing Mode | OD/OS checkboxes, pre-filled normal, Edit link, Copy to OS/OD |
| **Conj** | Conjunctiva (bleb, chemosis, conjunctivitis, discharge, GPC, injection, melanosis, staining, pterygium, etc.) | Same pattern |
| **K (Cornea)** | TBUT, ABD, band keratopathy, abrasion, arcus, edema, foreign body, infiltrate, NV, staining, Descemet's folds, dry eye, DMEK, DSAEK, guttata, LASIK, KP, etc. | Most detailed section |
| **AC/Iris** | AC: cell/flare, depth, Van Herick, hyphema, hypopyon. Iris: atrophy, NV, PAS, PS, TID, melanocytosis, heterochromia, iris color, dilated pupil size | Two sub-sections |
| **Lens** | LOCS III grading (NO, NC, C, P), nuclear, cortical, PSC, pseudophakia (ACIOL/PCIOL), PCO, aphakia | Cataract classification |
| **Discs** | **C/D Ratio** (0.05 steps), vertical C/D optional, SVP, Superior/Inferior Rim/Disc Ratio, Vertical Disc Diameter (mm), Lens Used | Structured numeric + checkboxes |
| **Fundus** | **Vitreous:** PVD, hemorrhage, syneresis, vitritis. **Vessels:** A/V ratio, NV, tortuous. **Macula:** drusen (5 sizes), ARMD (dry/wet), ERM, DME, CNV, geographic atrophy. **Periphery:** lattice, tears, holes, detachment, CHRPE | Three sub-sections |
| **Defer** | Dilation refusal documentation (medicolegal) | Checkboxes |
| **CN** | Cranial nerves I-XII organized by nerve, laterality (left/right/bilateral) | Neuro exam |
| **Fat Prolapse** | Orbital fat assessment | Simple |
| **Face** | Facial assessment | Simple |
| **Eyelid** | **Oculoplastics measurements:** Palpebral Fissure Width, MRD1, MRD2, Pseudo MRD, Levator Excursion, Upper Eyelid Crease, Lagophthalmos, Bell's Reflex, Hering's, Eyelid Fatigue, Orbicularis Strength (/4), Blink Function, Scleral Show (sup/inf), Pretarsal Show, Anterior Distraction, Eyelid Laxity, Lamellar Shortening, Floppy Eyelid | All dropdowns in mm |
| **Orbit** | **Exophthalmometer:** Base separation, Forward Position (mm). Orbit Evaluation: Resistance to retropulsion, Displacement | Hertel measurements |
| **Nasal** | Nasal exam | Simple |
| **IOP** | **Recheck IOP:** Method (Goldmann), OD/OS recheck + second recheck. **Dilation Drops:** type checkboxes (cyclopentolate, tropicamide, phenylephrine, etc.), consent, time | In-exam IOP |
| **Gonio** | **4-quadrant angles** (S/N/I/T): landmark grading (SL/ATM/PTM/SS/CB). Iris Insertion (A-D, **missing E**). Angular Approach (degrees). Peripheral Iris. **TM Pigmentation** (0-4+). Van Herick (fractions). Drawing Mode | Structured angle assessment |
| **Misc** | Catch-all | Variable |
| **Skin** | "inspection of skin and subcutaneous tissue" — one checkbox + text | Minimal |
| **Oral, Neck, Lungs** | General medical observation | Simple checkboxes |
| **Vitals** | BP, pulse, respiration, temp, O2 sat, height, weight — all free text | No validation |
| **CV, GI, Lymph** | Systems review | Simple |
| **Exam Notes** | Free text | — |

### Drawing Tabs (11 canvases)
1. **External Eyes** — 4 eye photos (OD/OS normal + retracted)
2. **Slit Lamp** — OD/OS anterior segment circles + Corneal Cross Section
3. **Fundus** — OD/OS retinal diagrams (clock-hour labeled) + Optic Disc grids
4. **Cross Section** — OD/OS full globe anatomical illustration + Iris anterior view
5. **Gonio** — OD/OS 4-quadrant angle diagrams
6. **Head** — 6-view 3D head model
7. **Face** — Frontal face diagram
8. **Lateral - Left** — Left profile with anatomical hotspot regions
9. **Lateral - Right** — Right profile
10. **N. Fundus** — Neonatal fundus with ROP Zone I/II/III
11. **Sensorimotor Exam** — 9-position gaze grids (Distance w/o glasses, w/ glasses, Near), OD/OS ductions/versions X diagrams, method/preference/head posture

### Progress Note (right panel, live-updating)
- HPI Comments, Patient Clipboard, Safety flags, Vitals, ROS, Exam Comments, Impression/Plan Comments

---

## Diagnosis-Driven Workflow

When a Dx is selected from the quick-pick buttons, the system populates:
1. **Findings** — pre-built finding buttons specific to that Dx
2. **Popular Plans** — common plans for that Dx
3. **Plans** — full plan list
4. **ICD-10 Expert** — prompts for laterality/specificity

### Per-Plan Modal (5 tabs)
Each plan/test opens a modal with:
- **Details** — Same-day order, Detail Level, Location, Method/Device, Reliability, Medical Necessity
- **Findings** — Per-eye results (checkboxes + numeric fields)
- **Diagnosis** — DDx checkboxes per eye
- **Assessment and Plan** — Assessment dropdown (none/baseline/stable/improved/initial/worsened/uncertain) + Future plans checkboxes with editable sticky templates
- **Billing** — Professional/Technical component, primary study selection

### Dx-Specific Examples Captured

#### Cataract, Nuclear
- Findings: trace/1+/2+/3+/4+ nuclear sclerosis, brunescent/yellow discoloration
- Plans: Refraction, F/U Cataract, Counseling-Cataracts, Referral

#### Keratoconjunctivitis Sicca (Dry Eye)
- **Tear Film Osmolarity:** Device (Tear Lab/Other), osmolarity values OD/OS (mOsms/L), severity (normal/mild/moderate/severe)
- **Temporary Punctal Occlusion:** Per-punctum tabs (RUL/RLL/LUL/LLL), Company (FCI Ophthalmics), Method (0.4mm collagen plug), Serial/Lot Number, Dilator, Duration, Complications, Consent, Post-care
- Plans: Prescription (Miebo, Restasis, Xiidra, Lotemax, pred acetate, FML), OTC Regimen, Inflammadry, Punctal Occlusion, Counseling, Lipiflow, iLux, Lid repair, Modify environment
- DDx: MGD, Sjogren's, filamentary keratitis, blepharitis, etc.

#### Ocular Hypertension / Glaucoma
- Findings: Asymmetric IOP, Asymmetric C/D, borderline IOP, Family history, large C/D, Low Hysteresis
- **Disc Photos:** ON findings (normal, atrophy, cupping, hemorrhage, etc.), progression assessment
- **Automated Perimetry:** VF test types (24-2/10-2/30-2 SITA variants, Octopus), Lids Taped, Results (scotoma types, field loss patterns, progression)
- **OCT Optic Nerve:** Machine (Optovue), Signal Strength, **RNFL Thickness by sector** (Superior/Inferior/Temporal/Nasal in microns), Findings (8-sector NFL + NRR loss)
- **Gonioscopy:** Angle landmarks, Medical Necessity
- Plans: F/U Glaucoma, Disc Photos, Gonioscopy, VF, Pachymetry, OCT ON, Hysteresis, Counseling, Prescription, Referral
- Rx: pilocarpine, dorzolamide, timolol, Combigan, brimonidine, Azopt, Alphagan P, Lumigan, latanoprost, Betoptic S, Travatan Z, Istalol, acetazolamide
- Treatment escalation: Observation → Continue Meds → Change/Add Meds → Laser Trabeculoplasty → Trabeculectomy → Consultation

#### Controlled Type II DM with Ophthalmic Manifestations
- **ICD-10 specificity:** DR severity per eye (mild/moderate/severe NPDR, proliferative +/- macular edema, +/- traction, stable proliferative) + Macular Edema status per eye
- Findings: diabetic dermopathy, dot blot hemorrhages, hard exudates, IRMA's, NV disc/iris/retina
- Plans: Fundus Photos, OCT Retinal, ERG, Counseling-DM II, Referral, Care coordination

#### ERG (Electroretinography)
- Amplitude 24/16 OD/OS/Difference
- Latency 24/16 msec OD/OS
- P50 Reliability Index 24/16 OD/OS
- Normal Amplitudes reference

---

## Key Patterns for OSOD

### What ExamWriter Does Well
1. **Pre-filled normals with Edit** — one-click normal exam, edit only abnormals
2. **Copy OD to OS** — reduces duplicate entry
3. **Sticky values** — Method/Device/Provider persist across visits
4. **Diagnosis-driven workflow** — selecting a Dx populates relevant findings/plans
5. **Follow Up CC** — pull forward prior diagnoses to new visit
6. **Mark Pupils/Motility/VF Normal** — one-click toolbar button
7. **Quick-pick Dx buttons** — customizable common diagnoses
8. **ICD-10 specificity enforcement** — laterality, severity prompts
9. **Drug interaction warnings** — per Rx with warning counts
10. **Billing integration** — Eye Code calculation, MDM auto-calculation

### Where ExamWriter Falls Short (OSOD Opportunities)
1. **Everything is checkboxes** — no structured numeric fields for TBUT, Schirmer, axial length, ortho-K parameters
2. **No specialty workflows** — VT evaluations, dry eye protocols, myopia management are checkboxes or free text
3. **Laterality duplication** — every item listed twice (R eye, L eye) instead of OD/OS toggle
4. **No progression tracking** — assessment is dropdown text, not linked to prior numeric data
5. **No protocol chains** — treatment escalation is just checkbox lists, not guided workflows
6. **Skin section is one checkbox** — no aesthetics capability whatsoever
7. **Gonioscopy missing Grade E** (Extremely deep) in iris insertion
8. **Vitals are free text** — no validation, no auto-BMI
9. **No lens parameter catalog** — CL fields are free text, no validation against actual lens designs
10. **OCT data is text fields** — should be numeric with normative database comparison and trend graphs
11. **VF findings are checkboxes** — no integration with actual VF printout data (MD, PSD, VFI, GHT)
12. **No device integration visible** — Data Network section was empty
13. **No AI-assisted documentation** — AI Output filter exists but no visible AI features in exam
