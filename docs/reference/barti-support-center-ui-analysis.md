# Barti EHR/PMS — Competitive UI Analysis

**Date:** 2026-03-30
**Source:** Firecrawl crawl of support.barti.com help center (30 pages, Dec 2023 - Sep 2024 updates)
**Purpose:** Competitive intelligence for OSOD — document Barti's UI structure, feature set, workflows, and integration points

---

## Company Overview

Barti is a cloud-based EHR/Practice Management/Patient Engagement platform targeting optometry practices. They also offer Revenue Cycle Management (RCM) and Marketing as services. The platform launched around late 2023 and has been shipping monthly feature updates since.

**Help Center Categories:**
- General
- Barti Products (EHR / Practice Management / Patient Engagement)
- Barti Services (Revenue Cycle Management / Marketing)
- Onboarding

**Business Model:** SaaS + managed services (RCM, marketing). Users are created by Barti support staff (not self-service). This indicates a high-touch onboarding model.

**Notable:** Walmart optometry mentioned (users with @wal-mart.com emails have email restrictions) — indicates they serve both independent and corporate-affiliated O.D.s.

---

## 1. GLOBAL NAVIGATION & HOMEPAGE

### Main Layout (3-zone)
1. **Left sidebar:** Main menu (collapsible via "<<" arrows)
   - Menu items with red notification badges for pending actions
   - Appointments > Requests (online appointment pending review)
   - Patients > Forms (intake form completed, needs review)
2. **Top bar:** Universal search (persistent across all pages)
   - Search by: First Name, Last Name, DOB (mm/dd/yyyy), Phone, MRN
3. **Top right:** User profile / settings
   - Account profile
   - Onboarding Portal (file upload for Barti team)
   - Account settings

### Homepage Dashboard
- **Day at a Glance:** Today's schedule with patient status
  - Filter: "Everyone" or "Only Me" (doctor filter)
- **Status Update:** Inline status changes from homepage
- **Active Exams:** Open/incomplete exams listed in right column; click to resume
- **Quick Actions (added Sep 2024):** Create new appointments, text messages, exams, optical orders directly from homepage

### Main Menu Items (inferred from navigation references)
- Appointments (Calendar, Schedule, Requests, Availability)
- Patients (Search, Forms)
- Exams
- Communication (Messages, Scheduled, Templates)
- Billing (Invoices, Claims, Inventory, Reports)
- Settings/Profile

**Screenshot:** `https://support.barti.com/hc/article_attachments/26294813365011` (Homepage Overview)
**Screenshot:** `https://support.barti.com/hc/article_attachments/24590680862611` (Navigating Homepage - numbered sections)

---

## 2. CALENDAR & SCHEDULING

### Calendar Views
| View | Description |
|------|-------------|
| **Week** | Default view, Sunday-Saturday |
| **Day** | All appointments for one day with type, staff, status |
| **Month** | Birds-eye view of all appointments |
| **Staff** | Columns per provider — side-by-side schedules |

### Calendar Features
- **Location filter:** Multi-location support
- **Appointment type colors:** Each type has its own color, filterable
- **Staff filter:** Filter by any staff member (all selected by default)
- **Show canceled:** Checkbox to show/hide canceled appointments (hidden by default)
- **Shaded availability sections:** Staff view shows availability as shaded regions (added May 2024)
- **Customize staff visibility:** Control which staff/ODs appear for booking on internal calendar (Apr 2024)

### Appointment Creation (3 entry points)
1. From patient profile → "New Appointment" button
2. From calendar → "New Appointment" button
3. From calendar → Click empty time slot

### Appointment Modal Fields
1. Patient search (or create new patient inline)
2. Appointment type (auto-sets default duration)
3. Status (dropdown)
4. Staff/Doctor assignment (must be correct for online availability)
5. Location (multi-location)
6. Date and time
7. Duration (adjustable)
8. Appointment-specific notes
9. Appointment reminders (add/remove)

