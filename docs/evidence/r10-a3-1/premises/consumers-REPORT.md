# P8–P16 premise verification

Exact HEAD: `1706d7c8417b04791471d4332b4ecd712883bf11`. Contract: performance-od origin/main `decisions/2026-09-16-odos-r10-a3-codex-kickoff.md`, rev 2.3.

No premise drift found. Read-only production inspection plus six in-memory probes. No application edits, commits, containers, credentials, network calls, or shared-resource mutations in the probes.

| Row | Verified result |
|---|---|
| P8 | Previous-exams/pull evidence traversal still uses Condition.evidence. Pull builds Encounter PUT If-Match + Condition POST + unidentified Observation POST(s) + Provenance POST. In-memory non-atomic first response had 412/201/201/201; response loss left one Condition. Retry returned 200 and produced a second Condition. A subsequent alreadyPresent returned 200 without another transaction. |
| P9 | Condition carry witness and bare target matching remain the lineage basis. Probe: bare Observation target carried=true; later target Provenance makes edited=true; versioning the Condition target removes carry recognition. |
| P10 | Same-encounter live candidate filter, bare-code identification, closed gate, versioned status PUT, VOID Provenance, Encounter PUT and ledger transaction remain. Probe: canonical final fact is section other; actual void returns 200 and retires it, demonstrating missing signed-fact guard. No audit repair call. |
| P11 | Ledger still stores ref/priorStatus plus Condition fields; undo rereads status and overlays priorStatus without command ownership. Real current-finding writer revive then clear after void, followed by old undo, returns 200 and restores final. Guard-10 CVF/pupil shapes classify unrelated. |
| P12 | repairPendingAudits still selects all pending Observations in encounter; no target filter. Probe created separate OD/OS debt, then repaired both: 2 outcomes, 2 Provenance writes, no clinical writes. |
| P13 | Void fixture definitions still have empty valueSchema. Lens/cornea probe classify unrelated under fixture definitions, legacy-section-snapshot under compiled definitions. |
| P14 | Overview reads raw Observation searches and projects identity via findingDefinitionForObservation; links use Condition.evidence. Completeness still calls observationMatchesFindingDefinition. Source verified. |
| P15 | Capture still accepts final/amended/corrected bare-code Observations and committed instance rows without Observation refs. Prompt-only skips commitFinding; valued commit follows application opening; production commitFinding writes bare-code valued Observation. Unapply/restore update Observation. Expansion uses payload.expand, dry-eye fixture points to tear-film. Source verified. |
| P16 | Assessment evidence-reference load and picker already-proposed predicate still traverse Condition.evidence. Candidates branch on multi-select; pick checks multi-select with preRebuild and supporting-facts paths. Source verified. |

Evidence: `probes.ts`, `probes.log`, `source-evidence.txt`. `carry-fixtures.ts` copies the existing carry test helpers with test registration disabled; only its in-memory helpers run. Carry probe overrides its non-persisting fake transaction handler to model the contract-described non-atomic persistence and transport loss; it is not new live-server proof. P14–P16 are source-path verification, not served UI proof.

Command: `node --import ./mcp/node_modules/tsx/dist/loader.mjs .odos/r10-a3-1/premises-consumers/probes.ts`. Final output: `PASS: six targeted in-memory premise probes; no application edits or live requests.`
