import type { FhirAuditContext, FhirAuditRecorder } from "../src/fhir-client.js";

export const TEST_FHIR_AUDIT_RECORDER: FhirAuditRecorder = {
  async record(_row, operation) {
    return operation();
  },
  async recordDenied() {},
};

export const TEST_FHIR_AUDIT_CONTEXT: FhirAuditContext = {
  actorId: "test-client",
  actorRole: "system",
};
