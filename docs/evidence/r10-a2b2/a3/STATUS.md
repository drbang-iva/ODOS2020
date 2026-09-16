# Real UI A3 release slots

Replaced source-regex placeholders in ui/tests/r10A3ReleaseScenarios.test.ts with rendered React behavioral tests using a synthetic HTTP transport and real OcularHealthSection, DiagnosisPicker and AssessmentSection components. No production source changed.

All four slots retain `{ todo: "R10 A3" }` and fail on the intended behavioral gap:
- T15: Ocular Health with a canonical projected history row and no single Observation reference does not render its diagnosis proposal (expected 1, observed 0).
- T16: DiagnosisPicker treats an unrelated OS fact as proposed merely because the same diagnosis exists; OD's home is linked and OS's home is empty (expected OS proposal, observed no proposal).
- T17: a real Ocular Health proposal click performs the pick but omits canonical supportingFacts; subsequent assertions require a findings link command with the same commandId and exact key/home.
- T18: Assessment loads the synthetic Condition without Condition.evidence, but omits the origin supplied through canonical homeSources.

`cd ui && node --import tsx --test tests/r10A3ReleaseScenarios.test.ts`: exit 0; 4 tests, 0 pass, 0 fail, 4 TODO. Each TODO records its expected behavioral assertion failure (direct.txt).

`cd ui && node --import tsx --test tests/r10DiagnosisSurfaces.test.tsx`: exit 0; 9 tests, 5 pass, 0 fail, 4 TODO. This .tsx test imports the scenario file so the normal UI test glob includes these slots (imported-runner.txt).

Scoped `git diff --check`: exit 0. No commits, containers, or independent evaluation. NOT EVALUATED; A3 slots remain open by design.
