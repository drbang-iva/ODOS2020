# Mandate 7 Eye Data Reference

The authoritative mandate lives in `performance-od/reference/domain/open-source-od/mandates.md`.
This in-repo note is only a pointer for OSOD code work.

Relevant implementation rules for OSOD:

- Raw ophthalmic assets must be preserved.
- Device metadata must be stored when available.
- DICOM studies must map to `ImagingStudy` when DICOM context exists.
- Non-DICOM PDFs/images must map to `DocumentReference`, `Media`, and `Binary` as appropriate.
- Structured values extracted from sources must become `Observation.component[]` values or linked `Observation` resources.
- Grouped reports must use `DiagnosticReport`.
- Parser-created data must have `Provenance`.
- Vendor parser plugins must follow a common output contract.
- No future device import may be file-only if structured values are extractable.