### Appointment Modal Info Display (Dec 2023 update)
- Patient age
- Insurance info
- Phone number
- Link to patient chart

### Appointment Statuses
- Unconfirmed
- Confirmed
- Checked in
- In Progress
- Complete
- No show
- Canceled

### Online Appointment Requests
- Dotted-line outline + white background on calendar = pending request
- Red notification badge on Appointments > Requests
- Public booking link available at Appointments > Availability
- Review workflow: Confirm/update type → Confirm/edit date/time → Auto-detect duplicate patient → Compare/merge patient info (side-by-side columns) → Approve (sends confirmation text) or Reject

**Screenshot:** `https://support.barti.com/hc/article_attachments/26297590684563` (Calendar Overview)
**Screenshot:** `https://support.barti.com/hc/article_attachments/26297567681555` (Appointment Modal)
**Screenshot:** `https://support.barti.com/hc/article_attachments/26297567682579` (Schedule List View)
**Screenshot:** `https://support.barti.com/hc/article_attachments/26297590696595` (Request Review)

### Schedule (List View)
- Date range filter (defaults to TODAY)
- Filter by: Status, Appointment Type, Insurance Type, Staff
- Sortable columns: Date, Time, Patient, Phone, Appointment Type, Insurance, Staff, Status
- **Inline status change:** Click status dropdown in row, saves immediately
- **Print Schedule:** Exports current filtered view
- Patient search within schedule view (name, DOB)

### Availability Management
- Per-staff availability editing
- Time slot creation with: start time, duration, appointment types
- **Visibility types:**
  - Internal — staff only, not on public schedule
  - External — public online schedule for patients
  - Internal and External — both
- Consecutive slot creation
- Public Booking Page accessible from Availability page
- Copy Public Booking Link button

### Recurring Blocks (added Jun 2024)
- Event types: Out of Office, Lunch, Block, Break
- Repeat patterns: Daily, Weekly, Every Other Week, Monthly, Yearly
- Edit scope: This Event or All Events
- Not patient-linked (calendar placeholders only)
- Cannot set multiple days per series (need separate block per day)
- Deleting series does NOT affect existing appointments

### User Schedule Management
- Setting: "Allow Internal Appointment Scheduling" checkbox in user profile
- Active = appears in provider dropdown, sees own appointments on homepage
- Inactive = hidden from dropdown, sees all appointments on homepage
- Warning displayed when disabling user with future appointments
- Changes take effect immediately

**Screenshot:** `https://support.barti.com/hc/article_attachments/26297567687315` (Availability Section)
**Screenshot:** `https://support.barti.com/hc/article_attachments/26297590698387` (Time Slots)

---

## 3. ONLINE SCHEDULING (Patient-Facing)

### Patient Booking Flow (6 steps)
1. **Appointment Type Selection** — list with durations shown
2. **Location Selection** — multi-location support
3. **Date, Time, & Staff Selection** — filterable by provider
4. **Patient Information** — First Name, Last Name, DOB, Phone Number (required)
5. **Final Review** — edit capability before submission
6. **Appointment Summary** — confirmation + "hear back soon" message

- Redesigned UI in April 2024 ("New Look for Scheduling Online")
- Public booking link embedded on practice website

**Screenshots:**
- `https://support.barti.com/hc/article_attachments/26358693294099` (Appointment Type Selection)
- `https://support.barti.com/hc/article_attachments/26358693295379` (Location Selection)
- `https://support.barti.com/hc/article_attachments/26358693296531` (Date/Time Selection)
- `https://support.barti.com/hc/article_attachments/26358693297683` (Staff Filter)
- `https://support.barti.com/hc/article_attachments/26358693299731` (Patient Info)
- `https://support.barti.com/hc/article_attachments/26358718163219` (Summary)

---

## 4. PATIENT PROFILE

