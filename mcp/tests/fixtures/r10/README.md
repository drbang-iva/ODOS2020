# R10 legacy fixture replay

`legacy-baseline.json` contains 229 production-reader captures from the six unchanged suites named in the kickoff. The original source is ODOS `40c19a9e442015e1d32396958b661394318713d2`. It uses a lossless object pool (`$ref` indexes), decoded by `baseline.ts`, to avoid repeating the entire definition catalog hundreds of times.

- 61 history responses: replayed byte-for-byte after the helper extraction.
- 14 atomic plus 14 section row calls: paired into the original row sets, compared with `compatRows(projectCurrentFindings(...))`.
- 22 overview and 108 candidate-instance calls: first replay the original function, then feed the projected views into that same function.
- 10 completeness predicate calls: their generic observations pass through unchanged; the original L3 suite also remains green.

`capture-baseline.mjs` instruments a disposable Node process; it does not edit source files or replace the original reader implementations. Run it from `mcp/` with `--import tsx --import ./tests/fixtures/r10/capture-baseline.mjs --test` and the six named suite paths. Set `R10_BASELINE_OUTPUT` to a new scratch JSONL file. The complete capture run was 198 passed, zero failures/skips. Captured suite hashes are SHA256 in base64.

Nine incidental, randomly generated definition UUIDs contained ten consecutive digits, which the repository's fixture privacy guard treats as an identity-like value. They were consistently renamed to `r10-synthetic-definition-N` across inputs and expected outputs. This changes no clinical values or stable keys. All 61 captured history response byte strings were checked unchanged by this normalization. No guard or old assertion was changed.

## Explicit divergences

`parity-divergences.json` pins the five overview calls where retired-option translation removes an unsafe aggregate id. The actual rows and fact/conflict/unresolved counts are hash/count checked; there is no generic “difference allowed” escape. These cases cover brunescent (alone and with nuclear sclerosis), horseshoe tear, iron line, and macular hole. The current overview requires a real id and therefore returns zero rows for those translated views. The positive facts and typed details remain in the projection. A2/A3 must adapt consumers before connecting this library.

`premise-replay.ts` replays the original review's E1–E17 with synthetic transport and the actual existing production writers/readers, then checks 17 corresponding A1 outcomes. Its transport does not prove live policy behavior. That evidence is the separate P1–P7 live preflight.

The additional identity/reader tests cover canonical owners/clear markers, OU overlaps, qualifier equality, latest-snapshot omission/ties, UNKNOWN, negative/panel roles, both sources of homes, stale pages, immutability, and multiple option fields. `field-identities.json` pins every compiled ocular structure's fields and three sampled atomic IDs per structure; stored overrides are deliberately separate.

The completeness captures invoke the real private `keyFindingSatisfied` through a test-only module export, on captured and projected arguments (rehydrating the captured Date). The capture-export test executes both publicly exported wrappers and checks that both captures are emitted.

`R10_RECORD_DIVERGENCES=1` regenerates `parity-divergences.json` in place. Every change to that file requires line-by-line independent review; regeneration alone does not authorize or validate a new difference.
