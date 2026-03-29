# Open Source OD (OSOD)

Open source practice management software for independent clinical practices — optometry, aesthetics, and multi-service practices that combine both. Built by a practicing O.D. and licensed aesthetician who runs both under one roof.

**TypeScript. React. PostgreSQL. Local-first. AGPL v3.**

---

## What This Is

A modern, open source practice management system built for clinical practices that don't fit in one box. Optometry. Medical aesthetics. Practices that do both. The core is shared (patients, scheduling, billing), the modules are specialty-specific.

Not a fork of a 20-year PHP monolith. Not a cloud-dependent SaaS. Not "optometry software with aesthetics bolted on." Both are first-class from day one — because the founder runs both.

The dental world has Open Dental. Optometry and aesthetics have had nothing. Until now.

## Multi-Service Architecture

OSOD is built for practices that cross specialty lines:

```
OSOD Core (shared)
├── Patients, demographics, insurance
├── Scheduling (multi-provider, multi-service-line)
├── Billing / EDI
├── E-prescribing (WENO)
│
├── Optometry Module
│   ├── Comprehensive exam forms
│   ├── Glasses / CL Rx management
│   ├── Specialty: VT, Ortho-K, Dry Eye, Myopia
│   ├── Vision insurance (VSP/EyeMed)
│   └── Optical dispensing / frame inventory
│
├── Aesthetics Module
│   ├── Consultation forms
│   ├── Treatment records (injectables, lasers, skin)
│   ├── Before/after photo management
│   ├── Membership / package tracking
│   ├── Product inventory (skincare, devices)
│   └── Consent forms
│
└── Future Modules
    ├── Fitness / coaching (client management)
    └── [any clinical vertical]
```

**Key insight:** A patient at IVA might see Dr. Bang for an eye exam in the morning and get a skin treatment in the afternoon. Same patient record, same scheduling system, different clinical modules. No other open source software handles this.

**Deployment options:**
- Optometry-only practice → install core + optometry module
- Aesthetics-only clinic → install core + aesthetics module
- Combined practice (like IVA) → install core + both modules
- The modules share patients, scheduling, and billing — no double entry

---

## Architecture Decision

Full rationale: `performance-od/decisions/2026-03-14-open-source-od-architecture.md`

**Key choices:**
- Build from scratch (not an OpenEMR fork — see decision file for why)
- PM first, EHR later
- WENO for e-prescribing (not Surescripts)
- GHL integration is optional, not required
- Local-first deployment (localhost, your hardware)
- AGPL v3 license (protects community from proprietary forks)

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Language** | TypeScript | AI agents write it best. Full-stack. Largest community. |
| **Frontend** | React | Largest ecosystem. Most AI training data. |
| **Backend** | Node.js (Express or Hono) | Same language as frontend. Simple. Fast. |
| **Database** | PostgreSQL | Battle-tested relational. Patients→visits→claims. Free. |
| **Deployment** | Local-first (localhost) | Your data. Your hardware. No cloud dependency. |
| **License** | AGPL v3 | Derivative works must share source. Protects the community. |

---

## Build Order

### Phase 1: Patients + Scheduling (CURRENT)
- Patient record (demographics, insurance, pharmacy, Rx, balance)
- Per-provider schedule grid (15/30 min blocks, configurable)
- Color-coded appointment types (comprehensive, CL, follow-ups)
- Quick-glance patient card from schedule
- No rooms, no pre-test blocking, no dilation padding — keep it real

### Phase 2: E-Prescribing (WENO)
- EZ Integration first (iframe in patient chart)
- Graduate to Switch API for native UI
- Skip EPCS (optometrists rarely prescribe controlled substances)

### Phase 3: Billing / EDI
- EDI 837P claims via open-source X12 libraries
- Clearinghouse: Office Ally (free) or Stedi (API-first)
- EDI 835 remittance parsing
- EDI 270/271 eligibility verification

### Phase 4: Clinical EHR
- Exam documentation (structured optometry forms)
- Rx flow: doctor → front desk/PM
- Diagnosis codes → billing
- WENO Switch API (native prescription UI)

### Phase 5: Specialty-First Clinical Modules

**This is where OSOD breaks from every other PMS.** Most software treats specialties as an afterthought — a text field where you type free-form notes. OSOD builds structured, specialty-aware clinical tools from day one.

**Vision Therapy Module:**
- Structured VT evaluation forms (not free-text — real fields for real tests)
- Treatment plan builder with protocol templates (Sanet methodology, OEPF-aligned)
- Home therapy assignment and tracking
- Progress tracking across visits (measurable outcomes, not "patient doing better")
- Session notes linked to specific activities and procedures
- AI agent integration: plug in the `vision_training` knowledge module and the system can suggest treatment protocols

**Dry Eye Module:**
- Structured dry eye workup forms (TBUT, Schirmer, meibography, osmolarity, inflammatory markers)
- Protocol chains: diagnosis → treatment plan → follow-up schedule
- Product/device tracking (IPL, thermal pulsation, punctal plugs)
- Severity grading with treatment escalation pathways

**Ortho-K & Specialty Contact Lens Module:**
- **Lens parameter catalogs** — every lens design with full parameter ranges (BC, diameter, powers, peripheral curves, material, Dk). Searchable, sortable, filterable. This is what every PMS gets wrong — they give you one text field for "lens brand."
- Fitting records with topography integration
- Trial lens inventory management
- Overnight wear schedules and follow-up protocols
- Scleral lens fitting records (vault depths, OAD, landing zones)
- Multifocal CL parameter tracking
- Fitting troubleshooting guides linked to patient data

