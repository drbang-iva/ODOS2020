# Legacy import M2a — one-patient adoption and chart reachability

M2a imports exactly one typical Eyefinity patient, records a junk-row rejection, and grants
the imported chart to exactly two preselected memberships. It does not import Appointments or
Encounters and it does not run over the full cohort.

The clinical-data and authorization actors remain separate:

- `import-legacy-patient-m2a` uses the scoped M0 importer ClientApplication.
- `grant-migrated-patient-access` uses a human-provisioned, short-lived
  `ODOS_OPERATOR_ACCESS_TOKEN`.
- The migration importer AccessPolicy and the native provider-assignment endpoint are unchanged.

## Local environment file

Keep migration credentials and the Iris state path in the gitignored local environment file.
Do not put access tokens in an inline shell assignment or command argument:

```sh
mkdir -p .odos
touch .odos/migration-importer.env
chmod 600 .odos/migration-importer.env
```

Open `.odos/migration-importer.env` in a local editor and set the values needed for the step:

```dotenv
MEDPLUM_BASE_URL=http://localhost:8103
ODOS_M2A_STATE_DIR=/Users/iris/Migration/importer-state
ODOS_OPERATOR_ACCESS_TOKEN=<short-lived practice operator token>
ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN=<ordinary clinician token>
ODOS_ACCEPTANCE_FRONT_DESK_ACCESS_TOKEN=<ordinary front-desk token>
```

Both M2a commands load this file with `--env-file-if-exists`. Keep it at mode `0600`, rotate
the short-lived tokens after the proof, and never commit or paste the file.

## Source manifest

Keep the manifest on Iris. Never commit it. It contains one selected EPM row, the matching EHR
person row, and one or more source rows that the approved junk rules must reject:

```json
{
  "epm": {
    "sourceKey": "<opaque EPM patient id>",
    "firstName": "<local PHI>",
    "lastName": "<local PHI>",
    "birthDate": "YYYY-MM-DD",
    "gender": "unknown"
  },
  "ehr": {
    "sourceKey": "<opaque EHR ptSrNo>",
    "firstName": "<local PHI>",
    "lastName": "<local PHI>",
    "birthDate": "YYYY-MM-DD"
  },
  "junkRows": [
    {
      "sourceSystem": "ehr",
      "sourceKey": "<opaque rejected row key>",
      "firstName": "<local PHI>",
      "lastName": "<local PHI>",
      "birthDate": "9999-12-31"
    }
  ]
}
```

The selected EPM and EHR rows must match on normalized
`firstName + lastName + birthDate`. The script refuses EPM source `6499570` and EHR source
`969`, the operator's test-data-heavy chart.

## One-patient run

From the ODOS checkout on Iris:

```sh
npm run import-legacy-patient-m2a -- \
  --manifest /Users/iris/Migration/importer-state/m2a-source.json
```

Use the returned run id and Patient reference for the provisioning step:

```sh
npm run grant-migrated-patient-access -- \
  --run-id '<run id>' \
  --patient 'Patient/<id>' \
  --clinician-profile 'Practitioner/<id>' \
  --front-desk-profile 'Practitioner/<id>'
```

With `ODOS_M2A_STATE_DIR` set as above, both commands use
`/Users/iris/Migration/importer-state/legacy-import.sqlite`. Without it, the safe local fallback
is `~/.odos/legacy-import-m2a/legacy-import.sqlite`.
Per-run Markdown reports are written under `importer-state/reports/`. Reports and ledger data
stay on Iris.

Re-run both commands with a new run id against the same source. The Patient and all three
authorization operations must report `skipped`; no duplicate Patient or access entry is
created.

The generalPractitioner update and the clinician and front-desk membership grants are three
independent, idempotent writes. If provisioning fails after one or two writes succeed, those
changes remain in place. Rerun the failed provisioning command until it completes; already
applied writes are reported as `skipped`, and the remaining writes converge without duplication.

## M2b-1 Appointment and Encounter continuation

M2b-1 runs after a successful M2a run and imports one selected patient's Appointments plus
Encounter visit days. It reads the entire Greenwood `AppointmentsExport` first so that exact
duplicates and composite-key collisions are handled before any selected-patient FHIR write.
The collision rules are verified only for the `00127314` export; another office export is
rejected until its full-file collision shape is measured.

Keep the M2b-1 manifest beside the source data on Iris. `visitTypeMap` is explicit because
legacy appointment labels are not ODOS visit-type codes and must never be silently recoded:

