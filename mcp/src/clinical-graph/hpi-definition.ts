import { odosConcept } from "../fhir/ophthalmology/extensions.js";
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

export function buildHpiFindingDefinition(
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  return buildClinicalFindingDefinition({
    stableKey: HPI_STABLE_KEY,
    display: "History narrative and review of systems",
    sectionKey: "hpi",
    anatomyTarget: "other",
    valueSchema: {
      type: "hpi-ros-panel",
      perEye: false,
      terminologyStatus: {
        status: "MANDATE-14-DEFERRED",
        note: "Chief complaint, HPI, and ROS use ODOS-local coding only. External terminology alignment requires current two-primary-source verification before external codes are introduced.",
      },
      fields: {
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
    fhirObservationCode: odosConcept(HPI_STABLE_KEY, "History narrative and review of systems"),
    allowDiagnosisMapping: false,
    notBillReady: true,
    provenance,
  });
}
