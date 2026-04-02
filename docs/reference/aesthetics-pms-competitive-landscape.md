---
date: 2026-04-02
type: research
topic: Aesthetics PMS/EMR Competitive Landscape for OSOD
status: active
memory_class: context
authority: research
sourced_from:
  - web research (Firecrawl search, review sites, vendor pages)
  - reference/domain/competitive-landscape.md
  - research/2026-03-13-opensourceOD-research.md
---

# Aesthetics PMS/EMR Competitive Landscape (2026)

Deep research for the OSOD project — an open-source PM+EHR system serving both optometry AND aesthetics practices under one roof. This maps every significant player in aesthetics practice management, their strengths, weaknesses, API access, and where the market gaps are.

---

## Executive Summary

The aesthetics PMS market in 2026 is **fragmented, proprietary, and ripe for disruption** — but in a different way than optometry. Where optometry suffers from total API lock-out (Eyefinity, Revolution EHR), aesthetics has more options but none that truly solve the multi-specialty problem. No single platform handles medical + retail + membership + multi-specialty well. The closest attempts (PatientNow, Pabau) are still siloed to aesthetics-only workflows. **There are zero open-source options** in the aesthetics PMS space.

### Key Findings for OSOD Positioning

1. **No open-source aesthetics PMS exists anywhere.** OSOD would be first-to-market.
2. **API access is better than optometry but still limited** — Boulevard and Zenoti have public APIs; most others don't.
3. **The multi-specialty gap is massive** — no one handles eyecare + aesthetics in one system.
4. **Photo management and consent forms are table-stakes** — every competitor has them, OSOD must too.
5. **AI is emerging but shallow** — mostly AI charting notes and marketing copy, not clinical decision support.
6. **Portrait Care's free-EMR model is the most disruptive business model** — funded by marketplace margins on supplies.
7. **Pricing ranges from $15/user/mo (Aesthetic Record) to $600+/mo (Zenoti enterprise)** — wide variance.
8. **The biggest pain points are integration lock-in, clunky UX, and poor multi-location support.**

---

## Tier 1: Established Major Players

### 1. Boulevard

**What it is:** Client experience platform for salons, spas, and med spas. Premium positioning, modern UI.

**Target market:** Established, employee-based salons and spas (5+ providers). Not for solo practitioners.

**Features:**
- Precision Scheduling (proprietary algorithm recommends "best times" to eliminate gaps)
- HIPAA-compliant client management
- Smart scheduling logic + integrated marketing automation
- Online booking, messaging, marketing, payments
- Group booking, resource scheduling
- Photo markup and supervisor sign-off (Prestige tier)
- Forms add-on
- PCI, HIPAA, SOC compliant

**Pricing (per location/month):**
| Tier | Price | Key Limits |
|------|-------|------------|
| Essentials | $158 | Up to 5 professionals, 100 texts, 500 emails, 25GB |
| Premier | $263 | Unlimited professionals, 250 texts, 1K emails, 50GB |
| Prestige | $369 | Forms included, 2,500 texts, 10K emails, 100GB |
| Enterprise | Custom | Bespoke plan |
| Aesthetics Starter Bundle | $369 | Med spa specific |
| Aesthetics Bundle | $421 | Full med spa package |

**API access:** YES — public developer portal at developers.joinblvd.com. GraphQL API. SDKs available (book-sdk on GitHub). Sandbox accounts for development. This is the most open platform in the aesthetics space.

**Integrations:** Apple Calendar, Instagram Book Now, Okta SSO, QuickBooks, Reserve with Google, Shopify, Zapier, Klaviyo, Extole.

**Strengths:**
- Best UI/UX in the category — genuinely beautiful software
- Public API with developer portal (rare in this space)
- Strong scheduling intelligence
- HIPAA + SOC compliant

**Weaknesses:**
- 12-month contract required, no trial period
- Premium pricing excludes small/solo practices
- Medical documentation not as deep as dedicated EMRs
- Mobile app functionality limited
- Not a full EMR — more PMS + booking + marketing

**OSOD relevance:** Boulevard proves the market wants beautiful UX + open APIs. Their API-first approach is the model OSOD should follow. Their weakness (shallow clinical depth) is OSOD's opportunity.

---

### 2. PatientNow

**What it is:** Aesthetics-specific EMR + PMS. One of the oldest players (since 2004).

**Target market:** Med spas, plastic surgery clinics, weight loss centers, IV therapy, dermatology, wellness facilities.

**Features:**
- Full EMR with procedure-specific templates for common aesthetic treatments
- RxPhoto integration for clinical photography
- Secure payment processing
- SMS and email marketing automation
- Lab integration (order lab work from EMR)
- Practice management (scheduling, billing, financial)
- Digital intake forms

