import { useEffect, useMemo, useState } from "react";
import type { Patient, RelatedPerson } from "@medplum/fhirtypes";
import {
  dispatchEducation,
  listEducation,
  type EducationContentItem,
  type EducationDispatchInput,
  type EducationDispatchResult,
  type SmsOptOutState,
} from "../../lib/communications-client";
import { fhir } from "../../lib/fhir";
import {
  CONSENT_AUTHORITY_EXTENSION_URL,
  RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL,
  isMinorOn,
} from "../../lib/patient-identity";
import { ExamEntrySheet } from "../charting/ExamEntrySheet";
import { SmsOptOutControl } from "../patient/SmsOptOutControl";
import { SmsOptOutErrorBoundary } from "../patient/SmsOptOutErrorBoundary";

const MARKETING_CONSENT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-comms-marketing-consent";

export interface EngageSheetApi {
  listEducation(query: { dxCode?: string; channel?: "sms" | "email" | "print" }): Promise<EducationContentItem[]>;
  dispatchEducation(input: EducationDispatchInput): Promise<EducationDispatchResult>;
  listConsentGuardians(patientReference: string): Promise<RelatedPerson[]>;
}

export interface EngageDiagnosis {
  reference: string;
  code: string;
  display: string;
}

interface PendingSend {
  item: EducationContentItem;
  channel: "sms" | "email" | "print";
}

const defaultApi: EngageSheetApi = {
  listEducation,
  dispatchEducation,
  async listConsentGuardians(patientReference) {
    const bundle = await fhir.search<RelatedPerson>("RelatedPerson", {
      patient: patientReference,
      active: "true",
      _count: "50",
    });
    return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : [])
      .filter(hasConsentAuthority);
  },
};

