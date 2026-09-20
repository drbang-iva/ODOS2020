export interface PatientEmailSettings {
  practiceName?: string;
  postalAddress?: string;
  phone?: string;
  subject?: string;
}

export class PatientEmailConfigurationError extends Error {}

export function patientEmailSubject(settings: Pick<PatientEmailSettings, "practiceName" | "subject">): string {
  const name = required(settings.practiceName, "practice name");
  const subject = required(settings.subject?.trim() || `Information from ${name}`, "neutral subject");
  if (/[\r\n]/.test(subject)) throw new PatientEmailConfigurationError("Patient email subject cannot contain header line breaks.");
  return subject;
}

export function patientEmailEnvelope(settings: PatientEmailSettings = {}): { subject: string; footer: string } {
  const subject = patientEmailSubject(settings);
  const name = required(settings.practiceName, "practice name");
  const address = required(settings.postalAddress, "practice postal address");
  const phone = required(settings.phone, "practice phone");
  return {
    subject,
    footer: `${name}\n${address}\n${phone}\nEmail is not a secure method of communication. Please do not send sensitive medical information by email. Call ${phone} for anything private or urgent.`,
  };
}

function required(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new PatientEmailConfigurationError(`Patient email is missing ${field} in practice settings.`);
  if (/[{}]|<[^>]*>/.test(text)) {
    throw new PatientEmailConfigurationError(`Patient email has an unresolved template variable in ${field}.`);
  }
  return text;
}
