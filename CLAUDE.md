---
memory_class: canon
authority: human-approved
auto_inject_priority: 10
---

# Open Source OD (OSOD)

Open source practice management software for independent clinical practices — optometry, aesthetics, and multi-service practices that combine both. Built by a practicing O.D. and licensed aesthetician who runs both under one roof.

**TypeScript. React. PostgreSQL. Local-first. AGPL v3.**

**Boundary:** If you're writing strategy, research, decisions, or domain knowledge — you're in the wrong repo. Switch to `performance-od`. Code, schemas, tests, and user-facing docs belong here. The WHY lives there, the HOW lives here.

---

## EPISODIC MEMORY PROTOCOL — FLEET-WIDE

Two rules that apply to **every agent working in this repo** (Claude
Code, IVA fleet — Iris / Netra / Amara / Maya / Bodhi / Igor / Vani
/ Rishi). Roman is isolated to bang-fitness and does not appear in
this repo.

Rationale + full design:
`performance-od/research/2026-04-09-alex-finn-openclaw-obsidian-memory-mining.md`

### Rule 1 — Log every correction to `.vip/mistakes_log.md`

**When the user corrects, disagrees, or expresses frustration, STOP,
append an entry to `.vip/mistakes_log.md`, THEN respond.** Capture
first, fix second. No skipping on "it was minor."

Trigger phrases: "no", "wrong", "nope", "that's not right", "stop",
"you missed", "you forgot", "actually", "I told you", "re-read",
"check the", "f you", "wtf", silent user pivots, any repetition of
something the user already said.

Path: `.vip/mistakes_log.md` inside this repo. Gitignored, per-machine,
per-repo. Auto-created on first write. Every agent in this repo
appends. The `agent:` field distinguishes entries.

Entry template:

```markdown
## YYYY-MM-DDTHH:MM:SS — one-line summary
**Agent:** <claude-code | iris | netra | amara | maya | bodhi | igor | vani | rishi>
**Correction:** exact user phrasing (quote it)
**Context:** what you were doing when the correction happened
**What you did wrong:** honest self-analysis, no softening
**What you should have done:** specific corrected behavior
**Rule candidate:** draft rule if pattern is new; else "duplicate of <existing-rule>"
**Session:** identifier of the session if known
```

This is the EPISODIC layer. `feedback_*.md` memories (Claude Code)
and `agent_notes.md` per-agent files (OpenClaw/Hermes) are the
SEMANTIC layer. Weekly distillation promotes recurring patterns
from the log into canon rules.

### Rule 2 — Use `outputs/agent-shared/` for cross-session WIP

**At session start, read `outputs/agent-shared/active/` to see what
is in flight. Surface in-flight work in the session opener before
the user has to ask.**

**At session end, update `last_touched` on any active file the
session touched. Move completed projects to
`outputs/agent-shared/completed/`. Write handoff files for explicit
agent-to-agent transfers.**

Directory structure (created once per repo):

```
outputs/agent-shared/
├── active/       # in-flight work, any agent can pick up
├── handoffs/     # explicit "<from>→<to>_YYYY-MM-DD_<slug>.md"
├── completed/    # archive of finished work
└── README.md     # protocol details
```

Active file frontmatter (Hippocampus KG reads this):

```yaml
---
project: <slug>
status: in-progress          # in-progress | blocked | review
started: YYYY-MM-DD
last_touched: YYYY-MM-DDTHH:MM:SS
last_touched_by: <agent>
agents_touched: [<agent>, ...]
next_agent: null             # or '<agent>' for explicit handoff
blocked_on: null             # or 'path/to/blocker.md' (becomes KG edge)
---
```

### Why these rules are load-bearing

Without Rule 1, corrections leak — recurring mistakes repeat because
nothing was captured at the raw-event level.

Without Rule 2, cross-session continuity depends on the user's memory
+ git log + raw session JSONLs. Multi-day projects stall; cross-agent
collaboration requires the user as the human bridge.

Both are immediate behavior changes — they do not wait on any code.

---

## What This Is

A modern, open source practice management system built for clinical practices that don't fit in one box. Optometry. Medical aesthetics. Practices that do both. The core is shared (patients, scheduling, billing), the modules are specialty-specific.

Not a fork of a 20-year PHP monolith. Not a cloud-dependent SaaS. Not "optometry software with aesthetics bolted on." Both are first-class from day one — because the founder runs both.

The dental world has Open Dental. Optometry and aesthetics have had nothing. Until now.

## The Market Shift

