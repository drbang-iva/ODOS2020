# S3c-2b execution record

Base: a4e7866fbe20731edb5fd27759d6e6dfffa65a0f. Branch: drbang-iva/followup-s3c2b-not-today.
Coder: Codex. Runtime model/effort identifiers are not exposed; recommended Sol, high effort.
Status: baseline verification; NOT EVALUATED.

R1 accepted from companion kickoff at 02da7c00: only Encounter read retains compartment/not-found mapping; downstream failures return 502 in both GET and PUT.
P2-P7 and P9 checked at origin/main; match. P8: definition route inventory 106/50/6; UI caller-file inventory 59; named-route AST consumers do not target the new Basic write. #647 open: index insertion stays below all shared lines.

Execution: baseline suites/typechecks/preflight; tests first for store/endpoint/UI; implement within grants; G1-G16 mutations including two G11 and two G13 breaks; full candidate checks; real synthetic stack/API/browser proof; PR with bot review; Claude Opus 5 independent evaluation pending.

Shared interfaces: decision map keyed orderable|focus is consumed by derivation; PUT returns the GET queue including canDecide; UI replaces queue from response and keeps saving/errors per key. Shape store remains unchanged. Route block includes its own dynamic import and limiter, avoiding edits to existing lines.

Baseline: three typechecks produced no diagnostics. Preflight: 0 warning(s), 0 hard block(s). Full UI and MCP pending. First MCP run interrupted to enable CI real-WeasyPrint setting; not evidence. Corrected run uses dedicated odos-s3c2b-postgres with ODOS_POSTGRES_URL, ODOS_REAL_WEASYPRINT_TEST=1 and verified WeasyPrint 69.0. No real-practice credentials/data used.

Candidate full suites: UI 1839 pass (base 1834 + 5); MCP 6237 total, 6183 pass, 54 skip (base 6222 + 15). All 18 requested mutations failed their targeted guard and passed after restoration; see mutations.json. Restricted grants mechanically compared to base. Preflight initially overlapped a suite-created RiskAssessment probe; isolated rerun clean; no missing grant and no scope expansion. Initial focused UI command ran from root and failed JSX setup before assertions; corrected command from ui preserved all five existing tests and exposed four missing-feature tests. New fixture correction: retire fee instead of deleting it, because deletion reveals virtual seeds. New G15 assertion corrected to inspect rendered text rather than stringify React internals.
