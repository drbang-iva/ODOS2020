---
title: "AestheticsPro — Complete UI/UX Wireframe & Architecture Reference"
date: 2026-04-02
type: research
source: live-app-mining + KB-files + training-transcripts
dual-purpose:
  - iva-aesthetics (staff training — how AP works)
  - osod (build reference — what aesthetics module needs to replicate/improve)
---

# AestheticsPro — Complete UI/UX Wireframe

**What this is:** Full structural documentation of AestheticsPro's interface — every screen, every field, every workflow — mined from the live IVA instance, 15 KB reference files, and 31 training transcripts.

**IVA instance:** SC - Greenwood location. Staff: J. Davis (JD), H. Mosley (HM). Logged in as EB (Eric Bang).

---

## 1. Global Layout

### Shell Structure

```
┌──────────────────────────────────────────────────────────┐
│ [AP Logo] [Location Selector ▼] [Nav Tabs...] [🔔] [EB] │  ← Top Bar
├──────────────────────────────────────────────────────────┤
│                                                          │
│                    Content Area                           │
│                                                          │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ [◄] [►] [🔍] [+Client] [$Invoice] [+Appt] [💬] [⏳] [+] [↻] [?] [AI] │  ← Quick Toolbar
└──────────────────────────────────────────────────────────┘
```

### Top Bar
- **AP Logo** — top left, links to login notification
- **Location Selector** — dropdown, currently "SC - Greenwood"
- **Nav Tabs** — Administration | Calendars | Marketing | Staffing | Clients | Reports | Support
- **Notifications Bell** — Client Portal messages, declined payments, declined memberships, support tickets, announcements, new leads, low inventory, AP Texting
- **User Initials (EB)** — Submit Support Ticket, Preferences & App Settings, Print Page, Log Out

