# OSOD Observation Relationship Types

Verified in `data/code-bindings/v0.5-verification-ledger.md` row 44.

v0.5c uses `Observation.derivedFrom` when the APPEND workflow creates a new final Observation that adds successor clinical context to an existing final Observation.

`Observation.partOf` is not used for Observation-to-Observation append because FHIR R4 limits `partOf` targets to larger events such as Procedure or ImagingStudy. The original Observation remains unchanged; the new Observation points back to it through `derivedFrom`.
