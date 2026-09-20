# Disposable proof commands

Run from the task worktree. The base app must come from an untouched checkout of b92ed979. Set BASE_WORKTREE to that checkout. Dependencies must match the locked versions in both checkouts.

```sh
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs prepare
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs up
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs prepare --base-server
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs build --base-server --app-root "$BASE_WORKTREE"
```

Run the base server in its own terminal:

```sh
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs serve --base-server --app-root "$BASE_WORKTREE"
```

Then capture before and build proposed:

```sh
node docs/build-log/issue-639-section-group-concurrency/proof/browser.mjs --before
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs build
```

Run the proposed server in another terminal:

```sh
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs serve
```

Capture and verify proposed:

```sh
node docs/build-log/issue-639-section-group-concurrency/proof/browser.mjs
node --import tsx docs/build-log/issue-639-section-group-concurrency/proof/concurrent-live.ts
```

`prepare --base-server` copies this proof's synthetic identity and fixture references into a separate app runtime. It does not create a second database, check the shared service ports, or recreate the Docker network. It checks only the base app ports. Both app runtimes use the same existing odos-639-proof stack. The browser replay creates a fresh synthetic Encounter for each chart proof; the concurrent-live override probe requires the untouched preRebuild encounter and is a one-time run per fixture.

Stop both app servers and the shared stack:

```sh
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs stop-app --base-server
node docs/build-log/issue-639-section-group-concurrency/proof/stack.mjs stop
docker ps --filter name=odos-639- --format '{{.Names}}\t{{.Status}}'
```

Existing prepared runtimes deliberately refuse re-preparation. To restart retained containers, use the existing generated Compose configuration; do not recreate identities or remove volumes. No production endpoint or dataset is involved.