### Quick Toolbar (Bottom, Always Visible)
| Position | Icon | Action |
|----------|------|--------|
| 1 | ◄ | Navigate Back |
| 2 | ► | Navigate Forward |
| 3 | 🔍 | Quick Search (name, DOB, email, phone, client ID, invoice #) |
| 4 | +👤 | Add Client (slideout) |
| 5 | 💲 | Create Invoice (find client → build invoice) |
| 6 | +📅 | Create Appointment (opens calendar with slideout) |
| 7 | 💬 | Communication Center / AP Texting |
| 8 | ⏳ | View Waitlist |
| 9 | + | New Tab |
| 10 | ↻ | Reload (hold 10s for hard reload) |
| 11 | ? | Help Center — page-specific help, FAQs, training videos |
| 12 | 🤖 | AskKai (AI assistant) |

**OSOD note:** The persistent bottom toolbar with contextual quick actions is a strong UX pattern. OSOD should adopt similar — persistent access to search, add patient, create appointment, create invoice regardless of current page.

---

## 2. Navigation Map

### Administration (30 sub-pages)

**Log Files:**
- Application Access
- Appointment Deletion
- Client Merges
- Inventory Log
- Invoice Deletion

**App Configuration:**
- Book Now Settings
- Client Portal Configuration
- Communication Configuration
- E-Record Administration (sub-tabs: Forms Pending Approval, Incomplete Forms, Configuration, Access Log, Record Creator)
- eGift Card Store Settings
- Integration Configuration
- Invoice Settings
- Memberships
- Rewards & Referrals
- Settings & Configuration (sub-tabs: Location Settings, Select Theme, Invoice Settings)
- System Users (tabs: Active Users, Groups & Perm)

**Resource Configuration:**
- Equipment
- Products (tabs: Product List, Product Type List, Inventory Log, Global Settings)
- Resource Mapping
- Room Calendars
- Services (tabs: Service List, Service Type List, Global Settings)
- Staff Members

**Miscellaneous:**
- Company Announcements
- Credit Card Transactions
- Email Template Creation
- Follow Ups
- Gift Card Transactions
- My Account
- My Reminders
- SMS Text Report

### Calendars
Direct view — Staff, Room, Equipment calendars with Day/Week/Month views.

### Marketing
- AP Marketing Solutions (Templates, E-Blasts, SMS-Blasts, Touchpoints, Drip Campaigns, Reports)
- Client/Lead Demographics
- CRM Email List
- Landing Page & Reviews
- Lead API Integration (+ Website Form Creator)
- Campaign Management (Campaign List, Campaign Type List)
- Lead Management

### Staffing
- My Time Card
- Payroll Admin
- Staff Scheduling
- Time Clock

### Clients
- Appt Requests / CP Messaging
- Client List (A-Z filter, columns: Name/ID, Email, Location, Type, Info)
- Client Types
- ER Kiosk Administration
- Merge Clients
- AP Texting

### Reports (40+ reports)

**Clients:** Client Bank Balances, Client Follow Ups, Client Balances

**Staff Management:** Staff Commissions, Staff Performance, Staff Tips, Upsale Report

**Appointments:** Appointment Confirmation, Appointments Booked, Appointments Report, Appointments Sold, Daily Appointments, Monthly Cancellations, Monthly No Sales, Monthly No Shows, No Sale/Cancellation Reasons, Treatments

**Revenue:** Cash/Sales Breakdown, Daily Reconciliation, Daily/Monthly Ledgers, Deferred Revenue, Discount Report, Financing Fees Dashboard, Invoice Line Item Report, Memberships, Profit & Loss, Sales Column Breakdown, Sales Consults Breakdown, Sales Location Ranking, Tax Breakdown, Tax Ledger, Uncollected Payments

**Miscellaneous:** Call Center Leads, Campaign Reports, Consultation Conversion, Dashboard, Integration Events Report, Invoice Due Dates, Price List (PDF), Product Inventory, Quote Report, Review Report, Rewards Points, Services Remaining, Summary Report, Treatment Payment Plan

### Support
- Training Support Videos (dropdown filters + search — THIS is where the ? help videos live)
- Getting Started (step-by-step setup walkthrough)
- What's New (feature releases)
- AP Maintenance Schedule
- Ask The Support Team (ticketing)
- Support Tickets
- Topaz Software downloads

---

## 3. Calendar / Dashboard (Default Landing)

### Layout
```
┌─────────────────────────────────────────────────────────┐
│ [◄ ►] [Date: Thu, Apr 02, 2026] [📅] [🔍] [+] [D W M ☰] │
├────────┬────────────────────────────────────────────────┤
│ Time   │  JD (J. Davis)    │  HM (H. Mosley)          │
│ slots  │  [color column]   │  [color column]           │
├────────┼────────────────────────────────────────────────┤
│ 09:00  │                   │                           │
│ 09:30  │                   │                           │
│ 10:00  │                   │                           │
│ ...    │                   │                           │
│ 12:00  │ ██ Blocked Time   │ ██ Blocked Time           │
│ 12:30  │ (lunch)           │ (lunch)                   │
│ 01:00  │                   │                           │
└────────┴────────────────────────────────────────────────┘
```

### Calendar Controls (Top Right)
| Icon | Function |
|------|----------|
| List | Daily Appointment List slideout |
| Printer | Print PDF |
| Rotating Arrows | Refresh |
| Mini Calendar | Date picker |
| Magnifying Glass | Find Next Available |
| + | Add Appointment |
| D/W/M | Day/Week/Month toggle |
| ☰ | Full menu + Legacy View toggle |

### Appointment Block Icons
| Icon | Meaning |
|------|---------|
| Gold Star ⭐ | First appointment ever |
| Red Flag 🚩 | Outstanding balance |
| Green Flag | Consultation |
| Yellow Flag | Follow-up |
| Blue Circular Arrow | Recurring |
| Notepad | Notes attached |
| $ | Invoiced |
| Gray ✓ | Checked out, no purchase |
| Yellow □ | Unconfirmed |
| Green □ | Confirmed |
| Blue □ | Arrived |
| Gray □ | Left message |
| 📷 | Telehealth |

### Appointment Actions (Click Block)
Magnifying Glass (client details) | Edit | Delete | Cancel | No Show | No Sale | Copy | Upsale | Checkout

### Confirmation Status Flow
Unconfirmed (yellow) → Confirmed (green) | Left Message (gray) | Cancelled (removed) | Arrived (blue)

**OSOD comparison:** AP's appointment block icons are dense but effective. OSOD's color system (gray/orange/green/yellow/red for exam progress) + these status indicators need to coexist. The "first visit" star and "outstanding balance" flag are must-haves.

---

## 4. Client Record

### Access
- Clients > Client List > click name
- Quick Search (toolbar) > click result
- Calendar > click appointment > magnifying glass

### Layout
```
┌──────────────────────────────────────────────────────────┐
│ [Client & Appt Details] [Purchase History] [Electronic Records] [E-Prescriptions] │
├──────────────────────────────────────────────────────────┤
│ [Photo] [Edit]                                           │
│ Client Name (ID: ###)                                    │
│ 📱 (864) 323-5709  ✉️ email@domain.com                   │
├──────────────────────────────────────────────────────────┤
│ LEFT PANEL: Client Info          │ RIGHT PANEL: Activity  │
│ Status: Active                   │ [Appointments tab]     │
│ Gender:                          │ [Client Notes tab]     │
│ Pronouns:                        │ [AP Texting tab]       │
│ Birthdate:                       │                        │
│ Marital Status: Single           │ Appt table:            │
│ Ethnicity: Unknown               │ ID | Date | Time |     │
│ Campaign ID: 1 (Default)         │ Status | Invoice |     │
│ Referred By:                     │ Resource               │
│ Do Not Disturb: Not Checked      │                        │
│ Entered By: Jayden Davis         │ 2996 | 04/14 | 10:00  │
│ Location: Greenwood              │ ACTIVE                 │
│ Misc:                            │                        │
│ Assigned/Preferred Staff: None   │ 1674 | 03/17 | 10:00  │
│                                  │ ACTIVE                 │
└──────────────────────────────────┴────────────────────────┘
```

### Client Fields (from live app)
| Field | Values |
|-------|--------|
| Status | Active / Inactive |
| Gender | Configurable identities (Admin > Client Config) |
| Pronouns | Free text |
| Birthdate | Date |
| Marital Status | Single, Married, etc. |
| Ethnicity | Unknown, configurable |
| Campaign ID | Links to Marketing > Campaign Management |
| Referred By | Lookup |
| Do Not Disturb | Checked / Not Checked |
| Entered By | System user who created |
| Location | Practice location |
| Misc | Free text |
| Assigned/Preferred Staff | Dropdown |
| Client Type | Dropdown (from Clients > Client Types) — shows icon on calendar |

### Tab: Purchase History
Sub-tabs: **Invoices & Payments** | Products Purchased | Services Purchased & Used | Quoted Invoices | Payment Plans | Follow Up Suggestions

**Invoices table:** Purchase Date, Created By, Invoice #, Total, Balance
**Payments table:** Payment Date, Paid By, Invoice #, Amount, Payment Type

### Tab: Electronic Records
- Form Type View vs. eRecord Folder View (chronological)
- Create New Record → select forms (Intake, Consent, Treatment Instructions, Treatment Records, Miscellaneous)
- Photo Gallery with compare, upload, share-to-portal
- Documents upload (PDF/Doc, 4MB max)
- AP Focus mobile app for guided photography (ghosting overlays)
- Draw utility for injection mapping
- Signature fields with auto date stamp

### Tab: E-Prescriptions
- Integrated e-prescribing (details not documented yet in KB)

**OSOD comparison:** AP's client record is tabbed (Details, Purchase History, E-Records, E-Rx). OSOD architecture uses the spine card stack for clinical, but the client management side maps well to this tabbed structure. Key difference: OSOD stores decision chains (WHY), AP stores flat records (WHAT).

---

## 5. Services Configuration

### Layout
```
┌──────────────────────────────────────────────────────────┐
│ [Service List] [Service Type List] [Global Settings]      │
│ [+ Add Service] [🔍 Search]                               │
├──────────────────────────────────────────────────────────┤
│ Service Name          │ Price    │ Service Type    │ Pkg │ SP │ Status │
│ Alma Opus Body        │ $600.00  │ Alma Opus       │     │    │ ACTIVE │
│ Alma Opus Face        │ $800.00  │ Alma Opus       │     │    │ ACTIVE │
│ Diamond Hydroglow     │ $199.00  │ Facial          │     │    │ ACTIVE │
│ RF Microneedling Face │ $250.00  │ RF Microneedling│     │    │ ACTIVE │
│ ...                                                                    │
└──────────────────────────────────────────────────────────┘
```

### IVA Service Types (from live app — 2 pages, ~60 services)
| Service Type | Example Services | Price Range |
|-------------|-----------------|-------------|
| Alma Opus | Body, Face, Focus, Neck, Calibri | $400-800 |
| Add-On | Benev Exosomes, Diamond Polish, Jelly Mask, L.E.D., Microcurrent, Radio Frequency, Rejuvenating Eye Mask | $5-150 |
| Facial | Diamond Hydroglow, EnergEyes, IVA Signature, L.E.D. HydroGlow, Hydroglow Mini | $75-699 |
| Chemical Peel | Gel Peel GL, Micropeel 15, Radiance Micropeel | $60-95 |
| Lumenis PhotoRejuvenation | PhotoFabulous (Face, Neck, Hands, Arms, Legs, Spot) | $175-1,440 |
| PhotoFractional Rejuvenation | PhotoFractional Facial, Face/Neck | $750-850 |
| RF Microneedling | Microderma (Face, Neck, Decolletage, Abdomen, Arms, Glutes, Spot) | $175-600 |
| ResurFX | ResurFX | $325 |
| Microchanneling | Signature Microchanneling Collection | $199 |
| Dermaplane | Velvet Glow Dermaplane | $49-95 |
| MicroBlepharo Exfoliation | MicroBlepharo Exfoliation | $99 |
| Equinox LLLT | Equinox LLLT Dry Eye Rejuvenation | $125 |
| Optilight Dry Eye Combo | Optilight Combo Dry Eye Treatment | $375 |
| Waxing | Eyebrow, Lip, Chin, Full Facial, Under Arm | $5-30 |

### Service Fields (per service)
- Service Name, Price, Service Type, Duration, Virtual toggle, Package flag, Status (Active/Inactive)
- Service Class Pricing (multi-location: different prices per location class A-F)

**OSOD note:** Services are the core of aesthetics scheduling. Each service has a type, price, duration, and can be marked as virtual. OSOD needs: service catalog, service types (categories), body-area associations (for the Tesla configurator pattern), and package/bundle support.

---

## 6. Products / Inventory

### Layout
```
┌──────────────────────────────────────────────────────────┐
│ [Product List] [Product Type List] [Inventory Log] [Global Settings] │
│ [+ Add Product] [🔍 Search]                               │
├──────────────────────────────────────────────────────────┤
│ Product Name     │ Price   │ QTY │ Type          │ SKU     │ Tax │ Status │
│ C E Ferulic      │ $182.00 │ 1   │ SkinCeuticals │ Prevent │     │ ACTIVE │
│ CBD+ balancing   │ $16.00  │ 7   │ Alma CBD+     │         │     │ ACTIVE │
│ ...                                                                       │
└──────────────────────────────────────────────────────────┘
```

### IVA Product Lines (from live app)
| Product Type | Examples | Count | Price Range |
|-------------|---------|-------|-------------|
| SkinCeuticals | C E Ferulic, Phloretin CF, Discoloration Defense, A.G.E Advanced Eye | ~40+ | $25-195 |
| Alma CBD+ | Balancing Cleanser, Barrier Restoring Cream, Skin Brightening Serum, Kits | ~10 | $16-283 |

### Product Fields
- Product Name, Price, QTY (in stock), Type (brand/category), SKU, Taxable, Status, Comp Cost, Warning (low inventory trigger)

### Inventory Management
- Inventory Log tracks all stock changes
- Product Inventory Report: update stock directly from report (In Stock + Warning fields editable)
- Warning level triggers notification bell alert

**OSOD note:** Product inventory is simpler than eyecare (no lens parameters, no frame data). But the concepts transfer: product catalog, categories, stock tracking, low-stock alerts, SKU/barcode support. OSOD needs unified inventory across eyecare (frames, lenses, CLs) + aesthetics (skincare, consumables, injectables).

---

## 7. Memberships

### Types
1. **Standard** — recurring billing, one service banked per cycle
2. **Dynamic (Token-based)** — pays for a "token," redeemed at checkout for actual services at $0
3. **Beauty Bank** — adds FUNDS (not services) to client's virtual bank each cycle

### Membership Lifecycle
Create template (Admin > Memberships) → Assign to client (requires card on file) → Set interval (days/months) → Auto-billing runs → Services/funds banked → Client uses at appointments

### Key Fields
- Membership name, services per cycle, discounts, interval type (days/months), start date
- Client bank balance visible at Client Details > Cards & Balances
- Reports > Revenue > Memberships for management overview

**OSOD note:** Memberships are critical for aesthetics practices. OSOD needs: membership templates, recurring billing engine, service bank tracking, Beauty Bank (prepaid balance), token-based flexible memberships. This is Phase 5 but the data model needs to accommodate it from Phase 1.

---

## 8. Invoicing / Checkout

### Flow
1. Click Checkout on appointment block (or Create Invoice from toolbar)
2. Invoice slideout opens with services from appointment
3. Add products, adjust quantities, apply discounts
4. Review Summary (totals, taxes, tips)
5. Create Invoice → proceed to Payments
6. Payment via: EMV card reader, manual card entry, cash, Client Bank, gift card, rewards points
7. Multi-appointment checkout: same client, same day, checkmark which appointments

### Invoice Features
- Sold By field (tracks which staff member gets credit — critical for commissions)
- QTY Used Today (marks services as consumed)
- Quotes (save as quote instead of invoice, converts later)
- Treatment Payment Plans (autopay for treatment series)
- Invoice deletion log (audit trail)
- Voiding vs. deleting (same day = delete, after = void)

**OSOD note:** Checkout flow is similar to eyecare but simpler (no insurance billing, no vision plans). However, the membership/Beauty Bank/rewards integration makes it more complex on the loyalty side. OSOD needs a unified checkout that handles both: insurance claims (eyecare) + retail/membership payments (aesthetics).

---

## 9. Reports Structure

### Report Categories (40+ reports)
| Category | Count | Key Reports |
|----------|-------|-------------|
| Clients | 3 | Client Bank Balances, Client Follow Ups, Client Balances |
| Staff | 4 | Performance, Commissions, Tips, Upsale |
| Appointments | 10 | Confirmation, Booked, Daily, Monthly Cancellations/No Shows/No Sales, Treatments |
| Revenue | 15 | Cash/Sales Breakdown, Daily Reconciliation, Ledgers, Deferred Revenue, P&L, Tax, Memberships |
| Marketing | 3 | Campaign, Call Center Leads, Consultation Conversion |
| Inventory | 1 | Product Inventory |
| Misc | 5+ | Dashboard, Price List, Quote, Review, Rewards, Services Remaining |

### Common Report UI Pattern
- Date range selector with day arrows (◄ ►)
- Search/filter button (top right) with report-specific criteria
- Export to Excel (.xlsx) button
- Some reports have PDF export
- Pagination: 50 results per page
- Column headers are sortable (click to toggle ascending/descending)
- Clickable cells link to detail records (client profile, invoice, etc.)

**OSOD note:** AP has 40+ reports. OSOD should start with the essential 10 for Phase 3 (billing): Daily Reconciliation, Tax Ledger, Staff Performance, Appointments, P&L. The rest can be built incrementally. The common report UI pattern (date range + filters + export + sortable columns) is a solid template.

---

## 10. Marketing / CRM

### Email Marketing
- Template editor with drag-and-drop blocks (photo, text, social, dividers)
- E-Blasts: one-time mass emails to filtered lists
- Touchpoints: automated event-triggered emails (appointment cancel, no-show, birthday)
- Drip Campaigns: triggered email sequences (e.g., 30 days post-Botox)
- Pricing: first 500 emails/month free, then $99 for up to 10K

### SMS Marketing
- Requires Twilio integration ($100 activation + Twilio per-text fees)
- A2P 10DLC registration required (3-7 weeks)
- SMS templates with placeholders
- SMS-Blasts to filtered lists
- Pricing tiers: 0-100 texts free, then $20 per 1,000

### Lead Management
- Lead capture via API forms, Book Now, manual entry
- Campaign tracking (source attribution)
- Lead-to-client conversion (automatic on first invoice, or manual)
- Lead detail slideout with 4 tabs: Details, Appointments, Notes, Duplicate detection

### Campaigns
- Campaign types as categories (e.g., "Social Media" → "Facebook", "Instagram")
- Sub-campaigns for granular tracking
- Campaign cost tracking → ROI in Campaign Report

**OSOD note:** Marketing/CRM is where GHL replaces AP for IVA. OSOD doesn't need built-in email marketing or SMS blasting — that's GHL's job. But OSOD does need: campaign source tracking on patient records, lead capture API, and the data model to support marketing attribution.

---

## 11. Key UX Patterns (for OSOD reference)

### Pattern: Slideout Panels
AP uses slideout panels extensively — creating appointments, editing clients, viewing invoices. Content slides in from the right over the current page. User stays in context.

### Pattern: Persistent Quick Toolbar
Bottom toolbar with 12 actions always visible. Most common actions (search, add client, create appointment, create invoice) are always one click away regardless of current page.

### Pattern: Status Colors on Calendar
Yellow = unconfirmed, Green = confirmed, Gray = left message, Blue = arrived, Red = cancelled. Universal across calendar, reports, and client details.

### Pattern: Sortable Data Tables
Every list view has sortable column headers, search, pagination (50/page), and Excel export. Consistent across all reports and list pages.

### Pattern: Multi-Tab Client Record
Four tabs organize different aspects of the same client: demographics, financial history, clinical records, prescriptions. Each tab has its own sub-navigation.

### Pattern: Role-Based Feature Gating
System Users have Groups & Permissions controlling which pages, features, and actions they can access. 2FA required for all users. IP lockdown optional.

### Anti-Patterns to Avoid in OSOD
- **No search within E-Records by content** — can only search by folder name, not form content
- **Cannot change Sold By after invoice creation** — must void and recreate entire invoice
- **Recurring blocked time can crash calendar** — generating too many at once
- **No standalone Credit Memo report** — must cross-reference two different reports
- **Photos not searchable by body area or treatment type** — just chronological in gallery
- **Client Type icons are cosmetic only** — no filtering or workflow automation tied to them

---

## 12. Data Model Implications for OSOD

### Shared Core (Eyecare + Aesthetics)
- Patient/Client record (demographics, contact, insurance, preferences)
- Scheduling (appointments, blocked time, staff calendars, room calendars)
- Billing (invoices, payments, refunds, voids)
- Product inventory (stock, SKU, pricing, categories)
- User management (roles, permissions, 2FA)

### Aesthetics-Specific Extensions
- Service catalog with types, body areas, durations
- Membership engine (standard, token/dynamic, Beauty Bank)
- Rewards & referral points system
- Client Bank (prepaid balance)
- Treatment Payment Plans (recurring card-on-file autopay)
- E-Record forms (consent, intake, treatment records)
- Clinical photography (upload, compare, before/after, ghosting)
- Injection plotting / draw utility
- Consultation tracking and conversion reporting

### What AP Does That OSOD Should Do Better
1. **Decision chains on treatment records** — AP stores flat SOAP notes. OSOD stores WHY (why this treatment, why this change, what was the outcome)
2. **Body-area-aware service catalog** — AP has text categories. OSOD can link services to body areas for the Tesla configurator UI
3. **Photo-to-treatment linking** — AP's gallery is chronological. OSOD can link photos to specific treatments and track visual progress over time
4. **Unified eyecare + aesthetics view** — AP can't see the eyecare side. OSOD shows both in one patient record
5. **Structured before/after with AI** — AP has manual compare. OSOD can auto-detect and measure changes
