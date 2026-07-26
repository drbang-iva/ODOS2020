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
2. A correctly coded eyecare Encounter linked to a readable practice Appointment and a `dry-eye` HealthcareService rendered **ZZ test marker** by default. The in-frame context identified the Encounter, `eyecare` discipline, `dry-eye` category, default group, and no pull-in.
3. A separate correctly coded eyecare Encounter linked to a practice Appointment created through the scheduler and an uncategorized comprehensive HealthcareService did not render **ZZ test marker**. **Pupils** remained visible and the Appointment banner loaded without a 404.
4. Selecting **ZZ test workup** from **Add section group…** rendered **ZZ test marker** immediately without a page reload. The context changed from `Pulled in none` to `Pulled in ZZ test workup`.
5. The bottom of the comprehensive eyecare spine ended at **Assessment & Plan** with no **AESTHETICS** group or aesthetics procedure section.
6. The browser sequence add → deactivate → remove → reactivate left the Encounter at `Pulled in none`; **ZZ test marker** did not resurrect and **Pupils** remained visible.
7. With only the section-group catalog forced to return HTTP 500, the chart displayed the visibility warning while leaving both **Pupils** and the otherwise grouped **ZZ test marker** visible.

Screenshots:

- `01-settings-group-editor.png`
- `02-dry-eye-default-visible.png`
- `03-comprehensive-before-pull-in.png`
- `04-comprehensive-after-pull-in.png`
- `05-eyecare-no-aesthetics.png`
- `06-reactivated-no-resurrection.png`
- `07-section-groups-fail-open.png`

The local clinician account could read the settings catalog but did not hold the practice-admin field-management grant. Throwaway group activation/deactivation was therefore performed through the local service account without changing roles or account state; encounter pull-in and removal were performed in the browser. The HTTP 500 proof used a temporary local proxy that failed only the section-group catalog and forwarded every other request to the live local MCP server.