**Pricing:** Not publicly disclosed. Custom quotes based on clinic size and needs. Users report it can be expensive with add-ons and annual fees.

**API access:** Not publicly documented. Likely limited or enterprise-only.

**AI features:** AI-powered marketing tools mentioned but not detailed. No clinical AI apparent.

**Strengths:**
- Deep clinical functionality — one of the most comprehensive aesthetics EMRs
- 20+ years in the market, deep domain knowledge
- Good customer support (quick response times)
- All-in-one (EMR + PMS + marketing + photos)

**Weaknesses:**
- UI feels dated — multiple users compare it to "an old DOS system"
- Too many clicks for simple tasks, slowing checkout
- Pricing opaque and can be prohibitive for smaller practices
- Features behind paywalls / costly add-ons
- No public API documentation

**OSOD relevance:** PatientNow proves the clinical depth needed — procedure templates, lab integration, photo management. Their UX weakness is a massive opportunity. Their locked API is exactly the problem OSOD solves.

---

### 3. Jane App

**What it is:** Cloud-based practice management for health and wellness practitioners. Canadian company, broad market.

**Target market:** Health and wellness broadly — physiotherapy, chiropractic, counseling, naturopathy, AND aesthetics/med spas.

**Features:**
- Online booking with waitlist notifications
- EMR capabilities with charting
- Telehealth (1:1 video calls built in)
- Jane Payments (PCI-compliant — tips, packages, gift cards, memberships)
- Botox/filler billing by units
- Before/after photo management with side-by-side comparison
- Insurance billing (add-on)
- Prompted reviews

**Pricing (per practitioner/month):**
| Plan | Key Features |
|------|-------------|
| Balance | Solo/low-volume. Limited appointments. |
| Practice | ~$54-79/practitioner. More features. |
| Thrive | ~$175/month. Unlimited appointments, packages, memberships. |
| Insurance add-on | +$20/mo base + $5/full-time, $2.50/part-time practitioner |

**API access:** Not publicly documented. No developer portal found.

**Strengths:**
- Clean, simple interface — fast staff onboarding
- Broad multi-discipline support (could theoretically handle both eyecare and aesthetics)
- No contracts — cancel anytime
- Strong telehealth integration
- Canadian PIPEDA + US HIPAA compliant

**Weaknesses:**
- Per-practitioner pricing scales up fast with team growth
- Key features (unlimited booking, SMS reminders, packages, memberships) gated to highest tier
- Insurance billing integration complex and frustrating per reviews
- Aesthetics features are bolt-ons, not purpose-built
- No public API

**OSOD relevance:** Jane's multi-discipline approach is the closest model to what OSOD needs — one system for multiple practice types. But Jane proves that "broad but shallow" doesn't satisfy specialists. OSOD must go deep in both optometry AND aesthetics.

---

### 4. Vagaro

**What it is:** Cloud-based business management for spas, salons, and fitness centers. Mass-market positioning.

**Target market:** Salons, spas, fitness — with med spa features added. Budget-conscious practices.

**Features:**
- HIPAA-compliant EMR features (med spa tier)
- Booking, POS, CRM, marketing, payroll — all-in-one
- Website integration (booking, gift cards, purchases without redirect)
- AI tools for service descriptions and marketing content
- Inventory management
- SMS and email marketing
- Branded mobile app (add-on)

**Pricing:** Starts at $23.99/month for one calendar. Add-ons stack up:
- SMS marketing: $20-400/mo
- Email marketing: included 1K/mo, then $10-90/mo
- Forms, Drive storage, MySite, branded app — all separate fees
- Payment processing: from 2.2%

**API access:** Limited. No public developer portal found.

**Strengths:**
- Cheapest entry point in the market
- All-in-one with payroll included
- Strong website integration (no redirect booking)
- New AI tools for content generation

**Weaknesses:**
- EMR depth shallow — not suitable for full medical practice charting
- Interface less polished than premium competitors
- System slowdowns during peak times
- Clients forced to create Vagaro accounts to book (friction)
- Reporting lightweight
- Medical documentation not comprehensive enough for serious aesthetics

**OSOD relevance:** Vagaro proves the "cheap + broad" market exists but shows that shallow clinical depth fails serious medical aesthetics practices. The forced-account booking model is an anti-pattern OSOD should avoid.

---

### 5. Mangomint

**What it is:** Modern salon and spa software. Positioned as the "premium alternative" to Vagaro/Mindbody.

