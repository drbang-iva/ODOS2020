import type { ContactPoint, Patient } from "@medplum/fhirtypes";
import noTextableNumber from "../../../data/canonical-extensions/odos-no-textable-number.json" with { type: "json" };
import textableNumber from "../../../data/canonical-extensions/odos-textable-number.json" with { type: "json" };

export const ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL = noTextableNumber.url;
export const ODOS_TEXTABLE_NUMBER_EXTENSION_URL = textableNumber.url;

export type PatientPhoneUse = "mobile" | "home" | "work";
export type PatientTextableAnswer = "phone1" | "phone2" | "neither" | "";

export interface PatientDraftPhone {
  value: string;
  use: PatientPhoneUse | "other";
  sourceIndex: number | null;
}

export interface PatientTelecomSnapshot {
  now: string;
  loadedTextable: PatientTextableAnswer;
  entries: ReadonlyArray<{ system?: string; value?: string; use?: string }>;
}

export function validatePatientPhones(phones: readonly Pick<PatientDraftPhone, "value" | "use">[], textable: PatientTextableAnswer): Record<string, string> {
  const errors: Record<string, string> = {};
  phones.forEach((slot, index) => {
    const valid = /^\+?[\d\s().-]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(slot.value.trim())
      && slot.value.replace(/\D/g, "").length >= 7 && slot.value.replace(/\D/g, "").length <= 15;
    if (slot.value.trim() && !valid) errors[`phones.${index}.value`] = "Enter a valid phone number.";
    if (textable === `phone${index + 1}` && (!slot.value.trim() || !valid)) {
      errors[`phones.${index}.value`] = `Phone ${index + 1} was chosen as the texting number — enter it, choose another, or Neither.`;
    }
  });
  return errors;
}

export function createPatientPhone(slot: { value: string; use: PatientPhoneUse }): ContactPoint | undefined {
  const value = slot.value.trim();
  return value ? { system: "phone", use: slot.use, value } : undefined;
}

export function applyPatientTextableAnswer(patient: Patient, answer: ContactPoint | "neither"): Patient {
  const otherExtensions = patient.extension?.filter(e => e.url !== ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL);
  if (answer === "neither") {
    return { ...patient, extension: [...(otherExtensions ?? []), { url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] };
  }
  return {
    ...patient,
    extension: otherExtensions?.length === patient.extension?.length ? patient.extension : otherExtensions?.length ? otherExtensions : undefined,
    telecom: patient.telecom?.map(point => {
      const extensions = point.extension?.filter(e => e.url !== ODOS_TEXTABLE_NUMBER_EXTENSION_URL);
      if (point === answer) return { ...point, extension: [...(extensions ?? []), { url: ODOS_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true }] };
      if (extensions?.length === point.extension?.length) return point;
      return { ...point, extension: extensions?.length ? extensions : undefined };
    }),
  };
}