Revenue in independent optometry is moving from vision plans to specialties. VSP/EyeMed reimbursements have been flat for 15 years while overhead climbs. The practices that thrive are specialty-heavy: Ortho-K ($1,500-2,500/patient), dry eye ($500-3,000+), myopia management ($1,000-2,000/year), vision therapy ($4,000-8,000), aesthetics (pure cash pay).

**But every PMS was built for the old model** — comprehensive exam + glasses + contacts. Specialties are crammed into free-text fields and workarounds. OSOD is built for the practice model that's winning, not the one that's dying. Specialty workflows are first-class, not afterthoughts.

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

**Research (foundational):**
- `performance-od/research/2026-03-13-opensourceOD-research.md` — Landscape research
- `performance-od/research/2026-03-14-openemr-architecture-audit.md` — Why not OpenEMR
- `performance-od/research/2026-03-14-openemr-alternatives-comparison.md` — Alternatives evaluated
- `performance-od/research/2026-03-14-fork-vs-build-analysis.md` — Fork vs build
- `performance-od/research/2026-03-26-apexo-codebase-analysis.md` — Apexo open source PMS analysis
- `performance-od/research/2026-03-26-os-od-architecture-principles.md` — Architecture principles
- `performance-od/research/2026-03-27-openclaw-hospital-paper-analysis.md` — Hospital-grade AI patterns

**Research (product features — READ BEFORE BUILDING MODULES):**
- `performance-od/research/2026-04-03-vt-home-program-brainstorm.md` — VT module product concept: gamified home therapy, avatar therapists, WebXR VR, competitive landscape (NVT, HTS, Vivid Vision, Optics Trainer). Architecture: Lovable patient app + OSOD backend + GHL community wrapper.
- `performance-od/research/2026-04-03-ai-glasses-exam-workflow-brainstorm.md` — Voice input via AR glasses (Even Realities G1 / Brilliant Labs Frame). Wake word + whisper + local LLM structured extraction. Defining OSOD feature. Pipeline: openWakeWord → mlx_whisper → LLM → chart fields. All local.

**Research (competitive PMS/software — know what exists):**
- `performance-od/research/2026-04-02-aestheticspro-ui-ux-wireframe.md` — AestheticsPro reverse-engineering
- `performance-od/research/2026-03-25-barti-*.md` — Barti PMS competitive intel (2 files)

**Decisions (architecture + product):**
- `performance-od/decisions/2026-03-14-open-source-od-architecture.md` — THE architecture decision (build from scratch, not fork)
- `performance-od/decisions/2026-03-29-knowledge-module-platform-architecture.md` — Platform strategy (3-layer: free infra, paid modules, premium managed)
- `performance-od/decisions/2026-03-29-vault-consolidation-osod-repo.md` — Why this repo exists
- `performance-od/decisions/2026-04-03-product-identity-pivot.md` — PerformanceOD is an open source community platform. OSOD is Pillar 2. Community IS the business.
- `performance-od/decisions/2026-04-03-vani-hermes-migration.md` — Vani (creative engine) builds OSOD UI mockups

**GHL integration research (Pillar 1 connects to OSOD):**
- `performance-od/research/2026-04-03-ghl-agent-studio-detailed-overview-mining.md` — GHL Agent Studio architecture. Understand what GHL does natively so OSOD complements, not competes.
- `performance-od/research/2026-04-03-ghl-service-calendars-conversation-ai-mining.md` — AI-powered appointment booking. OSOD scheduling API should support this pattern.
- `performance-od/reference/domain/foxfire-ghl-integration-architecture.md` — Foxfire→GHL integration patterns. OSOD replaces Foxfire long-term but must match its integration model.

**UI paradigm (HOW to build the interface):**
- `performance-od/decisions/2026-03-*-osod-ui-paradigm*.md` — UI paradigm decision: demonstration-first, not CRUD-form. Legacy PMS paradigm vs OSOD paradigm.
- OSOD docs/reference/screenshot-manifest.md — 110 screenshots mapped by module. USE THIS when building features.

**THE MOST IMPORTANT RESEARCH FILE:**
- `performance-od/research/2026-04-04-osod-clinical-requirements-deep-dive.md` — Eric's complete clinical vision for OSOD. READ THIS BEFORE BUILDING ANYTHING. Covers: pictorial patient timeline (the killer feature), decision tracking, equipment registry, VT module (home + in-office + gamified + avatar-guided), contact lens trial tracking, dry eye treatment tracking, aesthetics, prescription management, device integration strategy, voice input via AR glasses. This is the requirements document.

**CRITICAL RULE: Before building any module or feature, check performance-od for relevant research, decisions, and competitive analysis. The WHY lives there. Build from knowledge, not assumptions.**

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
