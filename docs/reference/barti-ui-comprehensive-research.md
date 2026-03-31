# Barti UI Development & Structure — Comprehensive Research

**Date:** 2026-03-31
**Sources:** barti.com (homepage, features, pricing, 5 AI blog posts), support.barti.com (30-page help center crawl), 4 YouTube transcripts (Vision Expo 2026, overview video, podcast ep 26, Depth Perception podcast), Eyes on Eyecare / Glance (2 articles), SoftwareFinder, Reddit r/optometry, Firecrawl screenshots
**Related:** `research/2026-03-26-barti-competitive-research.md` (founding, funding, team), `research/2026-03-30-barti-ehr-competitive-ui-analysis.md` (support center crawl detail), `research/2026-03-30-optometry-ehr-voice-ai-scribe-research.md` (scribe landscape)

---

## EXECUTIVE SUMMARY

Barti is the most modern optometry EHR on the market — cloud-native, React/TypeScript/GCP, ~200 practices, $19.5M raised ($12M Series A Aug 2025 from Five Elms Capital + $7.5M seed including AOAExcel). Founded 2021 (Fractal Software venture studio), co-founders Colton Calandrella (CEO, Bain & Company background) and Dr. Kelly Cai (COO, optometrist). First and only EHR endorsed + invested in by AOAExcel.

**Their pitch:** "Spend more time with patients and less time clicking." One login, one platform for everything — EHR, PM, texting, phones, AI, website, RCM.

**Why this matters for OSOD:** Barti is the primary competitor. They set the modern baseline. But they have the SAME lock-in problem as legacy PMS — no API, no self-configurable forms, user management requires support tickets. They're building a better cage, not opening the door.

---

## 1. PRODUCT ARCHITECTURE & UI STRUCTURE

### Global Navigation (3-Zone Layout)
1. **Left sidebar:** Collapsible main menu with red notification badges
   - Appointments (Calendar, Schedule, Requests, Availability)
   - Patients (Search, Forms)
   - Exams
   - Communication (Messages, Scheduled, Templates)
   - Billing (Invoices, Claims, Inventory, Reports)
   - Settings/Profile
2. **Top bar:** Universal search — Name, DOB, Phone, MRN (persistent across all pages)
3. **Homepage dashboard:** Day-at-a-glance schedule, inline status updates, active exams panel, quick actions (Sep 2024)

### Web App
- URL: `app.prod.barti.com`
- Built on Webflow (marketing site), GCP (app)
- No mobile app
- No desktop install — pure web SaaS

### UI Design Language
- Dark gradient backgrounds (purple-to-dark) on marketing
- Modern SaaS aesthetic — clean cards, SVG icons, gradient overlays
- "Is your cell phone from the early-2000s? Then why is your EHR?" positioning
- They explicitly compare to Apple — "take it out of the box, you already know what to do"

---

## 2. EXAM / EHR — "One Page EHR"

### Layout (3-Column)
| Column | Content |
|--------|---------|
| **Left** | Table of contents — collapsible/expandable sections |
| **Center** | Main exam fields (the charting area) |
| **Right** | Reference panel: Patient demographics, Rx History, IOP History, Intake History, Previous Exams, Referral Letters, AI Guidelines |

### Key Efficiency Features
- **Mark as Normal:** One button marks entire exam with normative values
- **Copy Forward:** Pull data from previous exam
- **Populate With:** Fill refraction values from current or previous exams (Autorefraction, Manifest Refraction, Final Glasses Rx, CL Trials/Rx)
- **"Equal" button:** Copy right eye → left eye with one click
- **Condensed exam layout** (Mar 2024) — see more at once
- **Responsive Chief Complaint** — field adjusts to text volume
- **Auto-Coding** (Aug 2024) — findings auto-generate ICD diagnosis codes
- **Addendum support** — one addendum per exam
- **Intake Automation** (Aug 2024) — populate ocular/medical/family history from intake form

### Specialty Templates
- Standard exam
- Finalized Contact Lens Prescription
- **Myopia Management / Ortho-K** (Jun 2024) with product-specific fields:
  - Paragon CRT, Johnson & Johnson, GOV Ortho-K, Bausch + Lomb, Euclid

### Exam Starting Points (3 entry)
1. Patient Chart (profile)
2. Exam section in main menu
3. Appointment Modal (auto-selects template from appointment type)

### Key Quote from Colton (Vision Expo 2026):
> "It doesn't just generate a blob of text like a lot of AI scribes do. It actually fills out all the structured data, all the drop downs without the doctor having to click anything."