```json
{
  "sourceOfficeNumber": "00127314",
  "patientReference": "Patient/<migrated patient id>",
  "patientUid": "<AppointmentsExport PatientUID>",
  "epmPatientId": "<AppointmentsExport PatientID>",
  "ehrPatientId": "<exam-source ptSrNo>",
  "organizationReference": "Organization/<practice id>",
  "locationReference": "Location/<facility id>",
  "visitTypeMap": {
    "Office Visit": {
      "code": "office-visit",
      "display": "Office Visit (Medical)"
    }
  }
}
```

Run it with the same SQLite state directory after the Patient and access grants are complete.
M2b-1 starts its own ledger run; `--run-id` is optional when an operator-selected id is useful:

```sh
npm run import-legacy-visits-m2b1 -- \
  --manifest /Users/iris/Migration/importer-state/m2b1-source.json \
  --appointments '/Users/iris/Migration/extract-scoped/EPM data/00127314--AppointmentsExport-Thu-06-18-2026.csv' \
  --exams /Users/iris/Migration/all-exams.tsv
```

The command prints the full-file source row, exact-duplicate, collision, cancel-resolution,
all-cancelled-skip, and queued-collision counts before the selected-patient action totals and
report path. Byte-identical duplicates and collision groups containing only cancelled rows are
recorded through `junk_rejections`; all-cancelled groups produce no Appointment. A composite
collision with multiple active rows is written to `ambiguity_queue`; no row number, hash, or
other manufactured per-row key is used. Multi-appointment visit days are likewise queued and
produce no Encounter until M2b-2 adjudication.

## Ordinary-role reachability gate

The gate accepts only ordinary clinician and front-desk tokens. It rejects superadmin
sessions and verifies each token resolves to the expected Practitioner:

```sh
npm run verify-legacy-import-m2a -- \
  --clinician-profile 'Practitioner/<id>' \
  --front-desk-profile 'Practitioner/<id>' \
  --patient 'Patient/<id>' \
  --encounter 'Encounter/<id>' \
  --media 'Media/<id>' \
  --coverage 'Coverage/<id>' \
  --observation 'Observation/<id>'
```

## Reproducible live gate harness

The tracked live harness provisions a synthetic gate practice, creates real ordinary
clinician and front-desk sessions, exercises the full reachability matrix, and reruns the
patient import and access grants to prove convergence. It is safe to run alongside prior gate
projects because role-policy resolution uses the gate practice administrator's project-scoped
session and passes the setup-created project id into importer bootstrap.

Without an explicit project id, importer bootstrap retains the single-practice behavior and
discovers the one ODOS practice project across the database. A database hosting multiple ODOS
practice projects must provide `practiceProjectId` to `setupLegacyImporter`, or set
`ODOS_PRACTICE_PROJECT_ID` when running `npm run setup-legacy-importer`. The named project is
verified to exist and to carry the canonical ODOS Clinician policy; an invalid or noncanonical
target fails without falling back to database-wide discovery.

Put the harness configuration in the checkout's gitignored `.env` file. Never provide these
values as inline command assignments:

```dotenv
GATE_HEAD_SHA=<full 40-character SHA of the checked-out head>
MEDPLUM_BASE_URL=http://localhost:8103
ODOS_POSTGRES_URL=postgresql://<local practice database>
ODOS_M2A_STATE_DIR=/Users/iris/Migration/importer-state/m2a-gate
MEDPLUM_ADMIN_EMAIL=<local Medplum service administrator>
MEDPLUM_ADMIN_PASSWORD=<local Medplum service administrator password>
```

Keep `.env` at mode `0600`. From the checkout at the exact `GATE_HEAD_SHA`, run:

```sh
npm run gate:legacy-import-m2a
```

During the run, the harness writes live operator, clinician, and front-desk bearer tokens
to the gitignored `.odos/migration-importer.env` file at mode `0600`. Normal success and
handled failure paths remove that file automatically. If the process is interrupted or
force-terminated, remove `.odos/migration-importer.env` before continuing.

The command loads `.env` through the package script. Its transcript records the exact head,
first- and second-run action outcomes, ordinary-role allow/deny statuses, and the final
`LEGACY_IMPORT_M2A_REACHABILITY PASS` marker.

Passing output includes HTTP status `200` for both Patient searches, the clinician's Patient,
Encounter, Media, and Observation reads, and the front desk's Patient, Coverage, and Encounter
reads. It also requires HTTP `403` for the front desk's same Media and Observation resources.
If a status check fails, the command prints the completed transcript before the failure.