export function EngageSheet({
  open,
  patient,
  encounterReference,
  diagnosis,
  onClose,
  api = defaultApi,
  chartDispatchLane = "staff_switchable",
  idempotencyKeyFactory = defaultIdempotencyKey,
}: {
  open: boolean;
  patient: Patient;
  encounterReference?: string;
  diagnosis?: EngageDiagnosis;
  onClose: () => void;
  api?: EngageSheetApi;
  chartDispatchLane?: "locked_clinical" | "staff_switchable";
  idempotencyKeyFactory?: () => string;
}) {
  const patientReference = `Patient/${patient.id}`;
  const [items, setItems] = useState<EducationContentItem[]>([]);
  const [guardians, setGuardians] = useState<RelatedPerson[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingSend>();
  const [lane, setLane] = useState<"clinical" | "frontdesk">("clinical");
  const [overrideMode, setOverrideMode] = useState(false);
  const [overrideValue, setOverrideValue] = useState("");
  const [alsoUpdateChart, setAlsoUpdateChart] = useState(false);
  const [smsState, setSmsState] = useState<SmsOptOutState>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const minor = patient.birthDate ? isMinorOn(patient.birthDate, today()) : false;
  const marketingConsent = hasMarketingConsent(patient);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPending(undefined);
    setStatus(undefined);
    setError(undefined);
    Promise.all([
      api.listEducation(diagnosis?.code ? { dxCode: diagnosis.code } : {}),
      minor ? api.listConsentGuardians(patientReference) : Promise.resolve([]),
    ]).then(([content, relatedPeople]) => {
      if (!active) return;
      setItems(content.filter((item) => item.audience === "patient"));
      setGuardians(relatedPeople);
      const primary = relatedPeople.find(isPrimaryGuardian) ?? relatedPeople[0];
      setSelectedRecipients(primary?.id ? [`RelatedPerson/${primary.id}`] : [patientReference]);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Education could not load.");
    });
    return () => { active = false; };
  }, [api, diagnosis?.code, minor, open, patientReference]);

  const recipients = useMemo(() => {
    return minor ? guardians.map(guardianRecipient) : [patientRecipient(patient)];
  }, [guardians, minor, patient]);

  const beginSend = (item: EducationContentItem, channel: PendingSend["channel"]) => {
    setPending({ item, channel });
    setLane(chartDispatchLane === "locked_clinical"
      ? "clinical"
      : item.laneHint === "retail" ? "frontdesk" : "clinical");
    setOverrideMode(false);
    setOverrideValue("");
    setAlsoUpdateChart(false);
    setStatus(undefined);
    setError(undefined);
  };

  const confirmSend = async () => {
    if (!pending) return;
    const chosenRecipients = recipients.filter((candidate) => selectedRecipients.includes(candidate.reference));
    if (chosenRecipients.length === 0) {
      setError("Choose a recipient before sending education.");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      const results: EducationDispatchResult[] = [];
      for (const recipient of pending.channel === "print" ? [chosenRecipients[0]!] : chosenRecipients) {
        const value = overrideMode ? overrideValue.trim() : recipient[pending.channel === "email" ? "email" : "phone"];
        const recipientOverride = pending.channel === "print"
          ? undefined
          : {
              ...(recipient.reference !== patientReference ? { reference: recipient.reference } : {}),
              ...(pending.channel === "sms" && value ? { phone: value } : {}),
              ...(pending.channel === "email" && value ? { email: value } : {}),
            };
        results.push(await api.dispatchEducation({
          patientReference,
          educationId: pending.item.id,
          version: pending.item.version,
          channel: pending.channel,
          lane,
          ...(recipientOverride && Object.keys(recipientOverride).length ? { recipientOverride } : {}),
          alsoUpdateChart,
          ...(encounterReference ? { encounterReference } : {}),
          ...(diagnosis?.reference ? { conditionReference: diagnosis.reference } : {}),
          idempotencyKey: idempotencyKeyFactory(),
        }));
      }
      const printResult = results.find((result): result is Extract<EducationDispatchResult, { outcome: "print" }> => result.outcome === "print");
      const refusal = results.find((result): result is Extract<EducationDispatchResult, { outcome: "refused" }> => result.outcome === "refused");
      if (printResult) {
        setStatus("Print artifact ready.");
        if (typeof window !== "undefined" && typeof window.open === "function") window.open(printResult.url, "_blank", "noopener,noreferrer");
      } else if (refusal) {
        setError(refusal.reason);
      } else {
        setStatus(results.length > 1 ? `Education sent to ${results.length} recipients.` : "Education sent.");
      }
      setPending(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Education send failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <ExamEntrySheet sectionId="engage" onCancel={onClose} active={open} hidden={!open}>
      <section className="grid gap-5 p-1" aria-label="Engage education">
        <header>
          <h2 className="text-lg font-semibold">{`Engage — ${patientName(patient)}`}</h2>
          {diagnosis && <p className="text-sm text-[color:var(--odos-muted)]">{`For: ${diagnosis.display} (${diagnosis.code})`}</p>}
        </header>

        <section className="grid gap-3 rounded border border-[color:var(--odos-line)] p-4" aria-label="Education recipients">
          <h3 className="font-semibold">Recipient</h3>
          {recipients.map((recipient) => (
            <label key={recipient.reference} className="flex items-start gap-2 text-sm">
              <input
                type={minor && recipients.length > 1 ? "checkbox" : "radio"}
                checked={selectedRecipients.includes(recipient.reference)}
                onChange={(event) => setSelectedRecipients((current) => event.target.checked
                  ? [...new Set([...current, recipient.reference])]
                  : current.filter((reference) => reference !== recipient.reference))}
              />
              <span>{recipient.label}<small className="block text-[color:var(--odos-muted)]">{recipient.phone ?? "No phone"} · {recipient.email ?? "No email"}</small></span>
            </label>
          ))}
          {minor && recipients.length === 0 && (
            <p className="text-sm text-[color:var(--odos-alert)]">No current consent-authority guardian is recorded. Education dispatch is unavailable.</p>
          )}
          <SmsOptOutErrorBoundary>
            <SmsOptOutControl patientReference={patientReference} onStateChange={setSmsState} />
          </SmsOptOutErrorBoundary>
        </section>

        {error && <p role="alert" className="text-sm text-[color:var(--odos-alert)]">{error}</p>}
        {status && <p role="status" className="text-sm text-[color:var(--odos-emerald)]">{status}</p>}

        <section className="grid gap-3" aria-label="Education content">
          {items.map((item) => {
            const marketingBlocked = item.consentClass === "marketing" && !marketingConsent;
            const defaultSmsLane = chartDispatchLane === "locked_clinical"
              ? "clinical"
              : item.laneHint === "retail" ? "frontdesk" : "clinical";
            return (
              <article key={`${item.id}@${item.version}`} className="rounded border border-[color:var(--odos-line)] p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-semibold">{item.title}</h3>
                  <span className="text-xs uppercase text-[color:var(--odos-muted)]">{item.kind}</span>
                </div>
                {marketingBlocked && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">Marketing consent not on file</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <ChannelButton label="Text" channel="sms" item={item} disabled={!recipients.length || marketingBlocked || !item.channels.includes("sms") || !smsState || isSmsLaneSuppressed(smsState, defaultSmsLane)} onClick={beginSend} />
                  <ChannelButton label="Email" channel="email" item={item} disabled={!recipients.length || marketingBlocked || !item.channels.includes("email")} onClick={beginSend} />
                  <ChannelButton label="Print" channel="print" item={item} disabled={!recipients.length || marketingBlocked || !item.channels.includes("print")} onClick={beginSend} />
                </div>
                {!smsState && item.channels.includes("sms") && <p className="mt-2 text-sm text-[color:var(--odos-muted)]">SMS availability is loading or unavailable.</p>}
                {isSmsLaneSuppressed(smsState, defaultSmsLane) && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">Texting is suppressed on this item’s default lane. Re-enroll above to send.</p>}
              </article>
            );
          })}
        </section>

        {pending && (
          <section className="grid gap-3 rounded border border-[color:var(--odos-accent-border)] p-4" aria-label="Education send confirmation">
            <h3 className="font-semibold">Confirm {pending.channel} · {pending.item.title}</h3>
            {pending.channel === "sms" && chartDispatchLane !== "locked_clinical" && (
              <label className="grid gap-1 text-sm">
                Send via lane
                <select aria-label="Send via lane" value={lane} onChange={(event) => setLane(event.target.value as typeof lane)}>
                  <option value="clinical">Clinical</option>
                  <option value="frontdesk">Front desk</option>
                </select>
              </label>
            )}
            {pending.channel === "sms" && diagnosis && lane === "frontdesk" && (
              <p className="text-sm text-[color:var(--odos-amber)]">Front-desk lane is not BAA-covered; this content is tied to a diagnosis.</p>
            )}
            {pending.channel === "sms" && isSmsLaneSuppressed(smsState, lane) && (
              <p className="text-sm text-[color:var(--odos-alert)]">Texting is suppressed on the selected lane. Re-enroll above before sending.</p>
            )}
            {pending.channel !== "print" && (
              <div className="grid gap-2">
                <button type="button" className="justify-self-start underline" onClick={() => setOverrideMode((current) => !current)}>✎ Override for this send</button>
                {overrideMode && (
                  <label className="grid gap-1 text-sm">
                    {pending.channel === "sms" ? "Phone" : "Email"}
                    <input aria-label="Recipient override" value={overrideValue} onChange={(event) => setOverrideValue(event.target.value)} />
                  </label>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={alsoUpdateChart} onChange={(event) => setAlsoUpdateChart(event.target.checked)} />
                  Also update chart
                </label>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setPending(undefined)}>Cancel</button>
              <button type="button" aria-label="Confirm education send" disabled={sending || (overrideMode && !overrideValue.trim()) || (pending.channel === "sms" && isSmsLaneSuppressed(smsState, lane))} onClick={() => void confirmSend()}>
                {sending ? "Sending…" : pending.channel === "print" ? "Open print artifact" : "Send"}
              </button>
            </div>
          </section>
        )}
      </section>
    </ExamEntrySheet>
  );
}

function ChannelButton({ label, channel, item, disabled, onClick }: {
  label: string;
  channel: PendingSend["channel"];
  item: EducationContentItem;
  disabled: boolean;
  onClick: (item: EducationContentItem, channel: PendingSend["channel"]) => void;
}) {
  return <button type="button" aria-label={`${label} ${item.title}`} disabled={disabled} onClick={() => onClick(item, channel)}>{label}</button>;
}

interface RecipientDisplay {
  reference: string;
  label: string;
  phone?: string;
  email?: string;
}

function patientRecipient(patient: Patient): RecipientDisplay {
  return {
    reference: `Patient/${patient.id}`,
    label: patientName(patient),
    phone: telecom(patient, "phone"),
    email: telecom(patient, "email"),
  };
}

function guardianRecipient(guardian: RelatedPerson): RecipientDisplay {
  const name = guardian.name?.[0];
  const display = [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") || "Related person";
  const relationship = guardian.relationship?.[0]?.coding?.[0]?.display
    ?? guardian.relationship?.[0]?.coding?.[0]?.code
    ?? "guardian";
  return {
    reference: `RelatedPerson/${guardian.id}`,
    label: `${display} · ${relationship}`,
    phone: telecom(guardian, "phone"),
    email: telecom(guardian, "email"),
  };
}

function telecom(resource: Pick<Patient, "telecom">, system: "phone" | "email"): string | undefined {
  return resource.telecom?.find((point) => point.system === system && point.use !== "old")?.value;
}

function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  return [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") || "Patient";
}

function hasConsentAuthority(person: RelatedPerson): boolean {
  return person.active !== false && person.extension?.some((extension) =>
    extension.url === CONSENT_AUTHORITY_EXTENSION_URL && extension.valueBoolean === true) === true;
}

function isPrimaryGuardian(person: RelatedPerson): boolean {
  return person.extension?.some((extension) =>
    extension.url === RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL && extension.valueBoolean === true) === true;
}

function hasMarketingConsent(patient: Patient): boolean {
  const extension = patient.extension?.find((candidate) => candidate.url === MARKETING_CONSENT_EXTENSION_URL);
  if (!extension) return false;
  const consent = extension.extension?.find((candidate) => candidate.url === "consent")?.valueBoolean;
  const recorded = extension.extension?.find((candidate) => candidate.url === "recorded")?.valueDateTime;
  return consent === true && typeof recorded === "string" && !Number.isNaN(Date.parse(recorded));
}

function isSmsLaneSuppressed(state: SmsOptOutState | undefined, lane: "clinical" | "frontdesk"): boolean {
  if (!state) return false;
  if (state.remainingOptOuts.global) return true;
  const role = lane === "frontdesk" ? "transactional-sms" : "clinical-sms";
  const configuredLane = state.smsLanes.find((candidate) => candidate.roles.includes(role));
  return configuredLane
    ? state.remainingOptOuts.numbers.includes(configuredLane.number)
    : state.remainingOptOuts.numbers.length > 0;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultIdempotencyKey(): string {
  return `education-${crypto.randomUUID()}`;
}