### Reddit Reality Check:
> "Basically a big Google doc with a language AI built in." — r/optometry user (Jan 2025)
> "AI package is rudimentary and limited" — r/optometry user (Jan 2026, 3 upvotes)

---

## 3. AI FEATURES (5 Products — Copilot Tier $1,500/mo)

### 3a. AI Scribe ("Quinn")
**What it does:** Ambient listening during exam. Records doctor-patient conversation, transcribes, summarizes, populates structured EHR fields (dropdowns, CPT codes, diagnosis codes).

**Technical detail (from support center):**
- Microphone button (🎤) in exam fields
- Available in: Chief Complaint, Additional Notes, Plans, Procedures, Anterior/Posterior Segment, Glasses Rx Notes (Mar 2026), Contact Lens Rx Notes (Mar 2026)
- Click to start (icon turns red), click to stop, auto-transcription
- Text APPENDED (never replaces existing content)
- Must be enabled per organization by Barti Support
- Recommended mic: MXL AC-44 USB
- **Multilingual:** Spanish, French, Mandarin → auto-translates to English clinical notes

**Claims:**
- 96%+ accuracy
- 2 hours saved per day per doctor
- 2.5x more detailed charts than manual entry
- Up to 30% more patient visits
- "Code for me" voice command triggers CPT + diagnosis auto-coding

**Loom training videos:**
- AI Scribe chief complaint: `loom.com/share/37874986ad4443a58e0ca171424b96f3`
- Anterior/Posterior: `loom.com/share/2dd1bc964f2344869aae5a219ad359b8`
- Multilingual: `loom.com/share/fd4730e7584341af950cf5e9bd23b53c`

### 3b. AI Receptionist (NEW — Mar 24, 2026)
**What it does:** Voice AI agent answers inbound calls 24/7, schedules appointments end-to-end by reading live Barti calendar availability.

**Key details:**
- NATIVE to Barti (not third-party bolt-on) — uses built-in VoIP system
- Writes appointments as "requests" (staff review before confirm)
- Transfers complex calls to human staff
- HIPAA-compliant call recording + transcripts
- Launched in partnership with Google Cloud Platform

**Claims:**
- 42% of medical office calls missed during business hours
- 85% of missed callers never leave a message
- $375,000 annual revenue leak from missed calls (at $350/exam avg)
- 16% increase in appointment volume
- 25 hours/week staff time reclaimed
- "80% of patients report positive experiences with AI receptionists"

**YouTube demo:** `youtube.com/watch?v=9KfdD7cqLn0`

### 3c. AI Guidelines (Oct 2025)
**What it does:** Side panel within exam — type clinical question, AI searches AOA Clinical Practice Guidelines, returns evidence-based summary with citations.

**How it works:**
1. Type question in AI Guidelines side panel
2. AI scans AOA CPGs
3. Returns summary + direct citations
4. Click references to view full guideline section

**Developed in partnership with AOAExcel and AOA.**

**Loom demo:** `loom.com/share/62cdfed86dde4bf7a664c49773e732ef`

### 3d. AI History (Mar 2025)
**What it does:** Natural language search across up to 10 years of patient charts. "HIPAA-compliant ChatGPT for your charts."

**How it works:** Type a question (e.g., "What was the last prescription?") → AI searches all exams, notes, prescriptions → returns summarized answer.

**Loom demo:** `loom.com/share/4af8e6754b7941c791f480b99c514897`

### 3e. AI Smart Scan (Mar 2025)
**What it does:** Upload photo/scan of driver's license or insurance card → AI extracts name, DOB, insurance provider, policy number → auto-populates into EHR.

**Loom demo:** `loom.com/share/37b6ec38872e45cab23e7cfa4e77bbc5`

---

## 4. PRICING (Updated Mar 2026)

| Tier | Monthly | Annual (per mo) | Key Additions |
|------|---------|-----------------|---------------|
| **Core** | $400/mo | $360/mo | EHR, Calendar, Billing/Claims, Optical, VisionWeb, CL ordering, Payment processing, Patient portal, Expense mgmt |
| **Pro** | $750/mo | $675/mo | + 2-way texting, auto reminders/recalls, online booking, digital intake, email blasts, AI email campaigns, reputation mgmt |
| **Premium** | $950/mo | $855/mo | + VoIP (phones included), eFax, ePrescribe, clearinghouse/claims bundle, website creation + hosting |
| **Copilot** | $1,500/mo | $1,350/mo | + AI Scribe, AI History, AI Smart Scan, AI Guidelines, AI Receptionist, custom website design |

