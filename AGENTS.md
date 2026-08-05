---
memory_class: canon
authority: human-approved
auto_inject_priority: 10
---

# ODOS — Open Source Optometry

Practitioner-owned open-source EHR / practice management for independent optometry. Built by a practicing O.D. on the Medplum FHIR foundation. Self-hosted on the practice's own hardware. AGPL v3.

**Current state:** v0.6a Frames Data SHIPPED (2026-05-09). v0.55 integration spine shipped (2026-05-05). 1 of 8 v0.6 slices shipped; v0.6b PVerify is next. The substrate is real working code under milestone-locked development. **Nothing is packaged as a customer install yet.** First-pilot scope is named below.

For the full current-state operator view, see [`STATUS.md`](STATUS.md) and [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

---

## Repo boundary (hard rule)

**This repo is code.** Application code, infrastructure config, tests, dev scripts, build logs, evidence files.

Strategy, research, decisions, vertical knowledge, clinical reference, marketing, agent fleet, and business posture — all live in [performance-od](https://github.com/drbang-iva/performance-od) (the companion **private** business repo). If you find yourself writing a decision rationale or a research investigation here, stop and move it to `performance-od/decisions/` or `performance-od/research/`.

**No PHI, secrets, customer data, raw clinic data, or private commercial strategy is committed here. Ever.**

---

## Architecture (2026-04-22 foundation; current as of v0.6a)

### Foundation

**Medplum** — Apache-2.0, FHIR-native, self-hosted. Runs as a Docker container alongside Postgres 16 + Redis 7. Never on anyone's cloud.

Chosen over HAPI FHIR for:
1. TypeScript end-to-end (no polyglot tax for solo-dev + LLM team)
2. In-process automation via Bots (optional use; HAPI requires separate Node service)
3. 3-6 months less rebuild work on admin/auth/subscriptions
4. Open-core dynamics favor OSS (Medplum Inc. monetizes hosted SaaS, feature-identical to OSS)

Full rationale: the private PerformanceOD foundation decision dated 2026-04-22
([decisions index](https://github.com/drbang-iva/performance-od/tree/main/decisions)).

### SDK discipline (Option 3 architecture)

ODOS application code imports **only** `@medplum/fhirtypes` — pure Apache-2.0 TypeScript types, zero runtime coupling. All server communication is plain FHIR REST/GraphQL.

**Never import in ODOS app code:**
- `@medplum/core` → use plain `fetch()` in `src/fhir-client.ts`
- `@medplum/react` → ODOS builds its own UI
- `@medplum/bot-layer` → workflow logic lives in ODOS's own service layer

**Never call these Medplum-proprietary endpoints:**
- `$execute-bot` (proprietary operation)
- Medplum-specific GraphQL extensions
- Proprietary WebSocket subscription format (use standard FHIR REST-hook or Messaging)

**OK to import as standalone libraries** (no server lock-in):
- `@medplum/ccda` (C-CDA converter library)
- `@medplum/hl7` (HL7 v2 parser library)

Why: this keeps the FHIR server swappable. If a future reason appears to leave Medplum (HAPI, Blaze, IBM FHIR), ODOS's application layer is portable.

### Data locality (non-negotiable)

Patient data lives ONLY on the practice's own hardware. No cloud, no vendor telemetry, no phone-home, no centralized backups unless the practice explicitly opts in. The proving-ground practice is the first install; each subscribing practice installs their own self-hosted ODOS on their own hardware (Mac Mini / Mac Studio / NUC / Linux box / server).

Cloud retracted by the private PerformanceOD local-only decision dated 2026-04-30.

**`docker-compose.yml` is the deployment unit.** Same file works for dev, test, and production.

---

## Milestone trajectory

### Shipped

- **v0.5 substrate** (a-e slices, shipped Apr 2026) — identity, RBAC, AccessPolicy, audit substrate, DR drill, scribe attestation, FHIR profile installer, clinical encounter UI baseline.
- **v0.55 integration spine** (a-e slices, SHIPPED 2026-05-05 at odos tag `v0.55` / commit `e8c8d9e`):
  - `v0.55a` — SMART v2 authorization (patient-directed token revocation)
  - `v0.55b` — SMART app registry (third-party SMART apps integrate via local registry)
  - `v0.55c` — CDS Hooks 2.0.1 (locally-enforced service trust)
  - `v0.55d` — AgentOps governance (audited, blockable, undoable agent actions)
  - `v0.55e` — Bulk Data $export + §170.315(g)(10) Patient Access API + SMART Backend Services + truthful CapabilityStatement + Information Blocking Safety Valve
- **v0.6a Frames Data** (SHIPPED 2026-05-09 at odos tag `v0.6a` / merge commit `ce6e94f`):
  - HCPCS V-series terminology sync
  - `odos_frames_catalog` + `odos_practice_frames_inventory` (FHIR + sibling SQL pattern)
  - FHIR `ChargeItemDefinition` builder cross-referencing frame SKUs
  - Bulk-file-ingest pathway (Access-Point-like local-subscriber workflow)
  - Inventory management UI primitive

### In flight (v0.6 remaining)

| Slice | Scope | Status |
|---|---|---|
| `v0.6b` | PVerify eligibility integration | next |
| `v0.6c` | Payment processor adapters (in-clinic POS + online + financing) | queued |
| `v0.6d` | Claim.MD claims pipeline | queued |
| `v0.6e` | DICOM Supplement 247 imaging | queued |
| `v0.6f` | WENO e-prescribing | queued |
| `v0.6g` | Payer FHIR connectors | queued |
| `v0.6h` | Paubox secure email | queued |

Per-slice cadence observed (v0.6a baseline): multi-hour focused-session-per-slice — authoring + four-wave triangulation (CC + GPT pressure-test + Gem independent + Gem triangulation) + Codex Cloud execution + close audit.

### First-pilot milestone (Tier-1 — "Install + Chart + Safety")

A local optometry practice can, on its own hardware:

1. Install ODOS via documented script
2. Pass `npm run preflight` clean
3. Onboard admin Practitioner + AccessPolicies
4. Chart a basic visit (refraction, IOP, anterior/posterior segment, signing)
5. Verify AuditEvent captures all PHI access
6. Run DR drill 32/32 + 5/5 integrity checks recoverably
7. Export the patient via §170.315(g)(10) Patient Access API
8. Understand explicitly what is NOT production-ready yet (each v0.6 gap mapped to its slice)

**Tier-1 has zero in-flight v0.6 dependencies.** The substrate is what we need to validate first. The proving-ground practice will run their current PMS in parallel for revenue cycle during the Tier-1 pilot.

Future tiers (post-Tier-1):

- **Tier-2 "Install + Chart + Cash dispensary"** — requires v0.6c. Cash optical sales through ODOS.
- **Tier-3 "Install + Chart + Insured visit"** — requires v0.6b + v0.6c + v0.6d. Full revenue cycle.

Full Tier-1 acceptance criteria, rationale, and v0.6 ranking against pilot tiers: [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

### Beyond v0.6

- **v0.65** — TEFCA / Direct Trust messaging + C-CDA (scope-reduced per HTI-5 final-rule deltas; TEFCA Subparticipant onboarding deferred to post-v0.8)
- **v0.7** — Claims management surface beyond clearinghouse (medical billing only — ASC X12 837P) + MIPS/MVP reporting; CPT third-party adapter integration
- **v0.8** — ONC certification execution; engine-company posture re-evaluation gate
- **v1.0** — Production-ready for general install

---

## Licensing

- **ODOS application code:** AGPL v3 (copyleft — community protection, prevents closed-source forks)
- **Runtime deps:** Apache-2.0 (Medplum, `@medplum/fhirtypes`), PostgreSQL License, BSD-3 (Redis)
- **Medical coding terminologies:**
  - **ICD-10-CM, ICD-10-PCS, HCPCS Level II, NDC, CVX** — ship native (CMS / FDA / CDC public domain)
  - **LOINC, RxNorm, UCUM** — ship native (Regenstrief / NLM permissive)
  - **SNOMED CT** — ships native via IHTSDO US Affiliate (free for US users; geographic-fenced for non-affiliate countries)
  - **CPT codes** — NOT redistributed in the ODOS codebase (AGPL conflict + AMA copyright). Third-party vendor adapter pattern; first integration in v0.7. Practices integrate per their own AMA CPT license. Decision: private PerformanceOD medical-coding licensing decision dated 2026-05-05.

---

## Working directory conventions

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Medplum + Postgres + Redis stack |
| `docker-compose.dr-drill.yml` | Isolated DR drill stack |
| `medplum.config.json` | Dev config (replace signing keys before production) |
| `src/` | Application code — plain TypeScript, FHIR-native |
| `src/fhir-client.ts` | Thin plain-fetch FHIR client (no Medplum SDK) |
| `mcp/` | Node MCP adapter — local SMART authz server, MCP tools, broad test suite |
| `ui/` | React UI — Vite-built, Three.js for clinical timeline |
| `data/profiles/` | FHIR StructureDefinitions + CodeSystems + ValueSets installed by `npm run install-profiles` |
| `data/code-bindings/` | Verification ledger files (per-milestone Mandate 14 evidence) |
| `docs/` | Architecture docs (SMART, CDS Hooks, AgentOps, install, capability, build-log/) |
| `scripts/` | Setup wizard, preflight, DR drill, sync workers |
| `tests/` | Test suite (FHIR-native re-implementation of archived v0 requirements) |
| `policies/` + `policy/` | AccessPolicies + lint config |
| `backup/` + `backup-dr-drill*/` | DR drill canonical assets (gitignored data subdirs) |
| `.env` | Local secrets — never committed |
| `.env.example` | Template for `.env` |

Runtime targets: `npm run up` for the local stack; same compose file works on laptop, Mac Studio, or any Linux box meeting the install prerequisites in `docs/install.md`.

---

## Boundary reminders

- **Strategy / decisions / research** → write to `performance-od/` (the private business brain), not here.
- **Vertical knowledge** (clinical, billing, GHL, Foxfire) → already in `performance-od/reference/domain/`. Don't duplicate.
- **Practice-specific data** → never. Practices own their own data, on their own hardware.
- **Marketing / business** → `performance-od/reference/core/`.

---

## Security

**Agents handle routine authentication as normal work; credential and account MUTATION is gated.** Logging in to a local dev instance to verify your own work — reading `ODOS_ADMIN_EMAIL` / `ODOS_ADMIN_PASSWORD` from a gitignored `.env` and signing in — is normal work and needs no human. Full policy lives in the companion private business repo at `performance-od/reference/core/soul.md` ("Authentication and account handling").

**The one rule that stays:** never change credentials, security settings, or account state on the operator's primary accounts without an explicit ask in-session — rotating passwords/email/phone/recovery options, toggling 2FA, deleting accounts, transferring ownership. Routine logins, OAuth grants, and per-app password entry are not credential changes.

Practical boundaries inside this repo:

- **Never commit, echo, log, or paste `.env` values** (including into a PR body, a test fixture, or a screenshot). `.env` and `ui/.env` are gitignored credential files — read them, never reproduce them.
- **Never point a live-proof flow at a real practice, cloud service, or PHI-bearing system.** Live proof runs against the local synthetic Docker stack only.
- Prefer a disposable test identity over a shared one when proving a negative (e.g. a 403 path).

> **History:** this section previously imposed an absolute ban on any agent auth-flow traversal, dated to the 2026-03-21 Figma MCP autonomous-SSO incident. That framing was **retired 2026-05-13** by the operator (`performance-od/decisions/2026-05-13-security-policy-updates.md`, accepted — it supersedes `2026-03-21-playwright-security-lockdown.md`). This file lagged the decision by three days and stayed stale until 2026-07-16; the boundary is now credential *mutation*, not auth-page interaction.

---

## History

Prior custom TypeScript implementation (341 passing tests, non-FHIR) archived at:

- Branch: `archive/2026-04-22-custom-pre-medplum` (pushed to origin)
- Tag: `custom-v0-final`

Reason for reset: Medplum foundation gives 2+ years of FHIR plumbing for free, aligns with AMA CPT distribution criterion (a) structurally (CPT only appears inside FHIR Encounter/ChargeItem/Claim — inseparable from clinical context), and removes the polyglot + rebuild tax HAPI would impose.

Full rationale: private PerformanceOD foundation decision dated 2026-04-22.

## Cross-model routing & build→evaluate pipeline (ACTIVE)

Eric works across Claude (Fable 5 / Opus 4.8 / Sonnet 5) and Codex (gpt-5.5). Canonical
source of truth: `performance-od/core/model-routing-card.md` — this section is a
mirror for this repo's agent; if it drifts from the card, the card wins.

**Every routing call names model AND effort together, always** (e.g. `Opus, extra`,
`Sonnet, medium` — never model alone). Claude Code effort ladder (ascending): low ·
medium · high · extra · max · ultra. Codex effort (`model_reasoning_effort`): low ·
medium · high · xhigh.

Deliverable picks the model: design/architecture synthesis/showpiece UX → Fable
(high); hard implementation/gnarly debug/close audit → Opus (medium; extra/max for
audits); mechanical build from a settled spec/TDD grunt/tests/docs → Sonnet (medium,
default home base); independent verification/evaluation → Codex (high). Advice/Q&A
is Sonnet. Default down, escalate up; flag mid-session drift plainly.

**Author ≠ evaluator, always** — the model/tool that wrote code never grades its own
code. Fable codes → Codex evaluates. Codex codes → Fable/Opus evaluates. Scope: this
gate fires on a shippable coding slice (PR-worthy diff), not brainstorming or
micro-decisions.

**Review bots: GREPTILE + PR-AGENT. CodeRabbit is RETIRED** — suspended account-wide
2026-08-04 for cost. Do not trigger it, wait for it, retry it, or note its absence.
There is no trigger to post and no allowance to budget; both bots auto-run on every PR.
The `--ack-no-bot-review` flag remains a real but rare exception when no bot signal exists
at the current head. (The prior selective-triggering policy, and the PR #313 incident where
its wording produced eight triggers in sixteen minutes and zero reviews, are historical —
the tool it governed is gone.)

The bots are a cheap first pass, never a substitute for the model-level eval and never
the last word on correctness-critical code.

**Re-poll at the FINAL head before declaring ready.** Greptile takes 7–13 minutes;
PR-Agent ~1 minute. A bundle written before Greptile finishes will report "zero threads"
and a green check while a substantive review is still in flight — this happened on three
separate PRs on 2026-08-04. **Zero threads on an `in_progress` check means *pending*, not
*clean*.** Check `gh pr checks <N>` plus an unresolved-thread count, not the check
summary alone.

**Adjudicate every finding ALREADY PRESENT on the PR before requesting evaluation, not
after.** Reply to each existing thread — fix it, or say why not — before handing off.
Added 2026-08-02 after a Major/Stability finding on PR #297 (a boot-blocking scoping
defect, with the fix attached) went unanswered through a fixback push; the independent
evaluator then spent a full round rediscovering it. A finding already sitting on the PR
that goes unread is the single most avoidable failure in this pipeline.

**A green suite is not evidence.** Three independent evals on 2026-08-04 returned FAIL
behind fully green suites. The recurring shape: a test that stubs the very function under
question, or a live proof that exercises only the failure branch. Prove your slice's
headline capability by real invocation, and state plainly which branch your evidence
actually took.

Nothing is "done" until an independent evaluation actually ran.

**Every build→evaluate handoff returns a sealed bundle, not a transcript** — summary,
files touched, checks run + the real command output (never a bare "tests pass"),
risks/follow-ups, patch/diff/commands if needed, status (done/blocked/needs-review).
Full pattern: `performance-od/core/sealed-bundle-handoff.md`. The bundle accompanies
the diff; it never replaces the evaluator reading the actual code and check output.
Full rationale: private PerformanceOD foundation decision dated 2026-04-22.

**Never push to `main`, never self-merge.** Every session — Codex Cloud, local Codex,
either machine, either account — works on a branch and opens a PR. Nobody merges their
own PR without the evaluation step above actually happening.
