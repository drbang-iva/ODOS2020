# Front-door config

`Caddyfile` is the versioned front-door route table. The blocking parity check
compares it with backend route discovery and the Vite proxy table:

```sh
node .claude/skills/tier0-census/scripts/check-frontdoor-coverage.mjs
node --test .claude/skills/tier0-census/scripts/frontdoor-self-test.mjs
```

## Install

Use an absolute path to an existing UI distribution directory and an absolute
config target path. Install Caddy on PATH first; validation is mandatory.

```sh
node scripts/frontdoor-install.mjs --ui-dist /absolute/ui/dist --target /absolute/frontdoor.Caddyfile
```

The default run renders the root placeholder, runs `caddy validate --adapter
caddyfile` in a temporary directory, and prints a unified diff without writing the
target. Review the diff, then repeat the command with `--apply`. Before replacing
an existing target, the installer makes `<target>.bak-<UTC timestamp>` containing
the original bytes. The rendered bytes are written and synced in a temporary file
beside the target, then installed atomically. Backup contents and target-directory
entries are synced before reporting success. Existing permission bits are preserved;
a new config is mode `0644`. A new target has no prior file to back up. An unchanged target
is left alone. Temporary validation files are removed on both success and failure.

If the final directory sync fails after replacement, the command exits 1 and reports
that the config was installed but durability is unknown. Inspect the target and backup
before restarting; an error after replacement does not mean the target is unchanged.

Coordinate with other config writers and run one installer at a time. The installer
checks for observed target changes after staging and immediately before replacement;
these checks are not a lock against arbitrary concurrent writers.

After a successful apply, the operator restarts the configured front-door service
using that host's service manager. The installer never starts or restarts services.
To test the installer locally with a real Caddy binary (no server starts), run:

```sh
node --test scripts/frontdoor-install.test.mjs
```

`/comms` is deliberately tunnel-only for webhooks and tracked links, and must remain
absent from this front door. Its reason is recorded in `exclusions.json`. Do not
change tunnel configuration as part of installing this file.