- Additional providers: $400/mo per FTE (>30 OD hours/week)
- RCM: 6% medical, 4% vision
- Free trial / 30-day cancellation period
- Claim: "Go live in 1-2 hours"

**Co-marketing deals:**
- ODs on Finance: $1,500 off data migration + $50 for demo
- AOA partnership: $1,500 Visa gift card for new customers after 3 months live
- Depth Perception podcast: 20% first year discount

---

## 5. CALENDAR & SCHEDULING

### Views: Week (default), Day, Month, Staff (side-by-side providers)
### Features:
- Multi-location support
- Color-coded appointment types
- 7 statuses: Unconfirmed → Confirmed → Checked in → In Progress → Complete → No show → Canceled
- Inline status change from list view
- Filter by: Status, Type, Insurance, Staff
- Recurring blocks (Jun 2024): Out of Office, Lunch, Block, Break
- Schedule list view with print, PDF export

### Online Booking (Patient-Facing, 6-Step)
1. Appointment Type → 2. Location → 3. Date/Time/Staff → 4. Patient Info → 5. Review → 6. Confirmation
- Smart duplicate patient detection
- Requests land as "pending" — staff approves/rejects with side-by-side patient merge

---

## 6. COMMUNICATION CENTER

### 2-Way Texting
- Send/receive texts from patient profile or Communication section
- Message templates + scheduling
- Emoji support
- Filter by Read/Unread, Date range

### Automated Messages
- **Appointment confirmation** on online booking approval
- **Reminders:** 3-day + 1-day (or 1-day only if <3 days out)
- Sent at same time of day as appointment
- Auto-reset when appointment changes

### VoIP Phones (Sep 2024, Premium+)
- Make/receive calls through Barti
- Number porting available
- AI Voicemail Summary + Transcription

### eFax (Premium+)
- Built-in fax service

---

## 7. BILLING, OPTICAL & INTEGRATIONS

### Billing
- CMS 1500 form generation
- Trizetto clearinghouse integration (Aug-Sep 2024)
- Invoice creation from exam or optical order
- PDF/CSV export
- Production Report + Aging Report (Sep 2024)

### Optical & Contact Lens
- VisionWeb integration for glasses ordering
- FAIT integration for CL ordering
- Inventory management with stock levels
- Patient order notifications

### Other Integrations
| Integration | Type |
|-------------|------|
| Trizetto | Clearinghouse/claims |
| VisionWeb | Optical ordering |
| FAIT | CL ordering |
| ePrescribe | Electronic prescriptions |
| Machine Integration | Diagnostic devices (autorefractor, lensometer) |
| Google Reviews | Reputation management |
| Chili Piper | Demo scheduling (sales) |

### What's NOT There (Critical for OSOD)
- **No API** — no developer docs, no webhooks, no third-party integration endpoints
- **No FHIR/HL7** — no interoperability standards
- **No data export** — no mention of patient data portability
- **No self-service user management** — Barti support creates users
- **No self-service form customization** — intake/exam templates require Barti team
- **No keyboard shortcuts** documented
- **No mobile app**
- **No dark mode** or accessibility features

---

## 8. PATIENT INTAKE (Digital Forms)

### 7 Sections:
1. Patient Info (name, DOB, SSN last 4, sex, gender, pronouns, phone, email, address, referral)
2. Purpose of Visit
3. Ocular History (glasses age, contacts, conditions, family)
4. Medical History (PCP, conditions, diabetes details, surgeries, medications, allergies, family)
5. Social History (smoking, alcohol, recreational drugs)
6. Additional (language, ethnicity, race)
7. Finalize (consent, privacy, signature)

### Question Types: Single-line, Long text, Yes/No, Dropdown, Multi-select, Conditional follow-up
### Delivery: Text link to patient, in-office smartphone/tablet, staff-assisted
### Integration: Intake data populates into exam fields (Aug 2024 "Intake Automation")
### Limitation: **Changes require Barti Implementation Team** — not self-configurable

---

## 9. PRODUCT UI SCREENSHOTS (All Known URLs)

