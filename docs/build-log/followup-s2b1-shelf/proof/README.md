# Replaying the synthetic proof

Run from the task worktree root. Requires the existing locked Node dependencies, Docker/Colima (8 GiB), Chrome, and Caddy. Use only the task-owned synthetic stack; no real practice or PHI-bearing service is involved. Runtime credentials, complete logs, and resource identifiers stay in gitignored `.odos/s2b1-proof/`.

## Guards

```sh
node docs/build-log/followup-s2b1-shelf/proof/guards.mjs
```

This temporarily mutates one allowed source file at a time, requires red, restores it in `finally`, and requires green. Do not run a build, suite, or editor against the same worktree concurrently. G5 mutates the actual endpoint refusal; its final diff must be empty. Only summaries are written to the build log; full logs go to the OS temporary directory.

## Browser

Use a separate, clean base worktree at `f2ef2c325e36d756759a525339431d70c7bcfde1`. Install its locked dependencies and provide its path as `<base-worktree>` below. Do not repurpose another task's checkout.

```sh
node docs/build-log/followup-s2b1-shelf/proof/stack.mjs prepare
node docs/build-log/followup-s2b1-shelf/proof/stack.mjs up
node --import tsx docs/build-log/followup-s2b1-shelf/proof/seed-shelf.ts --fresh-dry
node docs/build-log/followup-s2b1-shelf/proof/stack.mjs build --app-root <base-worktree>
node docs/build-log/followup-s2b1-shelf/proof/stack.mjs build
node docs/build-log/followup-s2b1-shelf/proof/stack.mjs serve
```

`prepare` runs once per fresh runtime and refuses to overwrite an existing identity. `up` bootstraps the disposable practice and identities. `serve` stays running; wait for its actual provider-readiness success, then in another terminal run:

```sh
node docs/build-log/followup-s2b1-shelf/proof/browser.mjs <base-worktree>
```

The proposed front door uses port 31091. The browser runner creates and closes a separate Caddy process on 31092 serving the base UI. Both use the same synthetic FHIR data and unchanged MCP source. The runner logs in through the native UI, clicks the existing controls, and records real endpoint responses. It installs no browser route mocks. Its full replay requires fresh Dry Eye encounters (`seed-shelf.ts --fresh-dry`); old synthetic encounters remain intact.

For the additional narrow-screen geometry check alone:

```sh
node docs/build-log/followup-s2b1-shelf/proof/browser.mjs <base-worktree> --clearance-only
```

Stop every task-owned application and container at the end:

```sh
node docs/build-log/followup-s2b1-shelf/proof/stack.mjs stop
docker ps --filter name=odos-s2b1- --format 'table {{.Names}}\t{{.Status}}'
```

If a separate `odos-s2b1-suite-db` was started for the full MCP suite, stop it too. Do not stop other tasks' containers. Repeated authentication-heavy replays may encounter the local server's login rate limit; allow its window to expire instead of changing auth settings.
