# Rebase verification

These captures were refreshed after rebasing the task branch onto `e848450f93c4703c04f71187119a877b462a7408` and running `npm ci` in `mcp/`. The main delta contains only `mcp/package.json` and `mcp/package-lock.json`. The three task commits replayed without changes; [source verification](source-verification.json) records their mapping and hashes.

[Base counts](base-counts.json) were measured in a separate detached checkout of `e848450f`, with locked root, MCP, and UI dependencies installed there. The nine suites total 261 passing tests. Their exact commands, counts, and complete per-file output accompany that record.

P11a's [base capture](base-residue.json) was produced by running the existing `residue-probe.ts RelatedPerson rebase-base` against that base checkout. The current RelatedPerson-failure capture was then refreshed before replaying the existing `ruled-mutations.mjs` runner. Both requests inject the same invalid `RelatedPerson.name` value. The [manifest](ruled-mutations.json) and assertion logs show P7 and P11a each exiting 0 / 1 / 0. P7's three new HTTP captures record their observation times. The prior accepted P11b capture and ten other mutation cycles remain in the parent directory; their production and test hashes are unchanged.

Use the [existing reproduction instructions](../reproduction/README.md), with this directory's `base-residue.json` and `p11a-green-residue.json` restored into ignored `.odos/guarantor-g1/` before replay. To recreate the base capture, restore the existing `residue-probe.ts` snapshot into an isolated checkout of `e848450f` with the task-owned disposable runtime; do not run a changed revision in a shared checkout. The server remains the same task-owned synthetic Medplum 5.1.30 at `127.0.0.1:19413`.

The full-suite summary files preserve actual final command output and exit status; the complete rerun logs remain in ignored `.odos/guarantor-g1/`. The parent directory retains the complete earlier suite outputs. This directory includes the complete refreshed P7/P11a request/response and failing-assertion evidence. No independent evaluation is claimed.

The P11a manifest includes `baseProbe` and `greenProbe` for the two preparatory captures run before `ruled-mutations.mjs`. Their `cwd` and `headSha` bind each command to its checkout; `output`/`capture` identify the local files, while `publishedOutput`/`publishedCapture` identify the exported files in this directory. Both probes exited 0. These fields record the prior observed runs; the mutation runner itself starts from those prepared captures.