### Barti CDN (Product Marketing)
| Feature | Image URL |
|---------|-----------|
| Masthead hero | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/6509447ffe76ccb4fdc40bfb_masthed-graphics.png` |
| Platform composite | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/65ee9681dbef6a26eddceeed_grp-clg-image.png` |
| Exam | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/650a99473924d9fe4b05f287_exam-image.png` |
| VoIP | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/66e13f73323ff456460cc39e_Group%201707480520.png` |
| Messaging | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/650a9908bad54f8793c5f004_messages-image.png` |
| Calendar | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/65e990d3d54f35bc9a76acdb_calendar-new.png` |
| Optical/CL | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/65ee95584a0b7ff56cf0eb65_ocl.png` |
| Billing/Inventory | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/650a996ff11b20f057ca11a2_inventory-image.png` |
| Patient Intake | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/65ee950de2198cc5716284a7_pt.png` |
| AI Scribe | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/67c787ad883a62d207bf6bae_AI%20Scribe%20screenshot.png` |
| AI Receptionist | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/69c2f08ae5d5ec39d3598202_Barti%20AI%20Receptionist.png` |
| AI Guidelines | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/69c2f14b062a91342fec7f29_AI%20Guidelines.png` |
| AI History | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/67c788301725675a1d6b8c89_AI%20History.png` |
| AI Smart Scan | `cdn.prod.website-files.com/62dce88b6aace74cc1c98ab2/67c78830ca8c361a12b06edd_AI%20Smart%20Scan.png` |

### SoftwareFinder Screenshots
- `software-finder-prod.blr1.digitaloceanspaces.com/Barti_1_10fb57bce1.jpg`
- `software-finder-prod.blr1.digitaloceanspaces.com/Barti_2_e5d11f6274.jpg`
- `software-finder-prod.blr1.digitaloceanspaces.com/Barti_3_5500877fdc.jpg`

### Help Center (62 screenshots documented in `2026-03-30-barti-ehr-competitive-ui-analysis.md`)

### Loom Training Videos (24 URLs documented in `2026-03-30-barti-ehr-competitive-ui-analysis.md`)

---

## 10. YOUTUBE VIDEO SUMMARIES

### Video 1: "How Barti Is Using AI to Modernize Eye Care Practices" (Vision Expo 2026)
**Speaker:** Colton Calandrella, CEO
**Key reveals:**
- "First and only AI operating system for the entire practice"
- AI Scribe ("Quinn") demo: doctor speaks prescription, dilation findings, says "code for me" → auto-generates CPT + diagnosis
- AI Receptionist demo: live call recording played — AI books appointment with real-time availability, collects patient info, sends confirmation text
- "10 to 20% more appointments" from AI receptionist
- "One to two hours per day" saved from AI scribe
- "10 other existing AI products" + launching 2 more
- Future: "optician will be able to create an optical order just by talking"
- Dr. Mackey (Hidden Valley Eyecare): "goes home an hour earlier each day"

### Video 2: "Barti Software: EHR and Practice Management Software" (Overview)
**Format:** Narrated product overview
**Key claims:** 100 clicks for routine exam in legacy systems; 4-5 different softwares to run a practice; "boost revenue by more than 10%"; "eliminate 3-5 other softwares"

### Video 3: "Swiping Right on the Perfect EHR" (Depth Perception Podcast)
**Key reveals:**
- Cold-called 150 practices, asked NPS — "results were horrifying"
- 100% customer retention claim ("never lost a customer")
- "10 times easier to use" claim
- "1-2 hours to get fully started" including data migration
- Free trial available
- Future: AI assistant (phone agent) — "never misses a call, works 24/7"
- Mentioned carbon Health seeing 30% more patients after AI scribe
- 5 user personas designed for: front desk, technician, OD, optician, biller
- EHR selection compared to "wine tasting" — subjective
- 30+ ODs helped design and build from scratch

### Video 4: "Barti EHR Revolutionizing Eye Care Technology" (Reframing iCare Podcast)
**Key reveals:**
- "In over 30 states"
- "Built all functionality in under 3 years"
- "Only EMR in industry to have AI built directly into the platform"
- AI scribe records + transcribes + summarizes → puts directly into chart
- "Over 95% accurate"
- Future: AI assistant to answer phones — "sound just like your staff members"
- Dr. Maria Sampalis as advocate
- Serves corporate sublease doctors (Walmart mentioned in support center)

---

## 11. CUSTOMER TESTIMONIALS & REVIEWS

### Named Customers:
- **Dr. Maria Sampalis** (Sampalis Eye Care) — "so easy to use, texting right from Barti"
- **Dr. Amber Wiggins** (Peek-a-Boo Optometry for Kids) — "cornerstone during cold start launch"
- **Dr. Kiranjeet Sran** (Lumos Eyecare) — "central hub for entire practice — clinical, admin, texting, calling, website"
- **Dr. Mackey** (Hidden Valley Eyecare) — "goes home an hour earlier each day"
- **Shirle Kelly** (Central Arkansas LASIK, 500+ employees) — "exceptional customer service"

### SoftwareFinder: 4.8/5 (14 reviews, 100% positive)
**Pros:** AI populates exam notes accurately, calendar prevents double bookings, ordering tracks inventory, user-friendly, staff picks it up quickly
**Cons:** Calendar requires initial rule tweaks, messaging limits channel variety, customizing forms not as easy as expected

### Reddit Sentiment (Mixed):
- Positive: "Having used both Barti and Rev, Barti is still quite new but very easy to use. Still prefer it over Rev" (6 upvotes)
- Switching: "We're looking into switching to Barti from Eyefinity"
- Skeptical: "Basically a big Google doc with a language AI built in" (NellChan)
- Critical: "AI package is rudimentary and limited" (3 upvotes, Jan 2026)
- Neutral: "Revolution EHR tends to be a community favorite"

---

## 12. FEATURE RELEASE TIMELINE (Dec 2023 — Mar 2026)

| Date | Milestone |
|------|-----------|
| Late 2023 | Product launch — basic EHR, calendar, patient profiles |
| Dec 2023 | Updated appointment modal, staff view, exam addendum, Rx History sidebar |
| Jan 2024 | 2-way texting, CMS 1500 claims, organization settings |
| Feb 2024 | Automated reminders, referral letters, outstanding balance |
| Mar 2024 | Condensed exam, IOP table, ePrescribe announced |
| Apr 2024 | ePrescribe live, AI-enhanced charting, new online scheduling UI |
| Jun 2024 | Recurring blocks, Ortho-K module, FAIT CL ordering, AI Scribe |
| Aug 2024 | Trizetto clearinghouse, intake automation, auto-coding |
| Sep 2024 | Quick actions, optical inventory, VisionWeb, invoicing, reports, VoIP |
| Nov 2024 | AOAExcel endorsement + investment |
| Mar 2025 | AI Scribe blog, AI History blog, AI Smart Scan blog |
| Aug 2025 | $12M Series A (Five Elms Capital) |
| Oct 2025 | AI Guidelines (AOA CPG integration) |
| Mar 2026 | AI Scribe expanded to Glasses Rx + CL Rx notes, AI Receptionist launched |

**Shipping cadence:** Monthly feature releases since launch. They're moving fast.

---

## 13. OSOD vs BARTI — STRATEGIC ASSESSMENT

### Where Barti Wins (Today):
1. **Shipping product** — 200+ practices live, real revenue, real feedback loop
2. **AI suite** — 5 AI products, real-world usage for 2 years
3. **AOAExcel endorsement** — massive credibility in optometry
4. **All-in-one** — EHR + PM + texting + phones + website + RCM
5. **Onboarding speed** — "go live in 1-2 hours" claim
6. **Customer retention** — 100% retention claim (never lost a customer)

### Where OSOD Wins (Architecturally):
1. **Open API** — Barti's #1 weakness per Reddit. Zero third-party integration ecosystem.
2. **Self-configurable** — Barti requires support tickets for form changes, user creation, template edits. OSOD solves this.
3. **Local-first AI** — Barti is cloud-only ($250-400K lifetime cost). OSOD's local AI model is a fundamental cost advantage.
4. **Data ownership** — Your office, your hardware vs. Barti's GCP servers.
5. **Multi-specialty** — Optometry + aesthetics + any clinical vertical. Barti is eye-care only.
6. **Community-driven** — 30 advisory ODs vs. potentially hundreds of contributors.
7. **Pricing transparency** — Barti's pricing is clear but expensive. Open source is free.

### Critical Observation:
Barti is building a better cage. Modern materials, nicer view, but still a cage. No API, no data portability, no self-service customization, no interoperability standards. Their "one platform" pitch is the same lock-in story dressed in modern clothes.

Colton's own words (Vision Expo 2026): "Our goal is to automate 80%+ of routine admin work through our tools, including AI agents." — Note: "our tools." Not yours. Not open. Not extensible.

---

## 14. OPEN RESEARCH ITEMS

- [ ] Mine 24 Loom training videos for detailed UI workflow screenshots
- [ ] Crawl 17 uncrawled support center articles (Patient Portal, User Management, Machine Integration, Automated Recall, etc.)
- [ ] Monitor Barti Ashby job board for new roles (signals priorities)
- [ ] Check if Barti adds ophthalmology support (Eyes on Eyecare confirmed expansion plans)
- [ ] Track AI Receptionist adoption and Reddit feedback
- [ ] Research Barti's FAIT integration depth vs. direct lab ordering
- [ ] Check for ONC certification filings
- [ ] Monitor monthly product update articles (Oct 2024 — present)
