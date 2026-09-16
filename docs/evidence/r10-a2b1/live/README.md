# Real diagnosis-door authorization proof

Disposable project `odos-r10-a2b1`, Medplum 5.1.30-9b1bd92, isolated volumes/network/ports. Runtime details in runtime.json. No shared practice data or credentials committed.

The final suite has4 tests: canonical-policy selection regression, live parent, and staff/provider subtests. Each role executes real handler assert, clear, revive, move and link; persisted statuses and extensions are read back. Each refusal checks zero attempted handler writes: signed/cancelled 422, pre-rebuild 409; staff pick403. Staff direct Condition update403 is separately asserted. Both roles also execute two-tab eye-change onto a differing destination (409, no writes) and a dropped write response followed by identical Retry (one persisted owner, one clinical write).

TDD red: old handler rejected operation commands, both role subtests failed400. Initial test cleanup used operator token for ProjectMembership deletion and was refused403; role identities now cleaned using the administrator that created them. Clinical cleanup stays on the separate operator identity. Green:3/3. All five registered live-authz suites:68/68, zero skips. Existing bootstrap integration lane:218/218.

W7 mutation reintroduced chart.diagnosis.write at the finding command boundary: staff subtest failed403 (red exit1), restored chart.write passed both roles (green exit0). Diagnostics include role, project, resource/reference, before/after, policy id/version and blocking lane designation.

Canonical policies were created from the same compiler CI uses, then the canonical sync command ran successfully. The test compares each stored staff/provider policy.resource with current buildMedplumAccessPolicy output before exercising the handler. Local operator setup points at the disposable Medplum PostgreSQL, not the separate test database. CI-only repair guard was not bypassed; canonical policies were seeded via the existing compiler and operator FHIR client because local project-scoped User lookup is unavailable.

No existing assertion changed. New assertions map V1/V2/V3/V12/V14 and §7/§8, W7. NOT EVALUATED.

Final fixback refresh: final-live-authz.tap and lane-green.tap are aliases of the same actual69/69 execution in ci-fixback/live-authz-green.tap. W7-green.tap, door-green.tap and final-diagnosis-live.tap are aliases of the same restored4/4 execution after the renewed W7 mutation. They are not additional independent runs. Earlier68/3 counts above describe historical checkpoints. Current diagnostics derive resourceType from each resource reference.
