import type { ContactPoint, Patient } from "@medplum/fhirtypes";
import { buildCommsOptOutExtension, ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, ODOS_TEXTABLE_NUMBER_EXTENSION_URL } from "../../../mcp/src/comms/suppression-gate";

export const TELECOM_NOW = "2026-09-12T15:00:00.000Z";
export const NUMBERS = { M: "+12025550101", H: "+12025550102", W: "+12025550103", X: "+12025550104", T: "+12025550105", N: "+12025550106", S: "+12025550107", changed: "+12025550108" };
export const TEXTABLE_MARKER = { url: ODOS_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true };
export const REFUSAL_MARKER = { url: ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL, valueBoolean: true };
export const CONTACT_NOTE = { url: "urn:synthetic:contact-note", valueString: "Synthetic retained metadata" };

export function phonePoint(value: string, use?: ContactPoint["use"], extra: Partial<ContactPoint> = {}): ContactPoint {
  return { id: `synthetic-${value.replace(/\D/g, "")}`, system: "phone", value, ...(use === undefined ? {} : { use }), rank: 2, period: { start: "2026-01-01", end: "2027-01-01" }, extension: [CONTACT_NOTE], ...extra };
}

export function telecomFixture(name: string): Patient {
  const email: ContactPoint = { id: "synthetic-email", system: "email", use: "home", value: "synthetic@example.test", rank: 3, period: { start: "2026-01-01" }, extension: [CONTACT_NOTE] };
  const imported = [phonePoint(NUMBERS.H, "home"), email, phonePoint(NUMBERS.W, "work"), phonePoint(NUMBERS.M, "mobile")];
  const patient: Patient = {
    resourceType: "Patient", id: "synthetic-telecom", meta: { versionId: "3" },
    name: [{ use: "official", given: ["Synthetic"], family: "Telecom" }], birthDate: "1980-01-02", gender: "unknown",
    address: [{ use: "home", line: ["1 Synthetic Way"], city: "Synthetic", state: "SC", postalCode: "29601" }],
    extension: [buildCommsOptOutExtension("sms")], telecom: imported,
  };
  const mark = (point: ContactPoint) => { point.extension = [...point.extension!, { ...TEXTABLE_MARKER }]; };
  switch (name) {
    case "IMPORTED3": break;
    case "MARKED-W": mark(imported[2]); break;
    case "REFUSED+MARKED": mark(imported[2]); patient.extension!.push({ ...REFUSAL_MARKER }); break;
    case "TWO-MARKED": mark(imported[0]); mark(imported[3]); break;
    case "OLD-MARKED": patient.telecom = [phonePoint(NUMBERS.X, "old", { extension: [CONTACT_NOTE, TEXTABLE_MARKER] }), email, phonePoint(NUMBERS.M, "mobile")]; break;
    case "EXPIRED": patient.telecom = [phonePoint(NUMBERS.H, "home", { period: { end: "2026-01-01" } }), email, phonePoint(NUMBERS.M, "mobile")]; break;
    case "LEGACY-SMS": patient.telecom = [phonePoint(NUMBERS.S, undefined, { system: "sms" }), email, phonePoint(NUMBERS.H, "home")]; break;
    case "TEMP": patient.telecom = [phonePoint(NUMBERS.T, "temp"), email, phonePoint(NUMBERS.N)]; break;
    case "NONE": delete patient.telecom; break;
    case "EMPTY": patient.telecom = []; break;
    case "WHITESPACE": imported[3].value = ` ${NUMBERS.M} `; break;
    case "ABSENT": patient.telecom = [{ rank: 4, period: { end: "2026-01-01" }, extension: [CONTACT_NOTE] }, ...imported, { system: "phone", value: "   ", rank: 5, extension: [CONTACT_NOTE] }]; break;
    default: throw new Error(`Unknown synthetic fixture ${name}`);
  }
  return structuredClone(patient);
}

export const TELECOM_FIXTURES = ["IMPORTED3", "MARKED-W", "REFUSED+MARKED", "TWO-MARKED", "OLD-MARKED", "EXPIRED", "LEGACY-SMS", "TEMP", "NONE", "EMPTY", "WHITESPACE", "ABSENT"];
