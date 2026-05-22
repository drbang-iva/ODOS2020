# OSOD Build Status

**Generated:** 2026-05-10
**Current osod tag:** `v0.6a` at commit `ce6e94f`
**Branch:** `main`

This is the operator-facing dashboard: what works end-to-end, what's verified, what's not production-ready, what's next. Full per-milestone build narrative is in [`docs/build-log/`](docs/build-log/). Architectural rationale lives in the companion private business repo at [`performance-od`](https://github.com/drbang-iva/performance-od).

For the architectural overview + working-directory conventions, see [`AGENTS.md`](AGENTS.md). For the distilled current-state operator view (one-pager), see [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

---

## What works end-to-end today

### v0.55 integration spine (SHIPPED 2026-05-05, osod tag `v0.55` at `e8c8d9e`)

- SMART on FHIR v2 authorization with patient-directed token revocation per §170.315(g)(10)(vi) 1-hour window
- SMART app registry — third-party SMART apps integrate via the local registry; seed catalog ships empty
- CDS Hooks 2.0.1 with locally-enforced service trust (external CDS off by default; opt-in only)
- AgentOps governance — every AI agent action audited, blockable, undoable; Device-AIAST agent identity (hybrid per-agent + per-vendor-model linked via `Device.parent`)
- Bulk Data $export (FHIR Bulk Data 1.0.0 STU1)
- §170.315(g)(10) Patient Access API with patient-directed authorization
- SMART Backend Services with file-download trust-boundary split
- Truthful CapabilityStatement with severity-aware suppression
- Information Blocking Safety Valve composition (RFC 7807 problem-details + 10-code §171 enum)

### v0.55 substrate (shipped Apr 2026)

- Identity + RBAC + AccessPolicy (5 role types: provider, tech, front-desk, billing, admin)
- Audit substrate — every PHI access fires `AuditEvent`; durable attribution via `Provenance`
- DR drill: 32/32 broad recovery + 5/5 canonical integrity (audit_events, Provenance, Binary, AccessPolicy round-trip)
- Scribe attestation / amendment substrate (compensating-transaction rollback reuses v0.5c nullify/amend)
- Local-hardware setup wizard (`npm run setup-practice`)
- Local preflight linter (`npm run preflight`) — Pass 4 custom lint rules (19 active)
- Local Medplum foundation (Postgres + Redis + Medplum server via Docker Compose)
- HL7 v3 ActCode + ObservationValue (AIAST / DICTAST / CPLYCUI)
- Clinical encounter UI baseline (patient picker, comprehensive exam start, structured-finding section saves, sign + finish)

### v0.6a Frames Data (SHIPPED 2026-05-09, osod tag `v0.6a` at `ce6e94f`)

- HCPCS V-series terminology sync (`osod_terminology_hcpcs`)
- `osod_frames_catalog` — append-only Type-2 SCD catalog table (~500K-1M industry SKU capacity)
- `osod_practice_frames_inventory` — per-practice inventory state with FK to canonical catalog
- FHIR `ChargeItemDefinition` builder cross-referencing frame SKUs via canonical URLs
- Frames Data ingest — bulk-file-ingest pathway (Access-Point-like local-subscriber workflow; no outbound HTTP to vendor)
- Inventory management UI primitive
- 11 new AuditEvent event_types (frames bulk + hcpcs + csv export + subscription toggle)

---

## What's verified

### v0.6a close evidence (2026-05-09)

| Gate | Result | Source |
|---|---|---|
| v0.6a fixture tests | 14/14 (consolidated from 22 fixture concepts) | `mcp/tests/v06a-frames-data.test.ts` |
| Pass 4 lint | 19/19 rules clean, 0 warnings | `npm run preflight` |
| DR drill | 32/32 broad + 5/5 integrity | `scripts/v06a-frames-dr-drill.ts` |
| Broad MCP suite | 1201/1201 (1187 v0.55e baseline + 14 new v0.6a) | `npm test` |
| Mandate 14 verification ledger | 10/20 rows closed at consumption time | `data/code-bindings/v0.6-verification-ledger.md` |
| Mandate 15 boundary audit | 3 checks appended | `docs/build-log/2026-05-09-v0.6a-frames-data.md` |
| v0.55a-e substrate | Untouched (one v0.35b role-list regression fixed in same commit) | broad suite rerun clean |

### v0.55 close evidence (2026-05-05)

- Broad MCP suite: 1187/1187 fresh stack + 1187/1187 restored stack
- Focused v0.55e suite: 34/34
- DR drill: 32/32 + 5/5 integrity (audit_events 62/62, Provenance 10/10, Binary 4/4, AccessPolicy round-trip)
- 5/5 close-audit steps cleared: HTI-5 Proposed Rule verified; HL7 AI Transparency IG carry-into-v0.6; first-eyecare-marketplace artifact removed; §170.315(g)(10)(viii)(B) eCFR verified; test-count regression observation cleared

### Audit math (v0.6a)

13 SQL mutations → 26 fan-out FHIR resources (DeviceDefinition + ChargeItemDefinition) → 1 FHIR Task wrapper + 26 + 26 + 1 + 1 = **55 attribution artifacts per ingest run**. `Provenance.target` references FHIR canonical URLs, never raw SQL row PKs.

---

## What is NOT production-ready

| Capability | Status | Lands at |
|---|---|---|
| Insurance eligibility check | Not built | v0.6b PVerify (next) |
| Card payments + financing | Not built | v0.6c Payment processor |
| Electronic claim submission | Not built | v0.6d Claim.MD |
| DICOM device integration | Not built | v0.6e DICOM Supp 247 |
| E-prescribing | Not built | v0.6f WENO |
| Payer FHIR connectors (270/271 alt) | Not built | v0.6g |
| HIPAA-compliant email | Not built | v0.6h Paubox |
| TEFCA / Direct Trust messaging | Not built | v0.65 (scope-reduced per HTI-5) |
| MIPS / MVP reporting | Not built | v0.7 |
| CPT third-party vendor integration | Not built | v0.7 |
| ONC certification execution | Not built | v0.8 |
| General-purpose customer install path | Not built | post-Tier-1 pilot validation |

Plus the operational lessons that carry forward into v0.6b: see [`docs/operator-dashboard.md`](docs/operator-dashboard.md) for the four v0.6a-operational lessons (#32-#35) and the forward-gate table.

---

## Known gaps + safety limits

- **Medplum AuditEvent does not surface `X-OSOD-Source` in 5.1.8.** Verified empirically at v0.2.5. OSOD still sends the header for ingress attribution; FHIR `Provenance` is the durable per-resource attribution path.
- **Medplum 5.1.8 mixed transaction-response handling.** Server can return a mixed transaction-response instead of rolling back every successful entry after a later entry failure. OSOD client transaction helpers compensate by deleting resources created in the failed response. Section-save tests assert no created clinical resource persists after the covered failure mode.
- **Frames Data AV-roster Ledger #8** carries a `[provisional — single-source as of 2026-05-09]` flag in v0.6a error messages until a secondary independent source corroborates beyond Noridian DME MAC.
- **Profile snapshots are intentionally checked in.** Medplum profile validation requires snapshots in this stack; source files in `data/profiles/` are larger than hand-written differentials.
- **No claim of HIPAA "compliance" as a software product.** The practice is the covered entity. OSOD ships infrastructure that makes compliance *operationally achievable* (local-only, audit-by-default, BAA-free posture). The pilot README states this explicitly.
- **No claim of ONC certification.** §170.315(g)(10) Patient Access *surface* shipped at v0.55e; full ONC certification is a v0.8+ gate.
- **No claim of production-readiness at v0.6a.** This is developmental code under milestone-locked development.

---

## Next-release checklist (v0.6b PVerify)

- [ ] Author Wave-1 codex prompt (substrate + builders + UI per Lesson 33 sub-prompt split)
- [ ] Drive Gem `gem-knowledge-v0.6b` folder + GPT custom-instructions refresh (Mandate 16 absence-audit pre-flight)
- [ ] Wave-2 OSOD Architect GPT pressure-test
- [ ] Wave-3 OSOD Architect Gem independent review (fresh chat, no Wave-2 exposure)
- [ ] Wave-4 OSOD Architect Gem triangulation (Wave-2 in Knowledge folder)
- [ ] Integrate binding amendments into Wave-1 prompt
- [ ] Operator paste into Codex Cloud → execute on osod branch `drbang-iva/v0.6b-pverify`
- [ ] All Wave-1 acceptance criteria gates clear (fixtures + Pass 4 lint + DR drill + broad suite + ledger pre-flight)
- [ ] PR review + squash-merge + tag `v0.6b`
- [ ] Close audit: PROVISIONAL ledger items, HTI-5 named-checkpoint status, Anthropic per-commit re-verify if surface touched, operational lessons captured

---

## Pilot-readiness checklist (Tier-1 "Install + Chart + Safety")

Tier-1 has zero in-flight v0.6 dependencies. v0.55 + v0.6a substrate is what we validate first.

- [ ] Document install steps end-to-end (`docs/install.md` expanded coverage)
- [ ] Verify install on practice hardware (the proving-ground practice's own Mac Studio, NUC, or Linux box)
- [ ] Confirm `npm run preflight` clean on non-dev hardware
- [ ] Onboard admin Practitioner + AccessPolicies via setup wizard
- [ ] Chart a real test visit (refraction, IOP, anterior/posterior segment, sign + finish)
- [ ] Verify `AuditEvent` count for the visit ≥ expected baseline
- [ ] Run DR drill on practice hardware — 32/32 + 5/5 integrity must pass
- [ ] Patient Access API returns valid bulk NDJSON for the test patient
- [ ] CapabilityStatement reflects truthful certification posture (not certified as a complete system; specific surfaces named)
- [ ] Documented gaps section in `docs/install.md` enumerates every v0.6+ capability still in flight

Full Tier-1 acceptance criteria + rationale + v0.6 ranking against pilot tiers: [`docs/operator-dashboard.md`](docs/operator-dashboard.md).

---

## How to verify locally

```bash
# 1. Stand up the Medplum stack
npm run up
docker compose ps  # all three: running (healthy)

# 2. Install Node deps + FHIR profiles
npm install
cd mcp && npm install && cd ..
npm run install-profiles  # idempotent

# 3. Run MCP test suite
cd mcp && npm test
# Expected: 1201/1201 passing (v0.6a baseline)

# 4. Run UI checks
cd ui && npm install && npm run build
# Expected: build clean; existing large-chunk warning only

# 5. Run preflight + DR drill
npm run preflight  # Pass 4 lint, 19 rules, 0 warnings
npm run dr-drill   # 32/32 broad + 5/5 integrity

# 6. Smoke test
npm run poc
# Expected: ✓ Logged in / ✓ Created Patient / ✓ Created Encounter / ✓ Created ChargeItem
```

---

## Reference docs (canonical)

Inside this repo:

- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) — current-state agent + architecture brief
- [`README.md`](README.md) — public-facing intro + developer quickstart
- [`docs/operator-dashboard.md`](docs/operator-dashboard.md) — distilled current-state view + Tier-1 milestone + v0.6 ranking
- [`docs/install.md`](docs/install.md) — install walkthrough
- [`docs/build-log/`](docs/build-log/) — full per-slice build evidence
- [`data/code-bindings/`](data/code-bindings/) — verification ledger files

Companion **private** business repo ([`performance-od`](https://github.com/drbang-iva/performance-od) — maintainer-only):

- Master build sheet, mandates, per-slice decisions, four-wave triangulation research files, first-pilot-milestone decision + bet, episodic memory.

---

## License

AGPL-3.0 application code. Apache-2.0 dependencies underneath. Derivative works must share source — practitioner-owned, practitioner-shared.
