---
memory_class: canon
authority: human-approved
auto_inject_priority: 10
---

# ODOS — Open Source Optometry

Practitioner-owned open-source EHR / practice management for independent optometry. Built by a practicing O.D. on the Medplum FHIR foundation. Self-hosted on the practice's own hardware. AGPL v3.

**Current state — do not hand-maintain a version claim in this file.** The substrate is real working code under milestone-locked development, and **nothing is packaged as a customer install yet**; first-pilot scope is named below. Those facts are durable. *Where the build actually is* is not — so read it from sources that cannot go stale, never from prose here:

| To learn | Read |
|---|---|
| What shipped, and when | `git log --oneline -30 origin/main` |
| What is in flight right now | `gh pr list --state open` |
| Why something was built the way it was | dated files in `performance-od/decisions/` |

> **Added 2026-09-02.** This paragraph previously asserted *"v0.6a Frames Data SHIPPED (2026-05-09) … 1 of 8 v0.6 slices shipped; v0.6b PVerify is next"* — roughly four months stale, and it was the first thing every Codex session read, whether building or reviewing. `STATUS.md` (*"Generated: 2026-07-07"*) and `docs/operator-dashboard.md` had rotted the same way and disagreed with it: three hand-maintained state documents, three different answers. A generated source cannot drift; a remembered one always does. The milestone tables below carry the same risk — trust `git log` over them where they conflict.

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

## Duplication control (binding on any new code here)

AI coding agents duplicate operational logic by default — the same mechanic re-implemented per caller, each copy drifting independently. This repo has already paid for it: **PR #500 took four fixback rounds because the same linked-resource filter existed in three separate `.filter()` shapes**, each silently dropping an unreadable or foreign `MedicationAdministration` instead of refusing, and each had to be found and fixed on its own round.

- **Extraction trigger: the same operational mechanic reaching 2+ callers.** Not before. Logic with exactly one caller stays where it is — premature extraction is its own defect, not a virtue.
- **Endpoints own the "why/when"** — authorization, status transitions, clinical policy, failure classification. **Shared services own the "how"** — the reusable mechanic, with explicit parameters and structured returns.
- **Two different things are called "services" here; the rule applies to only one.** An **application service** (`referral-service.ts`, `scheduling-service.ts`) legitimately owns a domain and writes through its injected FHIR client — `referral-service.ts:248` and `scheduling-service.ts:297` both call `fhir.create(...)`, and that is correct, not a violation. A **shared mechanic** — the thing you extract *because two callers duplicated it* — is the narrower case: it takes explicit parameters, returns a structured result, and does not reach around its caller to mutate clinical state on its own authority. Extract mechanics; don't demote application services into them.
- **Failure is explicit, never a silent drop.** A `.filter()` that removes a row a clinical write depended on must refuse and say why. That is the PR #500 defect restated as a rule.
- **Migrate one caller at a time:** extract the block, convert a single caller, verify, then the rest. Never convert every caller in one commit.

Anti-patterns, all of which have appeared here: one god-function hiding all control flow; a service that writes to storage itself; every function inventing its own argument and error shape; and abstracting logic that only ever had one caller.

