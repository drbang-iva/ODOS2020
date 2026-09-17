# Release checker and census author evidence

W86: added escaping and broken suite-symlink controls. The pre-change run failed the escaping guard; restored implementation resolves both candidate and suite root before grouping/spawning. Checker-only green: 17/17; checker plus census: 18/18, no skip/todo. Existing W40 assertions unchanged. Raw red and green logs are adjacent.

Exact AST census: 97 candidate call sites in 43 files; 30 mapped sites across 27 semantic IDs, 67 individually reviewed exclusions. Keys are file, enclosing function/tool, kind and ordinal; source lines are diagnostic. Two Binary JSON Patch entries are included. Registry IDs must match an independent fixed set exactly. Type inspection and known wrappers improve coverage; this does not prove arbitrary aliases or dataflow.

Five mutation variants: W87a drop required ID; W87b add Observation write inside registered function; W129 remove each lifecycle Binary mapping separately and add a second submitted Binary entry inside the existing attestation builder. All five exited 1 with the designated census failure, then 0 after byte-exact restoration. The runner fails loudly on non-unique/missing anchors. No permanent scribeAttestation builder change.

T20 todo removed without changing its two assertions; the executable source search found no exam PDF consumer. T22 old assertions are mapped in t22-assertion-migration.json; its full runtime results are sealed separately after helper integration.
