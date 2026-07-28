# Legacy Import M0 — Binary Transport and Identity

M0 installs transport, identity, recovery, and operator cleanup infrastructure. It
does not import any legacy patient data.

## Install

Generate the independent main and DR-drill storage signing keys before starting
either stack:

```bash
npm run generate-medplum-signing-keys
docker-compose up -d
npm run setup-legacy-importer
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
attempts a Binary search.

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

Dry-run first:

```bash
npm run sweep-legacy-import-binaries
```

Execute only after reviewing the JSON report:

```bash
npm run sweep-legacy-import-binaries -- --execute
```

The sweep begins only with open importer attempt rows. For each recorded Binary
id, it scans current and historical FHIR resource JSON in Postgres for an exact
`Attachment.url`-shape `Binary/{id}` value. A Media, DocumentReference, or any
other resource reference is reported and never deleted. A candidate with no
reference can be deleted through the importer’s Binary-only delete grant; the
attempt row then resolves as disposed. Rows without a recorded Binary id remain
open and visible but cannot nominate any database resource.

## Acceptance

Run against the local synthetic stack:

```bash
npm run verify-legacy-import-m0
```

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
