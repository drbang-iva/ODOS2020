# Mandate 14 — E1

Access date for both primary sources and executed requests: 2026-09-14.

| Claim | Primary source 1 | Primary source 2 | Executed result |
| --- | --- | --- | --- |
| Person supports the string `name` parameter over Person.name | https://hl7.org/fhir/R4/person.html#search | https://raw.githubusercontent.com/medplum/medplum/9b1bd92/packages/definitions/src/fhir/r4/search-parameters.json — Person-name; the same definition was extracted directly from the pinned image into person-name-searchparameter.json | Seven HTTP 200 searches; family and given both narrow. Tested prefixes match, upper/lower case match identically, a non-prefix substring and absent value return no entries. |

Sources agree on the parameter and HumanName expression. Prefix/case behavior is an executed observation of Medplum 5.1.30-9b1bd92, not a universal guarantee inferred from the definition. The ODOS exact filter remains required. Evidence: e1-http.json, e1-results.json, e1-output.json and live-runtime.json.

The first probe assertion incorrectly treated an omitted empty Bundle.entry as a nonempty result; its request returned HTTP 200 with no entries. The probe was corrected to interpret absent entry as an empty list and re-executed successfully without creating more Persons. No application code or existing test was changed for that instrument correction.
