# R10 A2b.2 author work in progress

NOT EVALUATED. HELD OPEN. Never merge this branch independently of the R10 joint release.

Base: A2b.1 `6025d836643fdf74298834f8290a8fdacabef5b7` (independently evaluated by Opus; server unchanged by this slice).
Contract: performance-od kickoff rev 3.5, sections 3.10 and 12. Shared checkouts were only read/fetched.

## Pending operator ruling

Rev 3.5 preserves the legacy `submitDiagnosisPick` call in DiagnosisPicker, so changing its new linkMode default to facts does not change the request's supportingFacts. The requested W51 mutation cannot fail the no-supports request assertion under that preserved call. Asked whether to guard the default mode explicitly while retaining the two real legacy request tests; no answer yet. No W51 success is claimed. The new facts-mode API is used only by DiagnosisWorkspace.

## Verification so far

- Six original door suites baseline: 91 pass, 0 fail.
- Full UI after fixture migration: 1665 total, 1661 pass, 0 fail, 4 A3 TODO. Subsequent small author-review fixes are covered by affected suites; final rebased verification pending.
- Full MCP on isolated synthetic PostgreSQL: 5674 total, 5605 pass, 0 fail, 53 environment skips, 16 A3 TODO. `ODOS_ALLOW_UNGATED_MCP=1` explicitly acknowledges missing Medplum credentials; this is not live-authz proof.
- UI and MCP builds exit 0. Preflight 0 warnings, 0 hard blocks. A3 gate exits 1; requested UI slots are present and TODO.
- Mutation evidence is in table/, workspace/, surfaces/, and W54/. W54 is a newly added failure case in the existing demotion suite, because that suite did not previously assert a failed HTTP pick. Legacy API mutation fails the test and tsc at Assessment353; restoration passes.
- Every changed existing assertion is recorded in existing-assertions.md. No Assessment or structure-section source changes, no MCP delta from the inherited base.
- Synthetic before/after browser evidence is in visual/. Real rendered components, transport fakes; not a deployed clinical walkthrough.

## Author review fixes

- Notices/recovery buttons live inside the selected diagnosis panel rather than occupying grid columns.
- Existing-diagnosis support links permit staff chart.write without Condition-write permission.
- Unknown/conflicting overlay presence is not labelled Present.
- Applied picks clear the old scope prompt before attempting bodySite, preventing accidental re-pick after scope failure.
- Link prevalidation uses the frozen supporting rows and baselines; conflict recovery offers a new command rather than repeatedly resending a stale one.

Audit authenticity remains the separately scoped release blocker from A2b.1. A3 consumers remain deliberately unimplemented here.