*Adapted from [`github.com/michaelshimeles/skills`](https://github.com/michaelshimeles/skills) (`code-structure`), reframed onto this repo's endpoint/service split and its own PR #500 precedent rather than the upstream's actions/service-layer vocabulary.*

---

## Multi-agent hygiene

Several agents work this repo in parallel worktrees. Each rule below was earned, not imported:

- **Never commit directly to `main`.** One worktree and one branch per task, per agent. Never reuse, rebase, or modify another agent's worktree, branch, or uncommitted work.
- **Scope-check before starting:** `gh pr list` and `gh pr diff <n> --name-only`, plus `git status` in any shared checkout. On overlap, stop and ask rather than guess. *(Earned 2026-09-01: a rebase in a shared root checkout put another session's three uncommitted files into conflict.)*
- **Never plain `--force`.** `--force-with-lease` only, and only on your own task branch. Never force-push `main`.
- **Resolve lockfile conflicts by regenerating, never by hand-merging.**
- **Worktrees do not isolate shared resources.** Confirm a dev-server port answers *your* process before trusting it, and never run schema experiments against a shared database. *(Earned: parallel ODOS dev servers colliding on ports — use a unique `--port --strictPort`, verify with `lsof`.)*
- **The root checkout at `~/GitHub/ODOS2020` is a reader** for Codex and VS Code. Don't run history operations in it; work in your own worktree and let the root fast-forward.

---

## What cannot be proven by the test suite

A green suite is not evidence. These are the things this repo's checks structurally cannot see, and each has already produced a shipped defect:

- **Real AccessPolicy enforcement.** Most tests use in-memory FHIR fakes with no policy engine. The pre-finalization void feature (`8de5776b`) passed four evaluation rounds and 26+ tests, then failed 100% against the real server — the AccessPolicy forbids `preliminary → entered-in-error`, and no fake could see it. The credentialed live-authorization lane exists (`npm run test:live-authz`) but runs under `continue-on-error: true` in CI: **treat it as advisory until that flag is removed.**
- **Whether a control is wired at all, anywhere outside three files.** As of 2026-09-02, `ui/` has 103 `*.test.tsx` files, and exactly **three** drive a real browser — `entrySheetFoundations`, `entrySheets`, `examChartBarResponsive` all import `playwright-core` and launch Chromium, and they do run blocking under `npm test`. But they are **fixture-scoped component tests, not route-level liveness**: they mount specific components, they do not walk the app's routes clicking what is there. So for the overwhelming majority of surfaces, nothing loads the page and presses the button before the operator does, and a dead control ships green. *(Corrected 2026-09-02: an earlier draft of this section claimed "zero browser-driven tests." That claim came from a **filename** grep — `playwright|e2e|cypress|\.spec\.ts$` — against tests identified by their **imports**. Wrong search axis, zero results, false absence claim. Caught by the independent evaluator. When claiming something does not exist, search the axis the thing is actually identified by, and quote a count.)*
- **Whether a fixture still tests what it claims.** Two on record: PR #500's guard stayed green after its boundary check was deleted because the fixture did the filter's job, and the 2026-08-28 auditor fixture asserted a boundary for a role a migration had silently removed.

When a change touches any of the three, say so in the PR and prove it another way — a live walkthrough, a credentialed run, or a recorded click path. Silence is not an available outcome (Mandate 17).

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
When neither bot has a signal at the exact head, `--ack-no-bot-review` records the
deliberate exception documented in CONTRIBUTING.md. (The prior selective-triggering
policy, and the PR #313 incident where its wording produced eight triggers in sixteen
minutes and zero reviews, are historical — the tool it governed is gone.)

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

**The evaluator runs its own mutations — a green suite it did not try to break is not an
evaluation.** Reproduce the baseline, then break each invariant the slice claims to guard
and paste RED and GREEN verbatim. Three rules earned the hard way on PR #499/#500
(2026-09-01/02):

- **Verify the mutant actually landed** — grep it in place before believing the result.
  Two of six mutations in one spot-check were silent no-ops from wrong variable names and
  came back falsely green; a red the mutant did not cause is the same class of error.
- **Mutate in a disposable worktree, restore every mutant, and prove the tree is clean
  before reporting GREEN.** `git worktree add --detach` at the exact head, mutate there,
  and finish with `git status --porcelain` empty and the final GREEN re-run from restored
  sources. An evaluator's final numbers must describe the PR, not the evaluator's edits —
  and a mutation left behind can be committed by the next hand that touches the branch.
- **A guard that passes because the FIXTURE does the work is decorative.** One boundary
  guard passed for two full rounds with the production filter deleted, because the test
  fake's own `search()` honoured the query param and excluded the row before the endpoint
  saw it. When a guard defends a boundary, make the fake permissive so the endpoint's own
  check is the only thing that can produce the assertion. Prove it: let the fake mutate
  its private state while returning a stale response, and confirm the client-side
  assertion still fires.
- **The evaluator MAY fix what it finds — and then hands the fix to the other party to
  verify.** Adopted 2026-09-02 after four rounds on PR #499/#500 showed the losses were in
  the *hand-offs*, not the reviews: a fixback item that never reached the evaluator, a path
  that would not resolve, a file pushed but not fast-forwarded — three transfer failures,
  zero reasoning failures. Finder-fixes halves the hand-offs per round. Two conditions,
  both binding:
    - **Whoever writes a guard is never the last to mutation-test it.** The fix goes to the
      other party for verification. That is `author ≠ evaluator` preserved at the hunk
      level, roles swapped — not waived. The author blind spot is writing the test that
      confirms your fix works instead of the one that would catch it being wrong.
    - **Escalate when the DESIGN CONTRACT changes, not when the code feels "architectural."**
      The test is checkable: *does this fix make the design file wrong?* If yes, stop and
      return it for agreement — that is an operator decision, not an implementer's. The
      Dilation `MedicationAdministration` defect was exactly this: §0's persistence-shape
      table never listed that resource type, so the fix implied amending canon. "Major" and
      "architectural" are too fuzzy to route on; "does canon change" is not.

**Read the design of record before judging intent.** Design and fixback lists live in the
private companion repo, checked out beside this one — `../performance-od/decisions/<file>.md`
from the repo root on a local checkout, or wherever `$PERFORMANCE_OD_ROOT` points if it is
sited elsewhere. Cite it as a rooted path, never bare `performance-od/...`: that resolves
from neither repo's root, and a hand-off that silently fails to open is indistinguishable
from an evaluator that ignored it.

**If the companion repo is unreachable — Codex Cloud has no local filesystem, and a second
machine or account may site it differently — say so explicitly and ask for the relevant
excerpt inline.** Do not stop, and do not proceed on inference about what the design says:
an evaluator guessing at intent is worse than one that asks.

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
