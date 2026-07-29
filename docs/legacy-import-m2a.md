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

Passing output includes HTTP status `200` for both Patient searches, the clinician's Patient,
Encounter, Media, and Observation reads, and the front desk's Patient, Coverage, and Encounter
reads. It also requires HTTP `403` for the front desk's same Media and Observation resources.
If a status check fails, the command prints the completed transcript before the failure.
