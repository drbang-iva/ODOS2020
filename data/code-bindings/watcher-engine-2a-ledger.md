# Watcher engine 2A FHIR R4 verification ledger

Access date: 2026-08-30

| Claim | ODOS use | Primary source 1 | Primary source 2 | Status |
|---|---|---|---|---|
| FHIR R4 Task represents a human or automated activity and tracks it through completion. | Watcher alert persistence | https://hl7.org/fhir/R4/task.html | https://hl7.org/fhir/R4/task-definitions.html | verified |
| `Task.for` identifies the beneficiary, `Task.focus` identifies what the task acts on, and `Task.owner` identifies the responsible performer. | W1 patient, Appointment, and owner queue | https://hl7.org/fhir/R4/task.html | https://hl7.org/fhir/R4/task-definitions.html | verified |
| `Task.status` is required; `Task.statusReason` explains held, failed, refused, or other non-default status; `Task.businessStatus` carries workflow-specific substate. | Active, snoozed, resolved, dismissed, and severity data | https://hl7.org/fhir/R4/task.html | https://hl7.org/fhir/R4/task-definitions.html | verified |
| Conditional create uses `If-None-Exist` search parameters, creates on zero matches, reuses one match, and refuses multiple matches. | Idempotent watcher condition creation by exact identifier | https://hl7.org/fhir/R4/http.html#ccreate | https://hl7.org/fhir/R4/search.html#token | verified |

No SNOMED CT, ICD-10-CM, CPT, HCPCS, LOINC, RxNorm, NDC, or UCUM code is introduced by this slice. Watcher ids, severity, action, and dismissal values are local workflow vocabulary.