**Target market:** Team-based salons and spas. Not specifically medical aesthetics.

**Features:**
- Calendar scheduling, online booking, POS
- Inventory management
- Email and text marketing
- Payroll
- Connect suite (2025): phone calls, web chat, two-way texting in one place — first in category
- Call recordings and transcripts (2026)
- Reporting and analytics

**Pricing:** Starts at $165/month, no setup fees, no contracts. Connect communication feature: $75/month additional.

**API access:** NO public API. Webhooks only for sending event data to third-party apps. No developer portal. Custom integrations available but not self-service.

**Integrations:** Shopify, Mailchimp, Birdeye, Stripe, WaiverForever. Limited selection.

**Strengths:**
- No contracts — month-to-month
- Clean, modern UI
- First to unify phone + text + web chat (Connect)
- Strong customer satisfaction ratings

**Weaknesses:**
- No public API — webhooks only
- No medical/clinical features (not an EMR)
- Not built for medical aesthetics at all
- Limited integrations compared to Boulevard
- Higher starting price than Vagaro

**OSOD relevance:** Mangomint's communication suite (Connect) is ahead of the curve. Their no-contract model builds trust. But the complete absence of medical features means they're not a real competitor for OSOD — they're a salon tool, not a healthcare platform.

---

### 6. Aesthetic Record

**What it is:** Cloud-based EMR and practice management built specifically for med spas and aesthetic practices.

**Target market:** Med spas, aesthetic clinics, injectors. 9,000+ accounts claimed.

**Features:**
- Clinical photography suite (before/after tracking) — rated best in category
- ePrescribing (direct to pharmacy)
- Patient portal (booking, pre-appointment instructions)
- Employee performance tracking (avg sales, satisfaction scores, booked %)
- Procedure charting
- Inventory management
- Memberships and packages
- Customizable treatment notes

**Pricing:**
| Tier | Price | Key Features |
|------|-------|-------------|
| Essentials | $15/user/mo | Photo management, charting, reminders, memberships, inventory. 2GB/user, 250 SMS, 300 emails |
| Accelerator | $19/user/mo | + integrations (RepeatMD, TouchMD, JOYA, PatientFi), 2-way texting, CRM, dashboards. 4GB/user, 400 SMS, 600 emails |
| Enterprise | Custom | Multi-location dashboards, dedicated support, onsite training |
| $399 onboarding | One-time | Both Essentials and Accelerator |

**Add-ons:**
- Cloud ePrescribing: $31-45/mo per prescriber
- ChartSmart AI: $30-75/mo (AI charting notes)
- LeadAR: $97/mo (lead management)

**API access:** GHL integration exists via Aesthetix CRM ($299/mo — noted in competitive-landscape.md). Direct public API not documented.

**Strengths:**
- Best photo management in the category
- Lowest entry price for a full aesthetics EMR ($15/user/mo)
- 14-day risk-free trial, no long-term contracts
- ChartSmart AI for automated charting
- 90-day guided onboarding

**Weaknesses:**
- Support quality declines as practices grow — widespread complaints about poor responsiveness
- Limited storage and SMS/email caps at lower tiers
- Key features require add-ons that stack up cost
- GHL integration requires expensive third-party middleware (Aesthetix CRM at $299/mo)
- No direct public API

**OSOD relevance:** Aesthetic Record's pricing model ($15/user/mo) proves that low-cost aesthetics EMR is viable. Their photo management is the gold standard OSOD must match. The ChartSmart AI add-on shows demand for AI clinical assistance. The GHL integration gap (needing $299/mo Aesthetix CRM middleware) is exactly the kind of problem OSOD solves natively.

---

### 7. Symplast

**What it is:** Mobile-first EHR and practice management platform built by plastic surgeons, for plastic surgeons and med spas.

**Target market:** Plastic surgery practices, med spas, aesthetic clinics. 3,500+ users.

**Features:**
- Mobile-first design (full functionality on smartphone)
- HIPAA-compliant messaging between patients and providers
- Patient app (reminders, forms, media library)
- Multimedia documentation and image drawing tools
- Practice management, online payments
- Marketing analytics
- Insurance and billing

**Pricing:** Starts at $300/user/month. Custom plans available.

**API access:** Not publicly documented.

**Strengths:**
- Genuinely mobile-first — not a desktop app with a mobile afterthought
- Built by plastic surgeons who understand clinical workflows
- Strong patient engagement via dedicated app
- Multimedia clinical documentation

**Weaknesses:**
- Most expensive per-user pricing in the category
- Sales team reputation for overpromising
- "Illogical implementation" of features per user reviews
- Contract concerns — users report difficulty getting honest pre-sale information
- High price excludes small practices

