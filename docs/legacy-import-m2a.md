# Legacy import M2a — one-patient adoption and chart reachability

M2a imports exactly one typical Eyefinity patient, records a junk-row rejection, and grants
the imported chart to exactly two preselected memberships. It does not import Appointments or
Encounters and it does not run over the full cohort.

The clinical-data and authorization actors remain separate:

- `import-legacy-patient-m2a` uses the scoped M0 importer ClientApplication.
- `grant-migrated-patient-access` uses a human-provisioned, short-lived
  `ODOS_OPERATOR_ACCESS_TOKEN`.
- The migration importer AccessPolicy and the native provider-assignment endpoint are unchanged.

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
ODOS_OPERATOR_ACCESS_TOKEN='<short-lived token>' \
npm run grant-migrated-patient-access -- \
  --run-id '<run id>' \
  --patient 'Patient/<id>' \
  --clinician-profile 'Practitioner/<id>' \
  --front-desk-profile 'Practitioner/<id>'
```

Both commands default to `/Users/iris/Migration/importer-state/legacy-import.sqlite`.
Per-run Markdown reports are written under `importer-state/reports/`. Reports and ledger data
stay on Iris.

Re-run both commands with a new run id against the same source. The Patient and all three
authorization operations must report `skipped`; no duplicate Patient or access entry is
created.

## Ordinary-role reachability gate

The gate accepts only ordinary clinician and front-desk tokens. It rejects superadmin
sessions and verifies each token resolves to the expected Practitioner:

```sh
ODOS_ACCEPTANCE_CLINICIAN_ACCESS_TOKEN='<ordinary clinician token>' \
ODOS_ACCEPTANCE_FRONT_DESK_ACCESS_TOKEN='<ordinary front-desk token>' \
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
Encounter, and Media reads, and the front desk's Patient, Coverage, and Encounter reads. It
also requires HTTP `403` for the front desk's Media and Observation reads.
