# Open Source OD (OSOD)

Open source practice management software for independent optometry. Built by a practicing O.D., for practicing O.D.s.

**TypeScript. React. PostgreSQL. Local-first. AGPL v3.**

---

## What This Is

A modern, open source practice management system purpose-built for optometry. Not a fork of a 20-year PHP monolith. Not a cloud-dependent SaaS. Your data, your hardware, your practice.

The dental world has Open Dental. Optometry has had nothing. Until now.

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

### Phase 5: Advanced
- FHIR interoperability
- Equipment integration (OCT, VF via DICOM)
- Optical dispensing / frame inventory
- ONC certification
- Specialty modules (VT, myopia management, Ortho-K)

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
| **iva-aesthetics** | Aesthetics lab. Future: aesthetics module testing. |
| **bang-fitness** | Fitness lab. Proves the platform works beyond eyecare. |