**OSOD relevance:** Symplast proves the mobile-first thesis — clinicians want to chart from their phones. Their $300/user/mo pricing creates massive price disruption opportunity for OSOD. The "built by surgeons" credibility angle is the same as PerformanceOD's "built by a practicing O.D."

---

## Tier 2: Enterprise & Specialty Players

### 8. Zenoti

**What it is:** Enterprise-level all-in-one platform for salons, spas, and med spas. VC-backed, Indian origin (Hyderabad HQ).

**Target market:** Multi-location chains, franchise operations, enterprise med spa groups. Not for small independents.

**Features:**
- AI-powered charting
- HIPAA-compliant photo management
- Personalized treatment quotes
- Targeted marketing + loyalty programs
- Scheduling, billing, inventory, payroll, reporting
- Telehealth
- Multi-location centralized management

**Pricing:** Custom quoted. Range: $225-600+/mo for single locations, up to $10,000-15,000/mo for large multi-location businesses. 12-month contracts required.

**API access:** YES — open API. Integrates with Xero, Tally, QuickBooks, Stripe, Google Analytics, BirdEye, Facebook, Twitter, and more.

**Strengths:**
- Most powerful multi-location management
- Open API
- Deep enterprise features
- Strong AI charting

**Weaknesses:**
- Price excludes independent practices entirely
- Enterprise sales process — not self-serve
- Overkill for 1-4 location practices
- Complex implementation

**OSOD relevance:** Zenoti is the anti-OSOD — enterprise, expensive, locked contracts. But their open API and AI charting are features OSOD should study. The massive price gap ($10K+/mo vs. open-source free) is the same disruption model as Linux vs. enterprise Unix.

---

### 9. AestheticsPro

**What it is:** All-in-one cloud-based software built exclusively for med spas and aesthetic clinics.

**Target market:** Med spas, aesthetic clinics, solo providers to multi-location.

**Features:**
- HIPAA-compliant EMR
- Digital intake and consent forms
- Scheduling, POS, financial reporting
- Marketing tools
- Photo management (before/after)
- E-prescribing (Surescripts)
- Telemedicine (Zoom-powered)
- Customizable treatment notes
- Staff management
- Inventory management

**Pricing:** Starts at $59/month. Three tiers: Professional, Executive, Enterprise. Higher tiers needed for advanced features.

**API access:** Not publicly documented. Users report limited integration options.

**Strengths:**
- Affordable entry point ($59/mo)
- Purpose-built for med spas
- Strong feature breadth for the price
- Good ease of use and support per reviews

**Weaknesses:**
- Payment/invoicing restrictive — limited integration options
- Higher tiers needed for unique features (cost creep)
- Unexpected additional fees reported
- No public API — integration limitations a known pain point

**OSOD relevance:** AestheticsPro is the "mid-market workhorse" — functional but trapped by its own closed architecture. Their integration complaints are identical to what optometry practices say about Eyefinity. Same problem, different specialty.

---

### 10. Pabau

**What it is:** All-in-one clinic management platform. UK-origin, expanding into US market.

**Target market:** Medi-aesthetic clinics, cosmetic practices, med spas, wellness centers. Multi-specialty.

**Features:**
- EMR with treatment notes
- Scheduling and online booking
- Marketing automation
- EchoAI (dictation → patient record notes)
- Client portal
- Secure photo management
- Payment processing and invoicing
- Injection plotting (links product usage to clinical note, auto-deducts inventory)
- HIPAA, GDPR, CQC compliant

**Pricing:**
| Plan | Price |
|------|-------|
| Essentials | $62/user/mo |
| Plus | $99/user/mo |
| Enterprise | Custom |

**API access:** Not publicly documented.

**Strengths:**
- Strong clinical workflow (injection plotting with auto inventory deduction)
- EchoAI dictation is genuine AI utility
- HIPAA + GDPR + CQC triple compliance (global reach)
- Purpose-built for aesthetic workflows (Botox, IV therapy, etc.)

**Weaknesses:**
- UK-centric origin — US market penetration still growing
- Per-user pricing scales up
- Less established in US than competitors
- No public API documented

**OSOD relevance:** Pabau's injection plotting (auto-inventory deduction from clinical notes) is a killer feature OSOD should replicate. Their EchoAI dictation shows the direction of clinical AI. Their triple compliance (US + UK + EU) is the standard for a global open-source project.

---

## Tier 3: Emerging / AI-Adjacent Players

### 11. Portrait Care — The "Barti of Aesthetics"

**What it is:** Free-to-use EMR platform for med spas and wellness clinics. The most disruptive business model in the space.

