# OSOD Operator Dashboard

**Last updated:** 2026-05-10
**Latest tag:** `v0.6a` at commit `ce6e94f`

A one-page operator view. Read this before contributing, before installing, before promising anything about OSOD.

For the full per-slice evidence narrative see [`STATUS.md`](../STATUS.md) and [`build-log/`](build-log/).

---

## 1. What this is

OSOD is open-source practice management + EHR for independent optometry, built on the Medplum FHIR foundation, self-hosted on the practice's own hardware. Data never leaves the building unless the practice authorizes it.

Built by a practicing O.D. who has had his own battles with software vendors refusing to release practice data. AGPL-3.0.

This is **developmental code under milestone-locked development.** No general-purpose customer install path exists yet. The first install/pilot milestone is defined below.

---

## 2. Where the code is today

| Layer | State | Evidence |
|---|---|---|
| **v0.5 substrate** (identity, AccessPolicy, audit, DR, scribe attestation, profile installer, clinical encounter UI) | **Shipped** Apr 2026 | broad MCP suite + DR drill + Pass 4 preflight |
| **v0.55 integration spine** (SMART v2 + app registry + CDS Hooks 2.0.1 + AgentOps + Bulk Data + Patient Access + truthful CapabilityStatement) | **Shipped 2026-05-05** at osod tag `v0.55` / commit `e8c8d9e` | [`decisions/2026-05-05-v0.55-milestone-close-audit.md`](https://github.com/drbang-iva/performance-od/) (private — maintainers) |
| **v0.6a Frames Data** (HCPCS terminology + frames catalog + per-practice inventory + ChargeItemDefinition builder + bulk-file ingest + inventory UI primitive) | **Shipped 2026-05-09** at osod tag `v0.6a` / merge commit `ce6e94f` | 1201/1201 MCP + 14/14 v0.6a fixtures + DR drill 32/32 + 5/5 + Pass 4 19/19 |
| **v0.6 remaining (7 slices)** | In flight (v0.6b PVerify next) | master build sheet (private companion repo) |
| **v0.65 / v0.7 / v0.8** | Planned | not authored |

---

## 3. What works end-to-end today

- Local Medplum + Postgres + Redis stack via `docker-compose.yml`
- Identity + RBAC + AccessPolicies for 5 role types
- Patient creation, Encounter charting, Observation saves (refraction, IOP, VA, anterior/posterior, signing)
- SMART on FHIR v2 authz (third-party SMART apps integrate via the local registry; you opt in only the apps you trust)
- CDS Hooks 2.0.1 locally-enforced (external CDS off by default)
- Every PHI access fires `AuditEvent`; durable per-resource attribution via `Provenance`
- DR drill: backup → restore → integrity verification (32 broad + 5 canonical)
- Bulk Data $export + Patient Access API (§170.315(g)(10) surface)
- AgentOps: any AI agent action is audited, blockable, undoable
- v0.6a inventory UI primitive (frames catalog browse + per-practice inventory + add-to-inventory)

## 4. What is verified

| Evidence | At v0.6a (2026-05-09) |
|---|---|
| Broad MCP test suite | 1201/1201 |
| Focused v0.6a fixtures | 14/14 |
| Pass 4 custom lint rules | 19/19 clean |
| DR drill broad | 32/32 |
| DR drill canonical integrity | 5/5 (audit_events, Provenance, Binary, AccessPolicy round-trip) |
| Mandate 14 verification ledger | 10/20 rows closed at consumption time; 10/20 carry-forward consumption-gated |
| v0.55a-e substrate after v0.6a merge | Untouched (one v0.35b role-list regression fixed in same commit) |

## 5. Known gaps + safety limits

- Medplum 5.1.8 `AuditEvent` does not surface `X-OSOD-Source` header — verified at v0.2.5; FHIR `Provenance` is the durable attribution path.
- Medplum 5.1.8 mixed transaction-response — OSOD client compensates by deleting partially-created resources on transaction failure.
- Frames Data AV-roster (Ledger #8) — error messages carry a `[provisional — single-source as of 2026-05-09]` flag until secondary independent source confirms beyond Noridian DME MAC.
- No HIPAA "compliance" claim as a software product — the practice is the covered entity; OSOD ships infrastructure that makes compliance operationally achievable.
- No ONC certification — §170.315(g)(10) Patient Access *surface* shipped at v0.55e; full certification is v0.8+.
- Profile snapshots are checked in (Medplum stack requires snapshots; source files in `data/profiles/` are larger than hand-written differentials).

---

## 6. First install/pilot milestone — Tier-1 "Install + Chart + Safety"

The smallest meaningful install in a real eyecare practice that validates the v0.55 substrate + §170.315(g)(10) Patient Access surface **without depending on any in-flight v0.6 slice.**

### Acceptance criteria

A local optometry practice can, on its own hardware, with no cloud dependency:

1. **Install.** Run the documented install script that brings up Medplum + OSOD. Minimum hardware: 16 GB RAM / 500 GB disk, Docker Compose v2.
2. **Preflight.** `npm run preflight` passes clean (Pass 4 lint, 19 rules, 0 warnings).
3. **Onboard.** Create Organization + admin Practitioner. Configure SMART app registry + AccessPolicies for the role set.
4. **Chart a visit.** Schedule a patient, run a basic exam, record structured findings (chief complaint, refraction, IOP, basic anterior/posterior segment), sign the encounter.
5. **Audit.** Every PHI access fires `AuditEvent`. DR drill 32/32 + 5/5 integrity recoverable on practice hardware.
6. **Patient export.** Patient Access API per §170.315(g)(10) returns the patient's bulk export.
7. **Truthful capability surface.** `CapabilityStatement` accurately describes what is and is not certified.
8. **Documented gaps.** The practice understands explicitly what is NOT production-ready yet and where each v0.6+ gap lands.

### What Tier-1 explicitly does NOT include

- No revenue cycle. The practice's current PMS handles eligibility, claims, payments, and e-Rx during the pilot.
- No ONC certification claim.
- No HIPAA "compliance" claim as a software product (the practice is the covered entity).

### Why Tier-1 first

1. **Substrate-first validates the bet.** If v0.55 doesn't install + audit + DR-recover in a real office, no v0.6 slice matters.
2. **Avoids the "infinite v0.6" trap.** Tying pilot to "all 8 v0.6 slices shipped" delays the pilot indefinitely.
3. **Engine-company posture binds.** OSOD ships software, never operates managed EHR. Tier-1 is proof that a practice CAN install + run OSOD on their own hardware.
4. **Proving-ground practice runs current PMS in parallel.** No flip-the-switch risk; current revenue cycle continues uninterrupted during Tier-1.

---

## 7. v0.6 slice ranking against pilot tiers

| Slice | Tier-1 ("Install + Chart + Safety") | Tier-2 ("+ Cash dispensary") | Tier-3 ("+ Insured visit") |
|---|---|---|---|
| `v0.6a` Frames Data | Not required (shipped; usable for inventory browse) | **Required** (cash optical sales) | Required |
| `v0.6b` PVerify | Not required | Not required (cash only) | **Required** (eligibility) |
| `v0.6c` Payment processor | Not required | **Required** (POS + financing) | Required |
| `v0.6d` Claim.MD | Not required | Not required | **Required** (837P out) |
| `v0.6e` DICOM Supp 247 | Not required | Not required | Optional (device shop later) |
| `v0.6f` WENO e-Rx | Not required | Not required | Optional (own pilot tier later) |
| `v0.6g` Payer FHIR | Not required | Not required | Optional (270/271 alt path) |
| `v0.6h` Paubox | Not required | Not required | Not required |

**Tier-1 ships now — no v0.6 work blocks it.** Tier-2 lights up after v0.6c. Tier-3 lights up after v0.6b + v0.6c + v0.6d.

The v0.6 build queue order is not changed by this ranking. v0.6b PVerify is still the next authoring slice. The ranking just clarifies which slices enable which pilot tier.

---

## 8. Operational lessons carrying forward (v0.6a → v0.6b)

These are the lessons learned during v0.6a Codex execution. Each is a behavior change for the next slice.

- **Lesson 32 — Drive Gem nested-subfolder failure mode.** Conductor / Gemini Custom Gem Knowledge folder linkage to a Drive folder containing nested subfolders breaks the Gem's "process file" mechanism. Archive-during-triangulation folders MUST be siblings to the Knowledge folder, never nested inside it.
- **Lesson 33 — Codex Cloud context-window splits.** v0.6a's Wave-1 Codex prompt (~660 lines + 10-file read preamble) exhausted Codex 5.5 Extra High's context. Resolution: pre-emptively scope sub-prompts (substrate + builders / ingest + UI / gates per ~3-pass sequence) for v0.6b+.
- **Lesson 34 — LLM Mandate 14 over-application.** Wave-2 GPT + Wave-4 Gem applied Mandate 14's "two independent primary sources" to commercial vendor NDA interpretation. Mandate 14 is scoped to medical codes / FHIR artifacts / regulatory citations / DICOM / FDA / specific dates — NOT commercial NDA. Operator override is canonical when LLMs over-apply.
- **Lesson 35 — Wave-4 Gem hallucination + Knowledge-folder failure modes.** v0.6a's first 4 Wave-4 attempts failed due to (1) hallucinated content (OSOD-as-something-else), (2) "Cannot read Knowledge files" from stale Gem custom-instructions, (3) "Couldn't process file" from archive-subfolder-inside-Knowledge, (4) anchor-probe with bonus content (not verdict matrix). v0.6b SHOULD start with a Gem custom-instructions audit + Knowledge folder audit before pasting Wave-4 trigger.

---

## 9. Forward gates after v0.6a tag

| Gate | Trigger | Owner |
|---|---|---|
| AV-roster (Ledger #8) secondary source closure | v0.6+ commit that re-touches `validateFrameClaimModifiers` OR independent source surfaces | operator |
| Tom Doyle vendor-track conversation | operator-side scheduling | operator |
| Synthesis amendment commit (2026-05-08 file) | v0.6 milestone-close OR Wave-N triangulation against v0.6b/c/d | supervised Claude Code at operator direction |
| Docker bridge egress firewall hardening | v0.7+ slice that touches network deployment posture | future Codex slice |
| Drive Gem `gem-knowledge-v0.6a` folder + GPT custom-instructions refresh | v0.6b milestone-open prep | operator |
| HTI-5 named-checkpoint full re-fire | v0.6 milestone-close (after slice h) | supervised Claude Code |
| Anthropic per-commit re-verify | v0.6+ commit that touches Anthropic surface (MCP/Connectors / agentops / safety-valve) | per-commit |
| eCFR §170.315(g)(10)(viii)(B) re-verify | v0.6 milestone-close | supervised Claude Code |
| HL7 AI Transparency on FHIR IG ballot watch | v0.6 milestone-close | supervised Claude Code |

---

## 10. Companion private repo

Strategy, decisions, research, mandates, four-wave triangulation files, the agent fleet, and the first-pilot-milestone decision + bet live in [`performance-od`](https://github.com/drbang-iva/performance-od) (private, maintainer-only). This OSOD repo never duplicates that content.

The osod ↔ performance-od bridge: links in `STATUS.md` + `AGENTS.md` reference performance-od files for context; PRs in osod can cite performance-od decisions by file path; nothing private (strategy, finance, customer data, raw clinic data, secrets) crosses the boundary into osod.
