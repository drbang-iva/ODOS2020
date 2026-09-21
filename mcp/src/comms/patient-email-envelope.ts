export interface PatientEmailSettings {
  practiceName?: string;
  postalAddress?: string;
  phone?: string;
  subject?: string;
}

export class PatientEmailConfigurationError extends Error {}

export function patientEducationEmailBody(input: {
  practiceName?: string;
  phone?: string;
  title: string;
  url: string;
}): string {
  const practiceName = required(input.practiceName, "practice name");
  const phone = required(input.phone, "practice phone");
  const title = input.title.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!title) throw new PatientEmailConfigurationError("Patient email catalog item is missing handout title.");
  return [
    "Hello,",
    "",
    `${practiceName} is sending you this information: ${title}`,
    "",
    input.url,
    "",
    `If you have any questions, please call us at ${phone}.`,
  ].join("\n");
}

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
