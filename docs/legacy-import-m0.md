# Legacy Import M0 — Binary Transport and Identity

M0 installs transport, identity, recovery, and operator cleanup infrastructure. It
does not import any legacy patient data.

## Install

Generate the independent main and DR-drill storage signing keys before starting
either stack:

```bash
npm run generate-medplum-signing-keys
docker-compose up -d
export ODOS_OPERATOR_ACCESS_TOKEN="<temporary token copied from a human-authenticated local Medplum session>"
npm run setup-legacy-importer
unset ODOS_OPERATOR_ACCESS_TOKEN
```

The pinned `medplum/medplum-server:5.1.8` loader accepts comma-separated config
sources and deep-merges later sources. Both compose stacks therefore run
`file:/config/medplum.config.json,env`; the three `MEDPLUM_SIGNING_KEY*` values
come from ignored, mode-0600 files under `.odos/`. The tracked config values are
deliberately inert.

The compose `medplum-binary-init` service runs as root, recursively sets the
Binary volume to uid/gid `1000:1000`, and must complete before the Medplum server
starts. Repeated `up` operations are safe.

`setup-legacy-importer` creates one practice-scoped ClientApplication named
`odos-migration-importer`, binds its dedicated AccessPolicy, and writes the
client credentials to `.odos/migration-importer.env`. The importer is not a
superadmin. Its Binary rule has no search interaction; operator recovery never
attempts a Binary search. Setup accepts only the temporary operator access token;
it has no password parameter and performs no automated login. The AccessPolicy's
dedicated `migration-importer` tag and rules are reconciled together.

## Transport and recovery

`mcp/src/fhir/binary-upload.ts` is the shared raw transport seam for the legacy
importer and the later native-capture migration. It sends raw bytes to
`POST /fhir/R4/Binary`, requires `X-Security-Context`, and returns the canonical
`Binary/{id}` reference. A filename stays caller-side for `Media.content.title`.

The legacy wrapper:

1. Creates a `Media` in `preparation` with the source `fileNameNew` identifier.
2. Commits an open attempt row before each Binary POST.
3. Uploads and records the server-assigned Binary id without resolving the row.
4. Applies the migration tag with a version-aware full JSON PUT.
5. Reads the current Binary bytes and verifies byte count plus SHA-256.
6. Conditionally updates the Media to `completed` with `content.url`.
7. Resolves the attempt only after the completed Media and blob verify.

Recovery starts from `Media?identifier=...`. It handles no Media, incomplete
preparation Media, verified completed Media, and completed Media whose current
blob is missing or hash-mismatched.

## Operator sweep

The sweep begins only with open importer attempt rows. It resolves the FHIR table
list once, scans each table once for the batch, and normalizes relative, absolute,
versioned, and absolute-versioned Binary URLs to `{resourceType,id}`. A candidate
URL containing the Binary id that cannot be parsed confidently is treated as a
reference. A Media, DocumentReference, or any other resource reference is
reported and never deleted. Immediately before DELETE, the sweep repeats the
reference check; a new reference or any re-verification error aborts disposal.
Rows without a recorded Binary id remain open and visible but cannot nominate a
database resource.

Execution is deliberately two-step and must not overlap an import:

```bash
npm run sweep-legacy-import-binaries
export ODOS_SWEEP_ALLOW_DESTRUCTIVE=1
npm run sweep-legacy-import-binaries -- --execute
unset ODOS_SWEEP_ALLOW_DESTRUCTIVE
```

The explicit environment variable is required in addition to `--execute`, so a
production-localhost invocation cannot enter disposal mode by accident. There is
no cross-process import lock; stop all importer workers for the entire reviewed
disposal run.

## Acceptance

The acceptance gate is destructive by design. Run it only against a disposable
project containing no Patient resources except prior M0 synthetic-tagged
fixtures. Obtain two access tokens manually: an operator token for setup/admin
FHIR operations and a non-superadmin clinician token from the same project.
Neither token is written to disk.

```bash
export ODOS_OPERATOR_ACCESS_TOKEN="<temporary operator token>"
export ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN="<temporary ordinary-clinician token>"
export ODOS_ACCEPTANCE_ALLOW_DESTRUCTIVE=1
npm run verify-legacy-import-m0
unset ODOS_OPERATOR_ACCESS_TOKEN ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN ODOS_ACCEPTANCE_ALLOW_DESTRUCTIVE
```

Without the explicit opt-in the script refuses before authentication. With the
opt-in it additionally queries the target project and refuses if any
non-synthetic Patient exists. The disposal pass is scoped to the crash fixture's
single Binary id.

The gate uploads more than 1 MB, verifies canonical stored Media JSON and
migration tagging, restarts Medplum, proves a scoped ordinary clinician can
follow the rewritten URL with byte/hash equality, kills a worker after Binary
return but before the Media update, proves Media-search recovery, converts the
stranded synthetic Binary to the metadata-only failure shape, and proves the
operator sweep both enumerates and disposes it.

The two manual imaging surfaces and meibography remain inline in M0 and therefore
advertise the actual 1 MB limit. Native manual capture moves to the shared raw
transport in M1; meibography’s Observation attachment migration is a separate
follow-up.
