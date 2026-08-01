import type { AccessPolicy } from "@medplum/fhirtypes";

export const MIGRATION_IMPORTER_NAME = "odos-migration-importer";
export const MIGRATION_IMPORTER_POLICY_NAME = "ODOS Migration Importer";
export const MIGRATION_IMPORTER_POLICY_TAG_SYSTEM =
  "https://odos2020.com/tags/access-policy";
export const MIGRATION_IMPORTER_POLICY_TAG_CODE = "migration-importer";
export const MIGRATION_TAG_SYSTEM = "https://odos2020.com/tags/migration";
export const MIGRATION_TAG_CODE = "eyefinity-import";

const SEARCH_READ_CREATE_UPDATE = ["search", "read", "create", "update"] as const;
const SEARCH_READ_CREATE = ["search", "read", "create"] as const;

export function buildMigrationImporterAccessPolicy(projectId?: string): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    name: MIGRATION_IMPORTER_POLICY_NAME,
    meta: {
      ...(projectId ? { project: projectId } : {}),
      tag: [{
        system: MIGRATION_IMPORTER_POLICY_TAG_SYSTEM,
        code: MIGRATION_IMPORTER_POLICY_TAG_CODE,
      }],
    },
    resource: [
      ...[
        "Patient",
        "Appointment",
        "Encounter",
        "Media",
        "Observation",
        "VisionPrescription",
        "Coverage",
        "Practitioner",
        "Provenance",
      ].map((resourceType) => ({
        resourceType,
        interaction: [...SEARCH_READ_CREATE_UPDATE],
      })),
      ...[
        "Condition",
        "AllergyIntolerance",
        "MedicationStatement",
        "Procedure",
      ].map((resourceType) => ({
        resourceType,
        interaction: [...SEARCH_READ_CREATE],
      })),
      {
        resourceType: "Organization",
        interaction: ["search", "read", "create"],
      },
      {
        resourceType: "Binary",
        interaction: ["read", "create", "delete"],
      },
      {
        resourceType: "Binary",
        interaction: ["update"],
        readonlyFields: [
          "id",
          "implicitRules",
          "language",
          "contentType",
          "securityContext",
          "data",
        ],
      },
      {
        resourceType: "Location",
        interaction: ["search", "read"],
      },
    ],
  };
}