**Founded:** 2019. Co-founders: Praveen Ramineni (CEO), Patrick Blake (CMO).

**Target market:** Independent med spas, wellness clinics, surgery centers. Specifically targeting practices priced out of PatientNow/Symplast.

**Features:**
- Free core EHR software
- Scheduling, inventory management
- Marketing automation, membership programs
- POS system, financial services
- AI scheduling (checks calendars, books treatment time, auto-sends reminders)
- Marketplace: up to 60% off supplies, ordered from platform, inventory auto-updates after treatment
- Website help, SEO, paid ads, social media, patient automations

**Pricing:** Core EHR is FREE. Revenue model: margins on supply marketplace + financial services + premium add-ons.

**API access:** Not documented publicly.

**AI features:** AI scheduling is the headline. Long-term vision explicitly mentions leveraging "automation and AI to continually reduce costs."

**Strengths:**
- Free EMR eliminates financial barrier entirely
- Supply marketplace creates genuine value (60% off)
- Acts as "marketing agency + software provider" — unique positioning
- Mission-driven: "level the playing field" for independent practices

**Weaknesses:**
- Revenue model depends on marketplace adoption (if practices don't buy supplies through Portrait, model fails)
- Relatively new — less battle-tested than PatientNow/AestheticsPro
- "Free" creates trust concerns about sustainability
- Clinical depth unknown vs. established EMRs

**OSOD relevance:** Portrait is the closest analog to OSOD's philosophy — democratize practice management for independents. Their free-EMR-funded-by-marketplace model is creative but fragile. OSOD's open-source model is more sustainable (community-maintained, no marketplace dependency). However, Portrait proves the DEMAND for free/low-cost aesthetics EMR exists and is massive.

---

### 12. emilyEMR

**What it is:** AI-branded all-in-one EMR specifically for aesthetic clinics. Newer entrant.

**Target market:** Aesthetic clinics, med spas, injectors.

**Features:**
- AI-powered analytics for clinic management
- Drag-and-drop scheduling
- Before/after photo sliders
- Instant facial mapping for injectables
- Real-time inventory tracking (neurotoxins, fillers, skincare, consumables) with low-stock alerts
- EmilyPay (integrated payments — online + in-person, digital gift cards, packages, memberships)
- Text-to-pay, saved cards
- Branded patient portal (booking, forms, package management)

**Pricing:** Not publicly disclosed. Contact sales.

**API access:** Not documented.

**AI features:** AI analytics and facial mapping for injectables are the differentiators. More marketing-focused AI than clinical decision support.

**Strengths:**
- Facial mapping for injectables is genuinely useful clinical tool
- Modern UI with drag-and-drop
- Real-time inventory with auto-deduction
- Text-to-pay reduces collection friction

**Weaknesses:**
- Opaque pricing
- New/unproven at scale
- AI claims need verification (marketing vs. substance)
- No public API

**OSOD relevance:** emilyEMR's facial mapping for injectables is a feature OSOD should study. The "AI-first" branding is mostly marketing at this stage, but the facial mapping is genuine clinical utility.

---

### 13. Calysta EMR

**What it is:** Lightweight, cloud-based aesthetics EMR built by aestheticians and dermatologists.

**Target market:** Solo injectors, new clinics, small practices. Budget-conscious.

**Features:**
- HIPAA compliance
- Premade aesthetic note templates
- E-prescription
- Zoom teleconferencing
- Practice scheduling, digital consents
- Online patient booking, automated reminders
- Patient-specific photo storage
- Text messaging with patients
- Touchless payments, KPI reporting
- Inventory management
- Image editor (mark images during encounters)
- Custom encounter form creator (unlimited forms)
- Two-way Google Calendar integration

**Pricing:**
| Plan | Price |
|------|-------|
| Single user | $49/mo |
| Unlimited users | $99/mo |
| 2 facilities | $149/mo |

**API access:** Google Calendar two-way sync. No broader public API.

**Strengths:**
- Most affordable full-featured aesthetics EMR
- Built by practitioners (aestheticians + dermatologists)
- Unlimited users at $99/mo is exceptional value
- Custom encounter form creator
- No bloat — focused on clinical needs

**Weaknesses:**
- Limited marketing/CRM features
- No advanced AI features
- Small team — support capacity concerns at scale
- Limited integrations beyond Google Calendar

**OSOD relevance:** Calysta proves that a practitioner-built, affordable EMR resonates. Their $99/unlimited-users pricing is the benchmark OSOD's free open-source model destroys. The custom encounter form creator is a feature OSOD needs.

---

### 14. Consentz

**What it is:** Aesthetic clinic software built by aesthetic doctors. UK-based, 13+ years, ISO 27001 certified.

**Target market:** Aesthetic clinics, med spas, cosmetic practitioners. Primarily UK but expanding.

**Features:**
- Treatment-specific pricing (per unit Botox, per syringe filler, per session laser)
- Industry-leading photo management with ghosting technology (precise before/after alignment)
- Color coding, annotations, measurements on photos
- Digital consent management (pre-loaded aesthetic-specific consents)
- Custom form creation with mandatory consent protocols and built-in warnings
- Built-in marketing
- Online booking integrated with clinical workflow

**Pricing:** Starts around £79/month (~$100 USD). Sales-led pricing.

**API access:** Not documented.

**Strengths:**
- Photo ghosting technology (precise alignment) is best-in-class
- Treatment-specific pricing models (unit, syringe, session, package)
- Built by aesthetic doctors — deep clinical understanding
- ISO 27001 certification
- Mandatory consent protocols with warnings

**Weaknesses:**
- UK-centric
- Sales-led pricing (opaque)
- Smaller market presence in US

**OSOD relevance:** Consentz's photo ghosting technology and treatment-specific pricing models are features OSOD should implement. Their mandatory consent protocol system is a compliance must-have.

---

### 15. OptiMantra

**What it is:** EMR and practice management for integrative medicine and wellness. Multi-specialty capable.

**Target market:** Integrative medicine, naturopathy, acupuncture, AND med spas. The closest thing to multi-specialty.

**Features:**
- SOAP templates, custom intake forms
- HIPAA/PHIPA-compliant telehealth
- Electronic prescribing (EPCS via Surescripts/MDToolbox)
- Dispensary module (inventory with pricing, vendors, suppliers)
- Lab integration (LabCorp, Quest, Rupa Health)
- Payment gateways (Stripe, Fiserv, Authorize.net, Stax)
- Online booking, patient portal
- Patient messaging and email reminders
- Insurance billing

**Pricing:** Starts at $99/month for first practitioner. Transparent pricing, no forced tier upgrades.

**API access:** Direct integrations with LabCorp, Quest, Surescripts, Stripe, Fiserv. Broader API not documented.

**Strengths:**
- Multi-specialty design (closest to what OSOD needs)
- Lab and e-prescribing integration
- Transparent pricing
- Dispensary module is useful for practices selling supplements/products

**Weaknesses:**
- Jack of all trades — not as deep in aesthetics as dedicated platforms
- Smaller user base than leaders
- Aesthetics features not as specialized

**OSOD relevance:** OptiMantra is the only current platform attempting multi-specialty (integrative + med spa). Their architecture decisions around supporting multiple practice types are directly relevant to OSOD's design. Study their data model.

---

## Competitive Matrix

| Platform | Starting Price | Public API | HIPAA | Photos | AI Features | Multi-specialty | Consent Forms | Memberships | Open Source |
|----------|---------------|-----------|-------|--------|-------------|----------------|---------------|-------------|------------|
| Boulevard | $158/loc/mo | YES (GraphQL) | Yes | Prestige tier | No | No | Add-on | Yes | No |
| PatientNow | Custom (high) | No | Yes | RxPhoto | Marketing AI | No | Yes | Yes | No |
| Jane App | ~$54-175/mo | No | Yes | Basic | No | Yes (broad) | Yes | Top tier only | No |
| Vagaro | $23.99/mo+ | No | Yes (med tier) | Basic | Marketing AI | Partial | Add-on | Yes | No |
| Mangomint | $165/mo | No (webhooks only) | No | No | No | No | No | No | No |
| Aesthetic Record | $15/user/mo | No (GHL via $299 middleware) | Yes | Best in class | ChartSmart AI ($30-75/mo) | No | Yes | Yes | No |
| Symplast | $300/user/mo | No | Yes | Strong (mobile) | No | No | Yes | Yes | No |
| Zenoti | $225-10K+/mo | YES (REST) | Yes | Yes | AI charting | No | Yes | Yes | No |
| AestheticsPro | $59/mo | No | Yes | Yes | No | No | Yes | Yes | No |
| Pabau | $62/user/mo | No | Yes | Yes | EchoAI dictation | No | Yes | Yes | No |
| Portrait Care | FREE | No | Yes | Yes | AI scheduling | No | Yes | Yes | No |
| emilyEMR | Custom | No | Yes | Yes (facial mapping) | AI analytics | No | Yes | Yes | No |
| Calysta EMR | $49/mo | No (Google Cal only) | Yes | Yes | No | No | Yes | Yes | No |
| Consentz | ~$100/mo | No | Yes | Best (ghosting) | No | No | Best in class | Yes | No |
| OptiMantra | $99/mo | Lab/eRx integrations | Yes | No | No | YES | Yes | Yes | No |
| **OSOD** | **FREE** | **YES (by design)** | **Yes** | **Planned** | **Planned** | **YES** | **Planned** | **Planned** | **YES** |

---

## The API Lock-In Landscape (Aesthetics vs. Optometry)

### Better Than Optometry, Still Bad

| API Status | Aesthetics Platforms | Optometry Platforms |
|-----------|---------------------|-------------------|
| **Public API + developer portal** | Boulevard, Zenoti | Foxfire (limited) |
| **Webhooks only** | Mangomint | None |
| **Requires expensive middleware** | Aesthetic Record (via Aesthetix CRM $299/mo) | None |
| **No API at all** | PatientNow, Symplast, AestheticsPro, Pabau, Jane, Vagaro, Portrait, emilyEMR, Calysta, Consentz | Eyefinity, Revolution EHR, MaxumEyes, Crystal |

**Key insight:** Aesthetics has 2 platforms with public APIs (Boulevard + Zenoti) vs. optometry's 1 (Foxfire). But 13 out of 15 aesthetics platforms still have no meaningful API access. The lock-in problem is real in both verticals — just slightly less severe in aesthetics.

---

## What Aesthetics Practices Complain About Most

Synthesized from G2, Capterra, GetApp, Reddit, and review sites:

1. **Clunky UX / too many clicks** — PatientNow, AestheticsPro, Vagaro all cited for slow workflows
2. **Opaque pricing + surprise fees** — PatientNow, Symplast, AestheticsPro, Vagaro add-on stacking
3. **Feature gating** — critical features (memberships, SMS, consent forms) locked behind higher tiers
4. **Integration limitations** — can't connect to their marketing tools, accounting software, or other systems
5. **Support quality declines at scale** — Aesthetic Record, AestheticsPro both cited
6. **Contract lock-in** — Boulevard and Zenoti require 12-month commitments
7. **Forced third-party accounts** — Vagaro forces patients to create Vagaro accounts
8. **Insurance billing complexity** — Jane App users particularly frustrated
9. **Mobile limitations** — Boulevard, AestheticsPro mobile apps lag behind desktop
10. **Multi-location management** — most platforms struggle beyond 2-3 locations

---

## Open Source Options in Aesthetics

**There are none.** Zero open-source aesthetics PMS/EMR projects exist.

The closest options are general-purpose open-source EMRs that could theoretically be adapted:
- **OpenEMR** — has general medical forms but no aesthetics-specific workflows (no injection plotting, no before/after photos, no treatment packages)
- **GNU Health** — public health oriented, no aesthetics relevance
- **LibreHealth** — dormant project, no specialty modules

**OSOD would be the first open-source system to serve aesthetics practices.** This is a genuine first-mover opportunity in an $18B+ market (US medical aesthetics market 2025).

---

## Features OSOD Must Have for Aesthetics (Table Stakes)

Based on what every competitor does, OSOD needs these to be taken seriously:

1. **Clinical photography** — before/after with alignment/ghosting, annotation, measurement, secure HIPAA storage
2. **Injection plotting** — map injection sites on facial diagrams, link to product/units used, auto-deduct inventory
3. **Treatment packages and memberships** — bundle pricing, prepaid packages, recurring memberships
4. **Consent form management** — treatment-specific digital consents, mandatory protocols, audit trail
5. **Inventory management** — real-time tracking of neurotoxins, fillers, skincare, consumables with auto-deduction
6. **E-prescribing** — Surescripts integration for controlled and non-controlled substances
7. **Aesthetic-specific templates** — procedure notes for Botox, fillers, laser, IV therapy, etc.
8. **Patient portal** — online booking, form completion, photo access, package management
9. **Payment processing** — packages, memberships, tips, gift cards, split payments
10. **Marketing automation** — SMS/email campaigns, drip sequences, review generation

---

## Features That Would Differentiate OSOD

1. **True multi-specialty** — eyecare + aesthetics in one system (nobody does this)
2. **Open API by design** — not as an afterthought or enterprise-only feature
3. **Community-maintained templates** — open-source procedure templates anyone can contribute
4. **AI clinical decision support** — beyond dictation/charting to actual treatment recommendations
5. **No vendor lock-in** — data portability, self-hosting option, no forced accounts
6. **Cross-specialty patient records** — a patient's dry eye treatment and Botox visits in one chart
7. **GHL-native integration** — built for the automation ecosystem, not against it
8. **Practitioner-governed development** — roadmap driven by practicing clinicians, not VCs

---

## Business Model Landscape

| Model | Who Does It | OSOD Approach |
|-------|-----------|---------------|
| Per-location/month | Boulevard, Vagaro | Free (open source) |
| Per-user/month | Pabau, Symplast, Jane, Aesthetic Record | Free (open source) |
| Custom/enterprise | PatientNow, Zenoti, Growth99 | Free (open source) |
| Free EMR + marketplace | Portrait Care | Free + optional PerformanceOD services |
| Free + paid add-ons | Aesthetic Record (low base) | Free + optional cloud hosting/support |

**OSOD's model:** Free open-source software + optional paid services (PerformanceOD setup, hosting, support, templates, GHL integration). Same model as WordPress (free) + WP Engine (paid hosting) + Yoast (paid plugins).

---

## Strategic Implications for OSOD

### The Dual-Vertical Advantage

No platform in either optometry OR aesthetics handles both. Practices adding aesthetics to their eyecare business (like IVA) are forced to run two completely separate systems. OSOD serving both is not just a feature — it's the entire value proposition for the growing number of O.D.s adding aesthetics.

### The Portrait Care Threat

Portrait's free EMR model is the most direct philosophical competitor to OSOD in aesthetics. But Portrait is still proprietary, still closed-source, and still dependent on its marketplace revenue model. If Portrait's supply marketplace doesn't generate enough margin, the free model fails. OSOD's open-source model has no such dependency.

### The Boulevard API Lesson

Boulevard proves that an open API creates ecosystem value. Their developer portal, GraphQL API, and SDK approach should be OSOD's technical model. But Boulevard gates their best features behind $369+/mo tiers. OSOD gives everything away and monetizes services.

### Build Order Implications

Given the existing OSOD architecture decision (build from scratch, not OpenEMR fork), aesthetics modules should be built in this order:

1. **Scheduling + patient records** (shared with optometry)
2. **Clinical photography + consent forms** (aesthetics table stakes)
3. **Injection plotting + inventory** (aesthetics differentiator)
4. **Treatment packages + memberships** (revenue enabler)
5. **E-prescribing** (Surescripts integration, shared with optometry)
6. **Marketing automation hooks** (GHL integration layer)

---

## Sources

- [Boulevard Pricing & Features](https://www.joinblvd.com/pricing)
- [Boulevard Developer Portal](https://developers.joinblvd.com/)
- [PatientNow Reviews — Capterra](https://www.capterra.com/p/92269/PatientNOW/)
- [Jane App Medical Aesthetics](https://jane.app/medicalaesthetics)
- [Jane App Pricing](https://jane.app/pricing)
- [Vagaro Med Spa Software](https://www.vagaro.com/learn/best-medical-spa-software)
- [Mangomint Features](https://www.mangomint.com/)
- [Aesthetic Record Pricing](https://www.aestheticrecord.com/pricing/)
- [Aesthetic Record Reviews — G2](https://www.g2.com/products/aesthetic-record-aesthetic-record/reviews)
- [Symplast EMR](https://symplast.com/)
- [Zenoti Med Spa Software](https://www.zenoti.com/medical-spa-software)
- [AestheticsPro](https://www.aestheticspro.com/)
- [Pabau Pricing](https://pabau.com/pricing/)
- [Pabau Aesthetic EMR Review](https://pabau.com/blog/aesthetic-emr-software/)
- [Portrait Care Platform](https://www.portraitcare.com/platform)
- [Portrait Care Launch — BusinessWire](https://www.businesswire.com/news/home/20240925918776/en/)
- [emilyEMR Features](https://emilyemr.ai/features/)
- [Calysta EMR](https://calystaemr.com/)
- [Consentz Aesthetic Clinic Software](https://www.consentz.com/)
- [OptiMantra Features](https://www.optimantra.com/features)
- [Growth99](https://growth99.com/)
- [Best Medical Spa Software 2026 — thesalonbusiness.com](https://thesalonbusiness.com/best-medical-spa-software/)
- [Best EMR for Aesthetic Practices — portraitcare.com](https://www.portraitcare.com/post/best-emr-for-aesthetic-practices)
- [AmSpa Aesthetic Tech & AI Summit 2026](https://americanmedspa.org/blog/aesthetic-technology-and-ai-for-medical-spas-the-aesthetic-tech-innovation-ai-summit-at-medical-spa-show-2026)
- [Seedtable Medical Aesthetics Startups](https://www.seedtable.com/best-medical-aesthetics-startups)
