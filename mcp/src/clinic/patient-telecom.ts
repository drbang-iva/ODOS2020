import type { ContactPoint, Patient, Person, RelatedPerson } from "@medplum/fhirtypes";
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
  entries: ReadonlyArray<ContactPoint>;
}

export function validatePhones(phones: readonly Pick<PatientDraftPhone, "value" | "use">[], textable: PatientTextableAnswer): Record<string, string> {
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

export function createPhone(slot: { value: string; use: PatientPhoneUse }): ContactPoint | undefined {
  const value = slot.value.trim();
  return value ? { system: "phone", use: slot.use, value } : undefined;
}

export type PhoneResource = Patient | Person | RelatedPerson;
export type PhoneDraft = { phones: [PatientDraftPhone, PatientDraftPhone]; textable: PatientTextableAnswer };

export function applyTextableAnswer<T extends PhoneResource>(patient: T, answer: ContactPoint | "neither"): T {
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

export const applyPatientTextableAnswer = (patient: Patient, answer: ContactPoint | "neither"): Patient => applyTextableAnswer(patient, answer);

export function emptyPatientPhone(): PatientDraftPhone {
  return { value: "", use: "mobile", sourceIndex: null };
}

export function phoneDraft(patient: PhoneResource, now = new Date().toISOString()): PhoneDraft {
  const time = Date.parse(now);
  const marked = (point: NonNullable<Patient["telecom"]>[number]) => point.extension?.some(
    entry => entry.url === ODOS_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true,
  ) ?? false;
  const priority = (point: NonNullable<Patient["telecom"]>[number]) => marked(point) ? 0 : point.system === "sms" ? 1 : point.use === "mobile" ? 2 : 3;
  const candidates = (patient.telecom ?? []).map((point, sourceIndex) => ({ point, sourceIndex })).filter(({ point }) =>
    (point.system === "sms" || point.system === "phone")
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.start || Date.parse(point.period.start) <= time)
    && (!point.period?.end || Date.parse(point.period.end) > time))
    .sort((a, b) => priority(a.point) - priority(b.point) || a.sourceIndex - b.sourceIndex);
  const slot = (index: number): PatientDraftPhone => {
    const candidate = candidates[index];
    if (!candidate) return emptyPatientPhone();
    const { point, sourceIndex } = candidate;
    return { value: point.value!, use: point.use === "mobile" || point.use === "home" || point.use === "work" ? point.use : "other", sourceIndex };
  };
  return {
    phones: [slot(0), slot(1)],
    textable: patient.extension?.some(entry => entry.url === ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL && entry.valueBoolean === true)
      ? "neither" : candidates[0] && marked(candidates[0].point) ? "phone1" : candidates[1] && marked(candidates[1].point) ? "phone2" : "",
  };
}

function freezeTelecomValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeTelecomValue);
    Object.freeze(value);
  }
  return value;
}

// ContactPoints contain FHIR JSON values; compare their structure without depending on key order.
function equalTelecomValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && equalTelecomValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function telecomSnapshot(patient: PhoneResource, now: string): PatientTelecomSnapshot {
  return Object.freeze({
    now,
    loadedTextable: phoneDraft(patient, now).textable,
    entries: freezeTelecomValue(structuredClone(patient.telecom ?? [])),
  });
}


export function applyPhoneDraft<T extends PhoneResource>(patient: T, draft: PhoneDraft, snapshot?: PatientTelecomSnapshot): T {
  const errors = validatePatientPhones(draft.phones, draft.textable);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(" "));
  const phoneEntries = new Map<PatientDraftPhone, NonNullable<Patient["telecom"]>[number]>();
  for (const slot of draft.phones) {
    if (slot.sourceIndex === null) continue;
    const original = snapshot?.entries[slot.sourceIndex];
    const held = patient?.telecom?.[slot.sourceIndex];
    if (!original || !held || !equalTelecomValue(held, original)) {
      throw new Error("Contact information changed on the server. Reload before saving.");
    }
  }
  let telecom = (patient?.telecom ?? []).flatMap((point, index) => {
    const slot = draft.phones.find(phone => phone.sourceIndex === index);
    if (!slot) return [point];
    if (!slot.value.trim()) return [];
    const original = snapshot!.entries[index];
    const useChanged = slot.use !== "other" && slot.use !== original.use;
    const changed = slot.value !== original.value || useChanged;
    const entry = changed ? { ...point, value: slot.value.trim(), ...(useChanged ? { use: slot.use as PatientPhoneUse } : {}) } : point;
    phoneEntries.set(slot, entry);
    return [entry];
  });
  for (const slot of draft.phones) {
    if (slot.sourceIndex !== null) continue;
    const entry = createPatientPhone({ value: slot.value, use: slot.use as PatientPhoneUse });
    if (entry) { telecom.push(entry); phoneEntries.set(slot, entry); }
  }
  let result = { ...patient, telecom: patient.telecom === undefined && !telecom.length ? undefined : telecom };
  if (draft.textable !== (snapshot?.loadedTextable ?? "") && draft.textable) {
    const answer = draft.textable === "neither" ? "neither" : phoneEntries.get(draft.phones[draft.textable === "phone1" ? 0 : 1])!;
    result = applyTextableAnswer(result, answer);
  }
  return result;
}

export const validatePatientPhones = validatePhones;
export const createPatientPhone = createPhone;
