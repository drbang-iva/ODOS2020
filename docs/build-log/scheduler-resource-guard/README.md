# Scheduler resource guard — local proof

Date: 2026-07-26
Target: local synthetic ODOS stack only

## Guarded write

An authenticated `POST /scheduling/resources` attempted to create a provider Schedule with
`actorReference: "Practitioner/"`.

```text
HTTP 400
{"error":"Schedule provider actor must be a relative Practitioner/<id> reference with a valid FHIR id; got \"Practitioner/\"."}
```

The request was rejected before persistence.

## Rendered proof

- [Read containment](01-read-containment.png): a malformed Schedule seeded through the local
  FHIR API is absent from the bookable columns; the scheduler reports one hidden resource.
- [Integrity and staff-facing labels](02-integrity-no-raw-ids.png): Settings lists the malformed
  Schedule and an existing malformed Appointment without auto-repairing either. Resource controls
  use display names, and a rendered-text scan found no visible `Practitioner/<id>` or
  `Schedule/<id>` strings.
- [Clean deactivation](03-clean-resource-deactivated.png): the clean synthetic resource column is
  gone while the existing Dr. Bang column and guarded synthetic column remain.
- [Future-appointment guard](04-future-appointment-guard.png): deactivation reports one future
  appointment and requires either moving it or explicit acknowledgement.

After capture, the three proof Schedules and two proof Practitioners were made inactive and the
single proof Appointment was cancelled. The pre-existing malformed Appointment reported as
“Eric Bang” was not changed.
