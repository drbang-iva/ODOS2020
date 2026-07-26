# Section-group visibility browser proof

Date: 2026-07-26

Target: local synthetic Medplum stack at `127.0.0.1`; no practice or patient data was used.

Throwaway configuration:

- Group: `zz-test-workup`
- Prefix: `custom:zz-test-`
- Default visit-type category: `dry-eye`
- Section: `custom:zz-test-marker-proof726`

Observed:

1. The settings surface listed the active group, prefix, `dry-eye` default, and matching custom section.
2. A synthetic encounter linked to a `dry-eye` HealthcareService rendered **ZZ test marker** by default.
3. A synthetic encounter linked to an uncategorized comprehensive HealthcareService did not render **ZZ test marker**. The existing ungrouped **Pupils** section remained visible.
4. Selecting **ZZ test workup** from **Add section group…** rendered **ZZ test marker** immediately without a page reload.
5. A second uncategorized comprehensive encounter for the same synthetic patient did not render **ZZ test marker**. **Pupils** remained visible, confirming that the pull-in stayed encounter-local.

Screenshots:

- `01-settings-group-editor.png`
- `02-dry-eye-default-visible.png`
- `03-comprehensive-before-pull-in.png`
- `04-comprehensive-after-pull-in.png`

The supplied local clinician account could read the settings catalog but did not hold the practice-admin field-management grant. The throwaway group and section were therefore seeded through the local service account without changing the user's roles or account state. The clinician AccessPolicy also does not grant direct Appointment reads, so the existing encounter header shows its pre-existing linked-appointment warning in the encounter screenshots; the section-group resolver uses the trusted local service client only after proving the clinician can read the patient-compartment Encounter.
