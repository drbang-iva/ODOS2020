---
title: Gonioscopy local-practice field ledger
scope: Phase 5 gonioscopy charting structures and pigmentation
status: provisional
created: 2026-07-18
sourceStatus: local-practice
notBillReady: true
mandate: Mandate 14
---

# Gonioscopy Local-Practice Field Ledger

| Assertion | Authority | Access date | Status | Consuming code path |
|---|---|---|---|---|
| Angle structures use the operator-approved `closed`, `sl`, `atm`, `ptm`, `ss`, and `cb` values across superior, nasal, inferior, and temporal quadrants for each eye. | Operator design decision, E. Bang, O.D. | 2026-07-18 | local-practice, not bill ready | `mcp/src/clinical-graph/gonioscopy.ts` |
| Trabecular-meshwork pigmentation uses the operator-approved `0`, `1+`, `2+`, `3+`, and `4+` convention per eye. | Operator design decision, E. Bang, O.D. | 2026-07-18 | local-practice, not bill ready | `mcp/src/clinical-graph/gonioscopy.ts`; `mcp/src/clinical-graph/gonioscopy-endpoint.ts` |

These values are practice configuration rather than externally verified terminology. Complete a two-primary-source verification before community export or billing use.