**Myopia Management Module:**
- Axial length tracking and progression analysis
- Treatment comparison (Ortho-K vs. atropine vs. soft multifocal vs. combination)
- Risk assessment scoring
- Parent education material generation
- Annual progression reports

**Aesthetics Module:**
- Consultation and consent forms
- Treatment records (units, areas, products, settings for each device)
- Before/after photo management with standardized positioning
- Membership and package tracking (units remaining, expiration)
- Product inventory (skincare, injectable supplies, device consumables)
- Treatment history timeline (visual — what was done where, when)

**The philosophy:** If a specialty has structured data, OSOD should capture it in structured fields — not a text box. Structured data enables AI agents, enables analytics, enables treatment comparison. Free-text notes are where clinical intelligence goes to die.

### Phase 6: Advanced
- FHIR interoperability
- Equipment integration (OCT, VF via DICOM)
- Optical dispensing / frame inventory
- ONC certification

---

## Domain Knowledge (via performance-od)

This repo has the CODE. The domain knowledge lives in performance-od's vault, linked via `additionalDirectories`.

**PMS reference architecture:**
- `performance-od/reference/vault/software/foxfire/` — Foxfire PMS reverse-engineered (196KB, every screen documented). This is our reference for "how does a real PMS work?"
- `performance-od/reference/vault/software/aestheticspro/` — AestheticsPro reference

**Clinical domain knowledge:**
- `performance-od/reference/vault/eyecare/` — 13 textbooks, clinical atlases
- `performance-od/reference/vault/aesthetics/` — Dermatology, esthetics
- `performance-od/reference/vault/seminars/` — OEPF, INPP, SECO

**Architecture decisions:**
- `performance-od/decisions/2026-03-14-open-source-od-architecture.md` — THE architecture decision
- `performance-od/decisions/2026-03-29-knowledge-module-platform-architecture.md` — Platform strategy
- `performance-od/decisions/2026-03-29-vault-consolidation-osod-repo.md` — Why this repo exists

**Research:**
- `performance-od/research/2026-03-13-opensourceOD-research.md` — Landscape research
- `performance-od/research/2026-03-14-openemr-architecture-audit.md` — Why not OpenEMR
- `performance-od/research/2026-03-14-openemr-alternatives-comparison.md` — Alternatives evaluated
- `performance-od/research/2026-03-14-fork-vs-build-analysis.md` — Fork vs build

**GHL integration (optional layer):**
- `performance-od/reference/domain/ghl-docs/` — GHL platform docs
- `performance-od/reference/domain/ghl-practitioner/` — GHL best practices

---

## Folder Structure

```
osod/
├── CLAUDE.md              # This file — always loaded
├── README.md              # Open source project readme
├── LICENSE                # AGPL v3
├── CONTRIBUTING.md        # How to contribute
├── package.json
│
├── src/
│   ├── server/            # Node.js backend
│   │   ├── routes/        # API endpoints
│   │   ├── models/        # Data models
│   │   ├── services/      # Business logic
│   │   └── db/
│   │       ├── migrations/
│   │       └── schema.sql
│   │
│   └── client/            # React frontend
│       ├── components/    # Reusable UI components
│       ├── pages/         # Route pages
│       └── hooks/         # Custom React hooks
│
├── docs/                  # User-facing documentation
│   ├── getting-started.md
│   ├── architecture.md
│   └── api/
│
├── tests/
├── scripts/
├── docker/
│   └── docker-compose.yml # PostgreSQL + app
└── .github/
    └── workflows/         # CI/CD
```

---

## Development Principles

1. **Simple over clever.** Independent O.D.s will contribute. Keep code readable.
2. **Local-first always.** No feature should require cloud connectivity.
3. **Real practice, real workflows.** Every feature tested at IVA before shipping.
4. **AI-friendly codebase.** Clean TypeScript that AI agents can read, modify, and extend.
5. **No vendor lock-in.** PostgreSQL, not proprietary DB. Express, not AWS Lambda. Your data, exportable.

---

## CRITICAL: Check Reference Files Before Coding

Before implementing ANY clinical workflow, scheduling logic, billing process, or patient data handling:

1. Check Foxfire reference in the vault — how does a real PMS handle this?
2. Check the architecture decision — was this already decided?
3. Check research files — was this already investigated?
4. Build FROM reference, not from assumptions

The vault exists so we don't reinvent wheels. Use it.

---

## Related Repos

| Repo | Relationship |
|------|-------------|
| **performance-od** | Business brain + knowledge vault. Domain knowledge lives here. |
| **iva_eyecare** | Eyecare practice lab. Test OSOD features here first. |
| **iva-aesthetics** | Aesthetics practice lab. Aesthetics module tested here. Eric is also a licensed aesthetician. |
| **bang-fitness** | Fitness lab. Proves the platform works beyond clinical practices. |

---

## The Founder Advantage

Eric Bang is both a practicing O.D. AND a licensed aesthetician running both service lines under one roof at IVA. No other PMS developer has this dual perspective. Every design decision comes from someone who actually does the work in both domains — not from a product manager guessing what clinicians need.

The aesthetics module isn't an afterthought or a future roadmap item. It's built from the same first-person operational experience as the optometry module. And the combined practice (shared patients, shared scheduling, cross-specialty workflows) is the hardest use case — if OSOD handles IVA, it handles anything.

**Spin-off potential:** The aesthetics module works standalone for aesthetics-only clinics — med spas, esthetician practices, dermatology offices. Same core, different module configuration. One codebase, multiple markets.
