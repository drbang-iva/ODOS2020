import { osodConcept } from "../fhir/ophthalmology/extensions.js";
import {
  buildClinicalFindingDefinition,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
} from "./glaucoma-suspect.js";

export const HPI_STABLE_KEY = "hpi_ros";

export const HPI_ROS_OPTIONS = [
  { code: "vision-changes", display: "Vision changes", category: "eye" },
  { code: "eye-pain", display: "Eye pain", category: "eye" },
  { code: "floaters-flashes", display: "Floaters / flashes", category: "eye" },
  { code: "redness", display: "Redness", category: "eye" },
  { code: "discharge", display: "Discharge", category: "eye" },
  { code: "diabetes", display: "Diabetes", category: "general" },
  { code: "hypertension", display: "Hypertension", category: "general" },
] as const;

export const HPI_FIELDS = [
  ["location", "Location"],
  ["quality", "Quality"],
  ["severity", "Severity"],
  ["duration", "Duration"],
  ["timing", "Timing"],
  ["context", "Context"],
  ["modifyingFactors", "Modifying factors"],
  ["associatedSignsSymptoms", "Associated signs / symptoms"],
] as const;

export function buildHpiFindingDefinition(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    stableKey: HPI_STABLE_KEY,
    display: "Chief complaint, HPI, and review of systems",
    sectionKey: "hpi",
    anatomyTarget: "other",
    valueSchema: {
      type: "hpi-ros-panel",
      perEye: false,
      terminologyStatus: {
        status: "MANDATE-14-DEFERRED",
        note: "Chief complaint, HPI, and ROS use OSOD-local coding only. External terminology alignment requires current two-primary-source verification before external codes are introduced.",
      },
      fields: {
        chiefComplaint: { display: "Chief complaint", type: "text", maximumLength: 2000 },
        ...Object.fromEntries(HPI_FIELDS.map(([key, display]) => [
          key,
          { display, type: "text", maximumLength: 2000 },
        ])),
        reviewOfSystems: {
          display: "Review of systems",
          type: "tri-state-list",
          allowCreate: true,
          createCategory: "general",
          options: HPI_ROS_OPTIONS.map((option) => ({ ...option, active: true })),
        },
      },
    },
    sourceStatus: "verified-seed",
    fhirObservationCode: osodConcept(HPI_STABLE_KEY, "Chief complaint, HPI, and review of systems"),
    allowDiagnosisMapping: false,
    notBillReady: true,
    provenance,
  });
}
