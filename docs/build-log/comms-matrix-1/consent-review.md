# Consent policy review correction

Consent access now requires both the local communications-evidence category and the privacy scope, in addition to the existing patient compartment. A creation constraint checks those codes; status-only update protection remains intact. The policy scope type supports optional additional query criteria without changing other rules.

Admin declares its patient-compartment parameter. This is descriptive metadata: it does not invent a Patient grant during setup. The existing registration grant function already derives standalone and composite admin bindings from the policy and binds only the newly created Patient. Two new regressions prove that behavior while preserving bare grants. Previously registered Patients still require an existing bounded membership grant.

The live proof now submits unchanged generated policies and uses actual membership parameters for every role. The client helper uses its staff parameter shape for Admin because both require patient_compartment; the bound policy itself is the generated Admin policy. Valid Consent creation and status update succeed. Wrong category or scope creation returns 403; an administrator-seeded unrelated Consent is unreadable to the role and its update returns 404. No policy-criteria rewriting remains in the fixture.

Verification: new policy plus existing role suites 58/58, exit 0; unchanged preflight inventory 14/14, exit 0; live 2/2, exit 0. Replacing the create constraint with true was verified in source and produced 2/5, exit 1; exact restoration produced 5/5, exit 0. No test assertions that existed at the base changed.

Captured output: [policy and role checks](consent-review-tests.log), [preflight](consent-review-preflight.log), [live](consent-review-live-green.log), [mutation proof](consent-review-proof.log), [red](consent-review-mutant-red.log), [restored](consent-review-restored.log).
