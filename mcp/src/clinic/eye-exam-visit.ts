import type { Appointment, Encounter } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../fhir/schedulingVisitType.js";
import {
  resolveVisitTypeCategoryByCode,
  resolveVisitTypeCategoryForEncounter,
} from "./clinic-summary.js";

export const EYE_EXAM_VISIT_TYPE_CATEGORY = "exams";

export async function isEyeExamVisit(
  encounter: Encounter,
  appointment: Appointment | undefined,
  fhir: Pick<MedplumClient, "read" | "search">,
): Promise<boolean> {
  const appointmentCategory = await resolveVisitTypeCategoryForEncounter(encounter, appointment, fhir);
  const legacyHistoricalEyeExam = isLegacyHistoricalEyeExam(encounter);
  if (appointmentCategory !== undefined) {
    return appointmentCategory === EYE_EXAM_VISIT_TYPE_CATEGORY || legacyHistoricalEyeExam;
  }
  if (legacyHistoricalEyeExam) return true;
  const directVisitType = encounter.type
    ?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.system === ODOS_VISIT_TYPE_SYSTEM && coding.code)
    ?.code;
  const directCategory = directVisitType
    ? await resolveVisitTypeCategoryByCode(directVisitType, fhir)
    : undefined;
  return directCategory === EYE_EXAM_VISIT_TYPE_CATEGORY;
}

function isLegacyHistoricalEyeExam(encounter: Encounter): boolean {
  // Older direct-start visits wrote the comprehensive category as Encounter.type, while the
  // retired payer-named Medicaid visit type was also historically treated as an eye exam.
  // Remove only after an independently evaluated category backfill proves every historical
  // Encounter resolves through its Appointment and HealthcareService category.
  return encounter.type?.some((concept) => concept.coding?.some((coding) =>
    coding.system === ODOS_VISIT_TYPE_SYSTEM &&
    (coding.code === "medicaid-exam" || coding.code === "comprehensive")
  )) === true;
}
