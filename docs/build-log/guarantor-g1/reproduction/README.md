# Reproducing the synthetic proof

These `.txt` files are source snapshots, not entrypoints to run from this documentation directory. Restore each desired source file to `<repo>/.odos/guarantor-g1/`, dropping only its `.txt` suffix. Restore `proof-output.mjs` beside both mutation runners. In that supported location, `resolve(directory, "../..")` resolves to the repository root.

Use the task-owned ignored `runtime.json` and `compose.json` in that directory. They contain synthetic local credentials and are deliberately not distributed in this public bundle. The runtime names the disposable server on `127.0.0.1:19413`; do not substitute a practice or cloud server.

Run from the repository root:

```sh
node .odos/guarantor-g1/ruled-mutations.mjs
```

This runs the revised P7 and P11a cycles and restores mutated production source in `finally` blocks. The accepted base capture must be present as `.odos/guarantor-g1/base-residue.json`; the existing current RP-failure capture is `.odos/guarantor-g1/p11a-green-residue.json`. Both JSON files are in this evidence directory and can be copied back to those paths. P11a's assertion normalizes only generated identifiers and fixture-specific volatile values.

The manifest records the exact command arguments, explicit non-secret `env` overrides, local `output` `.log` name, and committed `publishedOutput` `.txt` name. Run P7 with the recorded `G1_POLICY_OUTPUT` value to reproduce its named JSON capture. Path sanitization replaces the real repository prefix with `<repo>` and any remaining user-home prefix with `<home>`, retaining relative file names, line numbers, TAP counts, and HTTP status values.

`mutations.mjs` is historical accepted evidence for the ten unaffected guards; its superseded P7 declaration case is not the revised live P7 runner. Use `ruled-mutations.mjs` for current P7/P11a proof.
