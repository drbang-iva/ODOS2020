# Eyefinity Encompass — Practice Management Reference

Reverse-engineered from 26 Playwright screenshots of Eyefinity Encompass PM (pm.eyefinity.com), the practice management side of Eyefinity's two-app suite. Captured March 30, 2026 from IVA's live account. Version 10.53.3.16.

**Purpose:** Document how the PM/front-desk side works — scheduling, patients, orders, inventory, claims, billing, staff, admin — so OSOD can build from reference.

**Companion doc:** [examwriter.md](examwriter.md) covers the EHR/clinical side (ExamWriter). Together these two docs capture the complete Eyefinity system.

**Screenshots location:** `osod/.playwright-mcp/page-2026-03-30T*.png` (26 files, untracked)

---

## Table of Contents

1. [Two-App Architecture](#two-app-architecture)
2. [Global Navigation](#global-navigation)
3. [Message Center / Dashboard](#message-center--dashboard)
4. [Scheduling](#scheduling)
5. [Patient Search & Demographics](#patient-search--demographics)
6. [Order Management](#order-management)
7. [Product Inventory](#product-inventory)
8. [Claim Management & Billing](#claim-management--billing)
9. [Reporting](#reporting)
10. [Administration](#administration)
11. [Architectural Patterns (OSOD Takeaways)](#architectural-patterns)

---

## Two-App Architecture

Eyefinity runs **two separate applications** sharing a login context:

| App | URL | Purpose |
|-----|-----|---------|
| **Eyefinity Encompass** | pm.eyefinity.com | Practice management — scheduling, billing, claims, admin, inventory, reports |
| **ExamWriter** | integratedvision.eyefinityehr.com | EHR — clinical notes, prescriptions, orders, labs, patient flow |

The "Apps" dropdown in Encompass switches between them. Different UIs, different navigation, different workflows. **OSOD's integrated PM+EHR architecture deliberately rejects this split** (see `decisions/2026-03-30-integrated-pm-ehr-architecture.md`).

---

## Global Navigation

### Top Bar (Dark Navy)
- Eyefinity Encompass logo (left)
- **Apps** dropdown (grid icon) — switches between Encompass PM, ExamWriter EHR, other Eyefinity products
- **User:** "Ebang in 0161582" (dropdown)
- **Logout** (power icon)

### Primary Nav Bar (Medium Blue)
- **Patients** | **Appointments** | **Orders** | **Catalog** | **More**
- **Quick List** (right-aligned) — persistent patient worklist/favorites

### Footer (All Screens)
- **Go to: Front Office | Administration** — module switchers
- Copyright: 2026 Eyefinity, Inc.
- Version: 10.53.3.16

---

## Message Center / Dashboard

The landing page after login. Tile-based navigation to major PM functions.

### Alert Banner
- System announcements (e.g., expanded name field support, scheduled maintenance)

### Navigation Tiles (8 tiles, icon + label)

| Tile | Icon | Function |
|------|------|----------|
| **Search / Add Patient** | Magnifying glass | Patient lookup and creation |
| **Appointment Calendar** | Calendar | Schedule view |
| **Appointment Confirmations** | Checkmark | Confirm upcoming appointments |
| **Order Management** | Clipboard | Optical/CL order tracking |
| **Product Inventory** | Box | Frame/lens/CL inventory |
| **My Reports** | Bar chart | Reporting dashboard |
| **Provider Hub Dashboard** | Person + hub | Provider-specific dashboard |
| **Claim Management** | Dollar sign | Claims and billing |

---

## Scheduling

### Calendar Views

**Week View:**
- Date range display: "Mar 29 - Apr 4, 2026"
- View toggle: **Week** dropdown (also Day, Month implied)
- **Today** button | **< >** navigation arrows
- **Find Open** button — searches for available slots
- **Legend** button — appointment type color key
- **Move** button — reschedule appointments
- **Fullscreen** toggle (top-right corner)

**Grid Layout:**
- **Resource** dropdown: Provider selection (e.g., "Bang, Eric")
- **Office** dropdown: Location selection (e.g., "0161582")
- Columns: Sun through Sat
- Rows: 30-minute time blocks (visible from 5:00 AM through 9:00 PM+)
- Color coding: Light blue = open/available, Red "Closed" text = blocked time

**Day View with Appointments:**
- Color-coded appointment blocks showing:
  - Patient name
  - Appointment type
  - Multiple appointment types visible simultaneously across time slots
- Multi-provider support (provider name shown for each column)
- Patient quick-view on hover: demographics, phone, alerts, next follow-up

### Patient Quick View (Hover Card from Schedule)
When hovering over a patient name on the schedule:
- Patient name (linked)
- Phone number
- Address
- DOB
- Alert text (e.g., "CANCELLATION 10-14: Call. The patient should be recontacted for the following: I.E Monthly, PG bs, eye drops")
- Next follow-up date/instructions

### Resource Schedule Setup

**Appointments: Resource Schedule** page for configuring provider availability:

**Date Range Controls:**
- Description: text field (e.g., "Normal Hours: Week 1")
- **Range Setup** button (blue) | **Reason Setup** button (blue)
- Start Date / End Date fields with calendar pickers
- Resource dropdown (provider/room selection)

**Setup Tabs:**
- **Resource Hours Setup** — define when the resource is available
- **Service Templates Setup** — define what appointment types can be booked

**Schedule Grid:**
- Time blocks in 30-min increments
- Color-coded cells:
  - **Green** = Available
  - **Red/Dark** = Not Available
  - **Gray** = Other Office
  - **Dark Gray** = Office Closed
- "Show 24 hours" checkbox

**Template Management:**
- **Add Template** | **Edit Template** | **Delete Template** buttons

---

## Patient Search & Demographics

### Patient Search

**Search Form Fields:**
- Last Name | First Name | Date of Birth | Phone | ZIP Code | MRN

**Checkbox Filters:**
- "Show Responsible Party" — includes guarantors in results
- "Show Inactive" — includes deactivated patients

**Results Table Columns:**
- Last Name | First Name | Nickname | D.O.B. | Phone | MRN | Address | **Last Exam** (date + exam type)

**Key detail:** The Last Exam column shows BOTH the date AND the exam type (e.g., "02/12/2014 Orthokeratology"). This tracks visit type alongside date.

### Patient Demographics

Full demographics form with multiple sections:

**Contact Information:**
- Patient ID: UUID-style identifier (e.g., "ef1bb545d2e4")
- First Name | Last Name | Suffix (dropdown) | Preferred Name
- Address 1 | Address 2 | City | State | ZIP
- Country (dropdown with flag icon)
- Primary Phone + type selector (Mobile/Home/Work) + additional dropdown

**Personal Information:**
- Active checkbox | Deceased checkbox
- Last Exam: display-only (e.g., "Never")
- MRN: manual entry field (not auto-generated)
- Provider: assigned provider dropdown (e.g., "Dr. Eric Bang")
- Home Office: practice/location dropdown (e.g., "0161582 - Integrated Vision Optical")
- Date of Birth (MU): with auto-calculated age display (e.g., "Age 63")

**Meaningful Use (MU) Compliance Fields:**
- Birth Sex (MU): Male / Female radio buttons
- Race (MU): multi-select dropdown
- Ethnicity (MU): dropdown
- Preferred Language (MU): dropdown
- Referred By (MU): dropdown

**Identity & Employment:**
- SSN: Full / Last 4 toggle with masked input (XXX-XX-XXXX)
- Occupation: dropdown
- Employment Status: dropdown
- Marital Status: dropdown
- Activities: multi-select dropdown

**Clinical Flags (Checkboxes):**
- Signature on insurance file
- Diabetes
- Special Needs

**HIPAA:**
- HIPAA Signature on file: Yes / No radio + "Added on" date field

**Email & Communication:**
- Email field (required) + "Bad Email" checkbox + "Declined to Share" checkbox

**Communication Preferences Matrix (5 categories x 4 channels):**

| Category | Text | Call | Email | Mail |
|----------|------|------|-------|------|
| **Recalls** | yes | yes | yes | no |
| **Appointment** | yes | yes | yes | no |
| **Product Pick Up** | yes | no | no | no |
| **Marketing Promo** | no | no | yes | no |
| **Education** | no | no | no | yes |

"Select All" link for bulk selection.

**Responsible Party:**
- Shows "Self" with "Change" button — supports guarantor/parent/guardian relationships

**Actions:** Reset | Save

---

## Order Management

### Order Tracking

**Screen:** Order Management: Invoiced Orders

**Filter Controls:**
- Radio: **Contact Lens** / **Eyeglass**
- Date filter with calendar picker
- UIN search: "# or Patient's Last Name"

**Lifecycle Tabs:**
- **Receive** | **Notify** | **Deliver** | **Online**

**Order Table Columns:**
- Order Number | Patient | Deliver To | Status
- Expandable detail rows showing: UIN, Type, Category, Item, Price

**Order Details Include:**
- UIN (Unique Identification Number) per item
- Category: Complete, etc.
- Item type: Lens, etc.
- Status codes: e.g., "LINED BI" (lined bifocal)
- Manufacturer/distributor references

---

## Product Inventory

### 8-Tab Inventory System

| Tab | Function |
|-----|----------|
| **Stock** | Stock orders with distributor tracking |
| **Lookup** | Search by UPC code, item number, or name |
| **Adjustments** | Audit trail of inventory corrections |
| **Physical** | Physical count tracking (full/partial, by collection) |
| **Location** | Multi-location inventory management |
| **Reports** | Inventory reporting |
| **Transfer** | Inter-location transfers |
| **Receipt** | Receiving/processing incoming inventory |

### Stock Orders
- Stock Order # | Date | Status | Distributor | Category | Item | Type | MFR PT # | Committed
- Distributors tracked: "Contact Eyewear", "Alignment Inc." etc.

### Lookup (Frame Search)
- **Item Type** dropdown: Frames (also Lenses, Contact Lenses, Accessories)
- **UPC Code** field — barcode scanning support
- **Item #** field
- **Name** search

**Quantity States (4 columns):**
- **On Hand** | **On Order** | **In Transit** | **Committed**

### Adjustments
- Adjustment # | Date | Item Type | Status | Notes | Actions
- Full audit trail: 3,836 historical adjustment records
- "+ Adjustment" button for manual corrections

### Physical Counts
- ID | Date | Type | Count Type | Collection
- Count Types: "Full" (also likely Partial/Cycle)
- **Scoped by collection/brand** — count one brand at a time (e.g., "GENESIS SERIES, ANNE KLEIN COLLECTION, CALVIN KLEIN")
- Annual/semi-annual frequency observed

---

## Claim Management & Billing

### Claim Search

**Navigation:** Claim Management > Claim Search | Billing Claims | Process Payments | More

**Alert Banner:** "You have Failed Claims. View" — proactive failed claim notification

**Search Fields (with CMS-1500 field references):**

| Field | CMS-1500 Ref | Type |
|-------|-------------|------|
| Patient Last Name | (2) | Text |
| Patient First Name | (2) | Text |
| Insured ID or SSN | (1a) | Text |
| Authorization Number | — | Text |
| Claim Number | — | Text |
| Order Number | — | Text |
| Service Date From/To | — | Date pickers |
| Claim Status | — | Dropdown |
| Carrier | — | Dropdown |
| Plan | — | Dropdown |
| Office | — | Dropdown |

"Additional Search Criteria" expandable link for more filters.

**Key pattern:** CMS-1500 field numbers in parentheses next to field labels — billing staff think in claim form field numbers.

### EDI Transmission

**Screen:** Billing Claim: EDI Transmission

**Filters:**
- Carrier | Provider ("--All--") | Service Date From/To | Plan | Office | Patient State

**Key detail:** Patient State filter for state-specific insurance rules.

---

## Reporting

### 7 Report Categories

| Category | Icon | What It Covers |
|----------|------|---------------|
| **Accounting Reports** | $ | Financial summaries, revenue, AR aging |
| **Appointments Reports** | Calendar | Scheduling utilization, no-shows |
| **Marketing Reports** | Megaphone | Campaign effectiveness, referral sources |
| **Patient Reports** | Person | Demographics, retention, growth |
| **Sales Reports** | Chart | Revenue by service, provider, product |
| **Inventory Reports** | Box | Stock levels, turns, valuation |
| **Dispensary Reports** | Glasses | Optical dispensing, frame/lens sales |

"Understand your actual revenue! Learn More" promotional banner for analytics upsell.

---

## Administration

### Admin Setup Dashboard

**6 Main Setup Tabs:**
- **Office Config.** | **Company Mgt.** | **Resources** | **Products & Services** | **Preferences** | **Billing & MVC** | **Patient Engagement**

**Color-coded completion indicators** — green checkmarks track setup progress.

### Setup Areas

**Company Management:**
- Company Information (practice entity)
- Providers (clinical providers)
- Integrations (third-party connections)
- Staff (non-provider staff)

**Products & Services:**
- Frames | Contact Lenses | Services | Eyeglass Lenses | Accessories

**Day-to-Day Operations:**
- Front Office

**Office Resources:**
- Billing & MVC
- Carriers & Plans

### Provider Setup

**Provider Record Fields:**
- Provider ID | License # | Provider Name (Dr., etc.)
- Last Name | First Name | Credentials (e.g., "OD")
- License | SSN | NPI | DEA #
- Address / Practice Address | City | State | ZIP | Phone | Fax
- **"+ License" button** — multiple state licenses supported
- **Status of Office(s)** — multi-location assignment
- **Integration flags:** Eyefinity EHR, Eyefinity Shift, Eyefinity PM
- **Electronic Signature** — capture/display area with E-Signature button
- **VSP Providers** — "+ VSP Providers" button for importing VSP-credentialed providers
- **Taxonomy** — NPI taxonomy code per provider

### Staff Setup

**Staff Table Columns:**
- Last | First | Staff (role type) | Active? | Present | User Name | Modify

**Staff Role Types:** Provider, Optician, Manager, Admin

**Key features:**
- Active/Inactive toggle (deactivate without deleting)
- **"Present" column** — real-time staff presence tracking
- 17 staff members for IVA

### Service Setup

**Service Table Columns:**
- Code (CPT) | Description | Status | Default Price | Modify

**57 total services** configured, including:
- Exam types (comprehensive, specialty)
- Procedures (foreign body removal, I&D meibomian cyst, punctal procedures)
- Dry Eye ExamWriter Imaging
- Each service has a CPT code and default price

---

## Architectural Patterns

### What Encompass Gets Right (Keep for OSOD)

1. **Communication Preferences Matrix** — 5 categories x 4 channels is the right granularity for patient communication preferences
2. **CMS-1500 field references in claim search** — billing staff think in claim form fields, this is great UX
3. **Failed Claims proactive alerting** — surface problems, don't hide them
4. **4-state inventory tracking** (On Hand / On Order / In Transit / Committed) — complete inventory lifecycle
5. **Physical count by collection/brand** — practical for optical where you count one brand at a time
6. **Patient Last Exam shows date + type** — small but important for front desk triage
7. **Resource Schedule Templates** — reusable availability patterns
8. **Provider record completeness** — NPI, DEA, taxonomy, multi-license, e-signature all in one place
9. **Staff presence tracking** — who's actually in the office today
10. **Responsible Party / Guarantor** relationship on demographics

### What Encompass Gets Wrong (Fix for OSOD)

1. **Two separate apps** — PM and EHR are completely disconnected UIs; OSOD integrates them
2. **VSP lock-in** — deep VSP integration everywhere; OSOD is carrier-agnostic
3. **No specialty awareness** — services are generic CPT codes, no specialty workflow modules
4. **No aesthetics support** — product categories are optometry-only (frames, lenses, CLs)
5. **Cloud-only** — no local deployment option
6. **MRN is manual entry** — should be auto-generated with manual override
7. **Report categories but no custom reports** — 7 predefined categories, no report builder visible
8. **Provider setup requires SSN** — legacy billing artifact, should use NPI-only
9. **Dashboard is just tiles** — no at-a-glance metrics, no today's appointments, no revenue snapshot
10. **Inventory is disconnected from clinical** — stock system doesn't know what the doctor just prescribed

### Data Models OSOD Needs (Informed by Encompass)

| Entity | Key Fields |
|--------|-----------|
| **Practice** | Name, address, tax ID, multi-location support |
| **Provider** | Name, credentials, NPI, DEA, taxonomy, license(s), e-signature, multi-site assignment |
| **Staff** | Name, role (Provider/Optician/Manager/Admin), active flag, presence, username |
| **Patient** | UUID-based ID, demographics, MU fields, communication preferences matrix, responsible party, assigned provider, home office |
| **Service** | CPT code, description, status, default price |
| **Carrier** | Insurance carrier entity |
| **Plan** | Insurance plan under carrier |
| **Appointment** | Resource, patient, service, time, status |
| **Schedule Template** | Resource, date range, availability blocks, service templates |
| **Order** | UIN, patient, type (CL/eyeglass), lifecycle (receive/notify/deliver), items |
| **Inventory Item** | UPC, item #, name, type, on hand/on order/in transit/committed |
| **Claim** | Patient, carrier, plan, provider, service dates, status, EDI transmission |
