# W2b implementation plan

Implement the supplied W2b contract at base `4afa0b62c34111ce7b799c16a6a013239e6698a7`.

- Verify P1–P4, including A1 ledger/count-pin and folder-scanner sweep, and open-PR scope before editing; preserve all existing assertions.
- Add new real-handler tests G1–G7 and real catalog/search G8; run baseline with isolated Postgres and operator files absent.
- Load the exact 20-code ledger using the existing loader; change only initial visit pointer selection and its call site.
- Mutate every requested branch and ledger membership; record RED and restored GREEN summaries.
- Reuse W1 fresh-stack bootstrap and synthetic provider setup for G9, including persisted charge readback and rank-one mutant.
- Run relevant and full suites, builds, clean up owned containers, record the evidence, then open the NOT EVALUATED PR to main. Do not merge.

No procedure-charge default changes, existing-charge re-defaulting, W2a, MDM problem-status changes, or W3 work.

Amendment A1: keep the JSON ledger free of CPT/HCPCS literals; name visit families only as `eye-code`, `em`, and `vision-plan`. Run and quote shipped-cpt-guard and preflight-lint. Stop if adding the ledger moves any existing count pin.
