# Issue 639 — premise verification blocked

Status: BLOCKED before implementation; NOT EVALUATED.

Verified fetched origin/main and task HEAD: `b92ed979848c055ffca1eafbb0bc023980f3539d`.
Branch: `drbang-iva/section-group-store-concurrency`. No PR created.

## Premises

- P1 confirmed: catalogue creates and first overlays are unconditional; updates derive If-Match from their own read.
- P2 partially contradicted: unconditional override creation is real, but `get()` does not choose an arbitrary raw search row. `readStoredRows()` calls `resolveDuplicates()` (store line 187), whose winner is selected by lastUpdated, then resource id (lines 362–386). The final `[0]` is taken after this resolution. Duplicate physical rows remain a real problem.
- P3 confirmed: shipped profile store has caller versions, conditional creation, token assertion, and 412 translation.
- P4 confirmed: mutation endpoint has the exact 409 wording/code; shared UI message assertions exist. Not executed after the premise stop.
- P5 confirmed: endpoint re-reads then merges existing and parsed data.
- P6 confirmed: DTO and Settings component have no versionId.
- P7 confirmed by source: inventory assertion is 57. Test not executed after the premise stop.
- P8 confirmed: create, update, and override schemas are strict.

## Additional contract issues

The override builder (store lines 235–257) writes a subject reference and JSON extension but no identifier. The requested conditional create on an encounter identifier needs an explicit identifier added, or a condition using the existing code and subject. No condition was silently substituted and no new identifier system was invented.

Section 3.4's scope boundary is reasonable, but its concurrency rationale is incomplete: the endpoint performs get → add/remove groupKey → setGroupKeys (endpoint lines 227–232). That is a read-modify-write path. Keeping caller versions out of scope leaves a lost-update window between the endpoint read and the store's later read. Conditional create alone also does not establish that the losing caller's requested set was applied. This is distinct from the required one-row invariant.

## Stop and requested clarification

Kickoff rule 2 requires stopping when a premise differs. Please accept the deterministic duplicate-resolution correction to P2; specify or authorize the override conditional-create identity (new identifier versus existing code/subject); and acknowledge the remaining endpoint read-modify-write limitation while retaining the create-only scope.

## Verification and scope

Commands: `git fetch origin`, `git rev-parse origin/main`, `git show origin/main:<premise file>`, `gh pr list --state open`, `gh pr diff 626 --name-only`.
Only open PR 626 touches AGENTS.md; no implementation-file overlap found.
G1–G7 mutation proofs, G8 execution, browser proofs, suites, typechecks, and preflight: NOT RUN because the premise gate stopped implementation. No before/after counts claimed.
No application files changed. Only this allowed build-log file was added. No outside-allowlist edit is currently requested.
No test stack was started. `docker ps --filter name=odos-639- --format '{{.Names}}\t{{.Status}}'` returned zero rows.

Not done: S3b shape record/picker; S3c test queue; issues 640, 641, 642; section-group meaning changes; S1 content-pin changes; S1b category-removal changes. No decisions or Mandate 14 ledger rows added.