### Creating a Patient
- **From Patients > Search:** Click "New Patient" button (top right)
  - Minimum fields: First Name, Last Name, DOB
- **From Calendar:** While creating appointment, click "+ Add new Patient" under search bar

### Patient Search
- Search page shows recently viewed patients
- Search by: First Name, Last Name, DOB
- Universal Search bar (also accepts Phone, MRN — added May 2024)
- Duplicate patient detection alert on creation

### Patient Profile Tabs
1. **Personal Info** — Demographics, finalized Rx history, addresses, insurance (Medical + Vision)
   - Insurance: Toggle "Policy Holder" on/off, add subscriber info
2. **Appointments** — Appointment history
3. **Exams** — Completed and incomplete exams (click to view/edit)
4. **Invoices** — Invoice history with filters, export as PDF or CSV
   - Outstanding balance visible (added Feb 2024)
5. **Messages** — Send notifications and texts (requires Communication Platform)
   - Shows scheduled messages indicator ("You have 1 scheduled message")
6. **Files** — Upload files (tests, insurance images, driver's license, previous exam PDFs)
   - File labels + label search
   - Preview PNG, JPG, PDF inline without download (added Aug 2024; not retroactive)
7. **Forms** — All linked intake forms
8. **Notes** — Patient-specific notes (visible only in patient profile)
9. **Claims** — Claims tab added (Apr 2024)

**Screenshot:** `https://support.barti.com/hc/article_attachments/24628310562707` (Patient Profile - Appointments tab)

---

## 5. EXAM / EHR

### Starting an Exam (3 entry points)
1. Patient Chart (profile)
2. Exam section in main menu
3. Appointment Modal

### Exam Template Selection
- Choose template when starting from patient profile or exam section
- Auto-selected from appointment type when starting from appointment modal
- Templates include: Standard exam, Finalized Contact Lens Prescription, Myopia Management/Ortho-K (added Jun 2024)

### Exam Layout (3-column)
| Column | Content |
|--------|---------|
| **Left** | Table of contents — collapsible/expandable sections for navigation |
| **Center** | Main exam fields |
| **Right** | Reference data panel: Patient demographics, Rx History, IOP History, Intake History, Previous Exams, Referral Letters |

### Exam Efficiency Features
- **Mark as Normal:** Button at top of page — marks entire exam with normative values
- **Copy Forward:** Copy data from previous exam
- **Populate With:** Fill refraction values from current or previous exams. Available in:
  - Autorefraction
  - Manifest Refraction
  - Final Glasses Rx
  - Contact Lens Trials and Rx
- **Exam Type in Global Dropdown:** Template types visible in populate dropdown (May 2024)
- **Condensed exam layout** (Mar 2024) — view more at once
- **Responsive Chief Complaint field** (Mar 2024) — adjusts to text volume
- **Addendum support** (Dec 2023) — one addendum per exam
- **Rx History** in right sidebar replaced the appointment history tab (Dec 2023)
- **IOP table** accessible from exam side panel (Mar 2024)
- **Axial Length table** in exam (Apr 2024) — myopia management
- **Multi-select dropdown** in Anterior and Posterior Segment (Apr 2024)
- **Prescription label dropdowns** with free-type fallback
- **Intake Automation** (Aug 2024) — populate ocular/medical/family history from intake form

### Auto-Coding (Aug 2024)
- Exam findings can auto-code a diagnosis (ICD codes)

### Dilation
- Multi-select dilation drops
- Simplified dilation notes (Feb 2024)

### Contact Lens Prescription
- Trial lenses and Rx in exam
- "Finalized Contact Lens Prescription" as separate exam template
- Populate Rx from previous trial
- Rename Rx, mark as Final, add notes
- Cannot print un-finalized CL Rx

### Myopia Management (Jun 2024)
- Ortho-K Lens Module with product-specific fields:
  - Paragon CRT
  - Johnson & Johnson
  - GOV Ortho-K
  - Bausch + Lomb
  - Euclid

### AI Scribe (Apr 2024, expanded Mar 2026)
- Microphone button in exam fields
- Click to start (icon turns red), click to stop, auto-transcription
- Available in: Chief Complaint, Additional Notes, Plans, Procedures, Anterior/Posterior Segment notes, Glasses Rx Notes, Contact Lens Rx Additional Notes
- Transcribed text APPENDED (never replaces existing)
- Must be enabled per organization by Barti Support
- Same subscription covers all fields
- Recommended mic: MXL AC-44 USB
- Error handling: displays error message, retry or manual entry

### Referral Letters
- Generated from finalized exams
- Multiple letter type options (expanded Mar 2024)
- Viewable in exam right panel

### Adding/Removing Exam Components
- Referenced article (not crawled): "Adding and Removing Components from an Active Exam"

---

## 6. COMMUNICATION CENTER

### 2-Way Texting
- Navigate: Communication > Messages
- Filter by: Read/Unread status, Date range
- Patient chat view with:
  - Chat history
  - Custom message composition
  - Preset template selection
  - Emoji support
  - Message scheduling
  - View scheduled messages

### Message Scheduling
- Navigate: Communication > Scheduled
- Date range filter
- Edit or remove scheduled messages via "..." menu
- Create new scheduled message

### Message Templates
- Navigate: Communication > Templates
- Create, edit, remove templates
- Used for quick replies in patient chat

### Automated Messages

**Appointment Confirmation** (on online request approval):
> "Message From [Practice Name]: Your appointment has been confirmed for [Date] at [Time]. We look forward to seeing you."

**Appointment Reminders:**
> "Appointment reminder from [Practice Name]: We look forward to seeing you on [Date] at [Time]! If you need to reschedule or cancel, reply or call our office [Phone]."

- **1-2 days out:** 1-day reminder only
- **3+ days out:** Both 3-day and 1-day reminders
- Reminders sent at same time of day as appointment
- Auto-reset when appointment date or time changes
- Can manually remove (trash icon) and re-add reminders
- Cancelable from Communication > Scheduled OR from Patient Profile > Messages

### Auto-Send Confirmation Texts
- For online appointment bookings (added Feb 2024)

**Screenshots:**
- `https://support.barti.com/hc/article_attachments/26300687816467` (2-Way Texting)
- `https://support.barti.com/hc/article_attachments/26300687816851` (Chat View)
- `https://support.barti.com/hc/article_attachments/26300684894355` (Scheduled Messages)
- `https://support.barti.com/hc/article_attachments/26300687817363` (Templates)

---

## 7. PATIENT INTAKE (Digital Forms)

### Form Structure (7 sections)
1. **Patient Information** — Name, Preferred Name, DOB, SSN last 4, Sex, Gender, Pronouns, Phone, Email, Address, Referral source
2. **Purpose of Visit** — Reason, advance notes
3. **Ocular History** — Glasses (age of current pair), contacts (type, satisfaction), diagnosed conditions, family eye conditions
4. **Medical History** — PCP (name/number), diagnosed conditions, diabetes details (year, type, A1c), surgery/hospitalization, medications, allergies, family conditions
5. **Social History** — Smoking (packs/day, years), alcohol (drinks/week), recreational drugs (type/frequency)
6. **Additional Questions** — Language, ethnicity, race
7. **Finalize/Submit** — Insurance billing consent, digital records consent, privacy policy, date, initials

### Question Types
- Single-line input
- Long text
- Yes/No
- Dropdown
- Multi-select dropdown
- Conditional follow-up questions based on responses

### Intake Workflow
- Customizable per practice (changes via Barti Implementation Team)
- **Sending:** Text intake link to patient before appointment
- **In-office options:** Patient completes on smartphone or tablet; staff completes audibly
- **Linking:** Patients > Forms shows pending notifications → View Form → Link to patient (auto-match by name/DOB or manual search/create)
- **Copy button** in intake form to copy info directly into Patient Profile demographics
- **Printable intake form** available as .docx download
- Cannot print digital form directly; view in exam right sidebar under "Patient Details"

### Viewing Intake
1. Patient Profile > Forms tab
2. Inside Exam > Intake tab (right panel)
3. Patients > Forms (search by patient)

**Screenshots:**
- `https://support.barti.com/hc/article_attachments/49277088172947` (Section 1)
- `https://support.barti.com/hc/article_attachments/26347026957587` (Section 2)
- `https://support.barti.com/hc/article_attachments/26346996381075` (Section 3)
- `https://support.barti.com/hc/article_attachments/26346996381971` (Section 4)
- `https://support.barti.com/hc/article_attachments/26347026958995` (Section 5)
- `https://support.barti.com/hc/article_attachments/26346996383251` (Section 6)
- `https://support.barti.com/hc/article_attachments/26347026959763` (Section 7)

---

## 8. BILLING & INVOICING

### Claims
- CMS 1500 form generation within Barti (Jan 2024)
- Claims tab in Patient Profile (Apr 2024)
- Internal billing specialist available (for EHR or paper chart customers)

### Invoices (Sep 2024)
- Create invoice from exam
- Create invoice from optical order (non-Vision Web)
- Patient Invoice tab shows outstanding balance
- Invoice history with filters, PDF/CSV export

### Clearinghouse Integration
- **Trizetto** integration live (Aug-Sep 2024)
- **Vision Web** integration live (Sep 2024) — optical ordering

### Reports (Sep 2024)
- **Production Report** — practice production metrics
- **Aging Report** — accounts receivable aging

### Inventory Management (Sep 2024)
- Add optical inventory into Barti
- Edit prices
- Add/remove stock
- Track inventory levels

---

## 9. OPTICAL & CONTACT LENS

### Contact Lens Ordering (Jun 2024)
- Order directly from FAIT through Barti EHR
- FAIT account linking required
- Beta program for FAIT users

### Optical Ordering
- Vision Web integration (Sep 2024) for glasses
- Non-Vision Web manual optical order workflow with invoice generation
- "Glasses ordering" was listed as "coming soon" in Jun 2024

### Contact Lens Inventory
- Referenced article (not crawled): "Linking Contact Lens Inventory"

---

## 10. INTEGRATIONS & CONNECTIVITY

| Integration | Type | Status |
|-------------|------|--------|
| **FAIT** | Contact lens ordering | Live (Jun 2024) |
| **Trizetto** | Clearinghouse / claims | Live (Aug-Sep 2024) |
| **Vision Web** | Optical/glasses ordering | Live (Sep 2024) |
| **ePrescribe** | Electronic prescribing | Live (Apr 2024) |
| **VoIP** | Phone system | Live (Sep 2024) |
| **eFax** | Fax service | Live (referenced) |
| **Machine Integration** | Diagnostic devices | Referenced (not crawled) |
| **Google Reviews** | Reputation management | Referenced (not crawled) |

### VoIP Phones (Sep 2024)
- Make and receive calls directly through Barti
- Eliminates need for separate phone system
- Phone number porting available

### eFax
- Built-in fax service

### Machine Integration
- Referenced but not detailed in crawled pages — likely connects to ophthalmic instruments

### AI Features
- **AI Scribe** — voice-to-text exam charting
- **AI Voicemail Summary and Transcription** — referenced but not crawled
- **Auto-Coding** — findings auto-code to diagnosis
- **AI-Enhanced Charting** — broader AI charting assistance (Apr 2024)

---

## 11. USER MANAGEMENT & ROLES

### User Administration
- Users created by Barti support staff (not self-service)
- Unique login: username + email address
- Onboarding Checklist provided
- User Management article exists (not crawled) — handles roles and permissions
- "Allow Internal Appointment Scheduling" toggle per user
- Activate/deactivate users via Barti Support request

### Organization Settings (Jan 2024)
- Organization-level settings page

---

## 12. PATIENT PORTAL
- Referenced but not crawled
- Separate patient-facing portal exists

---

## 13. REPUTATION MANAGEMENT
- Reviews (Reputation Management) — referenced but not crawled
- Google Review setup — referenced but not crawled

---

## 14. AUTOMATED EXAM RECALL
- Referenced but not crawled
- Automated recall messaging system exists

---

## 15. LOOM VIDEO TRAINING LIBRARY

Barti uses Loom extensively for feature documentation. Key training videos:

| Feature | Loom URL |
|---------|----------|
| Message Center | loom.com/share/cd58daf0c2ff427baa423981642ace34 |
| CMS 1500 Generation | loom.com/share/56f17b5c5b5d41faab90d9dd7dd37bfe |
| Appointment Reminders | loom.com/share/fcae6e15c099450cac58fb037a871a5a |
| Referral Letters | loom.com/share/38380c462ead406094d481429fe70af0 |
| ePrescribe | loom.com/share/ae180492cf364d13bc01570537570f38 |
| AI-Enhanced Charting | loom.com/share/dfabb5852f1c48cb8edfe0d66dce05e0 |
| Staff Calendar Customization | loom.com/share/27815c54b22243ed9f2f7c4a3281db74 |
| Setting Availability | loom.com/share/0474f40d357443c898e92db0d14b4b0e |
| Recurring Time Blocks | loom.com/share/3ebd1f7957ab492d9f68a72b5971f6a6 |
| Ortho-K Module | loom.com/share/9e35cfdffbe64528b6681223b34c61af |
| CL Ordering (FAIT) | loom.com/share/73a8fa667a264a08bfdcb160c95f56b1 |
| Intake Automation | loom.com/share/c286adec8b574d4c929fb3f3bedefcf5 |
| Auto-Coding | loom.com/share/647c28fe78004d8b851add8794a00bc9 |
| Invoice from Exam | loom.com/share/9ff55726941e4cff97dbaac2e3cf8509 |
| Invoice from Optical Order | loom.com/share/7e72968b6bfa444486dbd967c367a573 |
| Add Inventory | loom.com/share/1f3b669d23994a2fa6b5b2c0ac414744 |
| Manage Inventory | loom.com/share/0bea9ca37e43418dabf141f0afc8a535 |
| Production Report | loom.com/share/7d0e84b1d66f46bda038a8374a1e9b1e |
| Aging Report | loom.com/share/bb6faa77ad3a4b87855fa11b768ac790 |
| VoIP Phones | loom.com/share/ff6d6803447148e4b5798dfe9889a703 |
| Patient Intake | loom.com/share/5288164b117b4462a1978685939fbd76 |
| Calendar Views | loom.com/share/ffdc84565def4706bb5d55fb0a048358 |
| Updated Homepage | loom.com/share/58be8a1efe5846f394148f7c9c5626d2 |
| Optical Inventory | loom.com/share/1f3b669d23994a2fa6b5b2c0ac414744 |
| Inventory Management | loom.com/share/0bea9ca37e43418dabf141f0afc8a535 |

---

## 16. FEATURE RELEASE TIMELINE

| Date | Feature |
|------|---------|
| Dec 2023 | Updated appointment modal (age, insurance, phone), Staff view columns, Exam addendum, Rx History sidebar, Add patient from calendar, Prescription label dropdowns, New appointment colors |
| Jan 2024 | Message Center (2-way texting), CMS 1500 claims, Organization settings, Appointment request table, Duplicate patient alert, Print schedule with OD name |
| Feb 2024 | Automated appointment reminders, Referral letters, Auto-send confirmation texts, Multi-select dilation, Outstanding balance on invoices, Edit from appointment modal |
| Mar 2024 | Condensed exam layout, Responsive chief complaint, Expanded referral letter types, IOP table in sidebar, ePrescribe + CL ordering announced |
| Apr 2024 | ePrescribe live, AI-enhanced charting, Customize staff on internal calendar, New online scheduling UI, Multi-select Anterior/Posterior, Axial length table, Claims tab in patient profile |
| May 2024 | Staff availability shading on calendar, Exam type in global dropdown, Global search by Name/Phone/DOB/MRN, FAIT beta |
| Jun 2024 | Recurring time blocks, Availability guidance, Ortho-K lens module (Paragon/J&J/GOV/B+L/Euclid), CL ordering from FAIT live, AI Scribe |
| Jul 2024 | Feature recap / "Did you know" campaign |
| Aug 2024 | Trizetto clearinghouse live, Intake automation (populate history), Auto-coding, File preview (PNG/JPG/PDF) |
| Sep 2024 | Updated homepage (quick actions), Optical inventory, Inventory management, Trizetto + Vision Web live, Invoices from exam/optical order, Production report, Aging report, VoIP phones |

---

## 17. ARTICLES NOT CRAWLED (Known to Exist)

These articles are referenced in Related Articles links but were not in the 30-page crawl:

- **Barti Product Overview & Training Videos** (frequently referenced)
- **User Management** — roles and permissions
- **Barti Patient Portal** — patient-facing portal
- **Machine Integration Overview** — diagnostic device connections
- **Enabling VoIP Phones** — phone setup
- **Porting a Phone Number into Barti**
- **Enabling Barti eFax** / **Barti eFax - Getting Started**
- **Automated Exam Recall** — recall messaging
- **Reviews (Reputation Management)**
- **Setup Google Review**
- **Adding your FAIT account to Barti**
- **Linking Contact Lens Inventory**
- **Office responsibility & tips to improve efficiency**
- **AI Voicemail Summary and Transcription**
- **Adding and Removing Components from an Active Exam**
- **Barti RCM Welcome Guide** (promoted article)
- **Scheduling a Manual Recall Message**
- **Barti Scheduling: Adding Additional Appointment Reminders**
- Monthly update articles: Oct 2024 through Mar 2026

---

## 18. COMPETITIVE ANALYSIS NOTES (for OSOD)

### Strengths
- **Modern cloud-first architecture** — web app, no desktop install
- **Rapid shipping cadence** — monthly feature releases, visibly iterating
- **Integrated communication** — 2-way SMS, VoIP, eFax all in-platform
- **AI features early** — AI Scribe, auto-coding, AI voicemail transcription
- **Myopia management specialty** — Ortho-K module with product-specific fields
- **Digital intake with conditional logic** — follow-up questions based on responses
- **Optical supply chain** — FAIT CL ordering + Vision Web glasses ordering
- **Clearinghouse** — Trizetto integration
- **File preview** — inline image/PDF viewing in patient profile
- **Public booking with approval workflow** — smart patient matching on requests

### Weaknesses / Gaps Visible
- **No self-service user management** — users created by Barti support
- **Intake form changes require Barti team** — not configurable by practice
- **Single addendum per exam** (as of Dec 2023)
- **No API access mentioned** — no developer documentation, no webhook/integration endpoints for third parties
- **No mention of:** FHIR, HL7, HIPAA BAA details, data export, patient data portability
- **Limited report types** — only Production and Aging reports documented
- **No optical dispensing workflow detail** — inventory exists but dispensing UX unclear
- **File preview not retroactive** — only new uploads
- **Recurring blocks limited** — one day per series only
- **No keyboard shortcuts** documented anywhere
- **No dark mode** or accessibility features mentioned
- **Template customization locked** — practices cannot self-edit intake forms or exam templates

### Architecture Observations
- Web-based SaaS (URL: app.prod.barti.com)
- Zendesk-hosted help center (support.barti.com)
- Loom for video documentation (20+ videos)
- Pardot/Salesforce marketing (go.barti.com image CDN)
- Young product — launched late 2023, most features added in 2024
- High-touch support model (CSM assigned per account)

### Competitive Positioning vs OSOD
- Barti is the closest modern competitor to what OSOD aims to be — cloud-native EHR built for optometry
- Key OSOD differentiators would be: open source, API-first, self-configurable forms/templates, community-driven
- Barti's closed-form model (changes require support) is exactly the pain point OSOD solves
- No visible API = no third-party integration ecosystem = same lock-in problem as legacy PMS
- Barti's AI features (scribe, auto-coding) set the modern baseline — OSOD needs parity

---

## 19. ALL INTERFACE SCREENSHOTS (Barti CDN)

### Help Center Attachments (support.barti.com/hc/article_attachments/)
```
24527502784787  — Updated appointment modal (Dec 2023)
24527502786579  — Staff view columns (Dec 2023)
24527512833683  — Exam addendum (Dec 2023)
24527512834323  — Rx History sidebar (Dec 2023)
24590680862611  — Homepage navigation numbered
24628310562707  — Patient profile appointments tab
24628310564499  — Schedule view search
25969997026323  — Organization settings
25969997029139  — Appointment requests table
25970017574291  — Duplicate patient alert
25970017576851  — Print schedule with OD name
25970332850451  — Auto-send confirmation texts
25970332858003  — Multi-select dilation
25970332872211  — Outstanding balance on invoices
25970332877587  — Edit appointment from modal
26294813365011  — Homepage overview
26297567681555  — Appointment creation modal
26297567682579  — Schedule list view
26297567687315  — Availability section
26297590684563  — Calendar overview
26297590696595  — Appointment request review
26297590698387  — Availability time slots
26300684894355  — Scheduled messages
26300684895123  — Appointment reminder text
26300687816467  — 2-Way texting overview
26300687816851  — Patient chat view
26300687817363  — Message templates
26300687817491  — Automated messages
26346996381075  — Intake section 3 (ocular)
26346996381971  — Intake section 4 (medical)
26346996383251  — Intake section 6 (additional)
26346996387347  — Linking intake to patient
26346996387859  — Patient profile forms tab
26346996388883  — Exam intake tab
26347026957587  — Intake section 2 (purpose)
26347026958995  — Intake section 5 (social)
26347026959763  — Intake section 7 (finalize)
26347026960275  — Intake notification
26347026961171  — Copy intake to profile
26347026962195  — Intake from exam view
26358693294099  — Online booking: appointment type
26358693295379  — Online booking: location
26358693296531  — Online booking: date/time
26358693297683  — Online booking: staff filter
26358693299731  — Online booking: patient info
26358718143891  — Public booking link location
26358718163219  — Online booking: summary
26358718165907  — Online booking: confirmation
26556952683155  — Delete appointment reminder
26556952684435  — Re-add appointment reminder
26844719950355  — Condensed exam layout
26844719957779  — Responsive chief complaint
26844721789715  — Expanded referral letters
26844721794963  — IOP table in sidebar
28074942878099  — Multi-select Anterior/Posterior
28074942880275  — Axial length table
28074942883475  — Claims tab
28074971743763  — New online scheduling UI
31246778187155  — "Did you know" header
40873201301651  — Subscriber info toggle
40873241105171  — New insurance button
40873241111699  — Policy holder toggle
49277088172947  — Intake section 1 (patient info)
```

### External Image CDN (go.barti.com)
```
go.barti.com/.../app.prod.barti.com_appointments_view_staff...  — Staff view with availability shading
go.barti.com/.../Product_Updates_Gif__720_x_504_px___4_.gif     — Exam type in global dropdown
go.barti.com/.../Product_Updates_Gif__720_x_504_px___2_.png     — Global search bar
go.barti.com/.../Product_Updates___Preview_Files_8.24.gif       — File preview feature
```
