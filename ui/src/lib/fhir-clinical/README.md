# FHIR Clinical Mirror

This directory mirrors selected builders from `osod/mcp/src/fhir/` so the browser UI can compose the same FHIR resources as MCP tools without importing MCP runtime code.

The MCP directory is the source of truth until the v0.5 monorepo/shared-package refactor. When one of these files changes in MCP, copy the matching file here, keep the top-of-file mirror comment, and run `mcp/tests/builder-mirror-parity.test.ts`.

Do not add Medplum SDK imports here. UI code stays on `@medplum/fhirtypes` plus plain FHIR REST.
