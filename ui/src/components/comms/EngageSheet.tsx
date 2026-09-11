import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Patient, RelatedPerson } from "@medplum/fhirtypes";
import {
  dispatchEducation,
  readCommunicationPreferences,
  type CommunicationPreferencesResponse,
  listEducation,
  type EducationCatalogResult,
  type EducationChannelAvailability,
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

const UNAVAILABLE_CHANNELS: EducationChannelAvailability = {
  clinicalSms: false,
  frontdeskSms: false,
  email: false,
  print: false,
};

export interface EngageSheetApi {
  listEducation(query: { dxCode?: string; channel?: "sms" | "email" | "print" }): Promise<EducationCatalogResult>;
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
  idempotencyKeys: Record<string, string>;
  educationEmailWithheld: boolean;
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
  panelId,
  panelLabelledBy,
  panelTabs,
  api = defaultApi,
  idempotencyKeyFactory = defaultIdempotencyKey,
}: {
  open: boolean;
  patient: Patient;
  encounterReference?: string;
  diagnosis?: EngageDiagnosis;
  onClose: () => void;
  panelId?: string;
  panelLabelledBy?: string;
  panelTabs?: ReactNode;
  api?: EngageSheetApi;
  idempotencyKeyFactory?: () => string;
}) {
  const patientReference = `Patient/${patient.id}`;
  const [items, setItems] = useState<EducationContentItem[]>([]);
  const [guardians, setGuardians] = useState<RelatedPerson[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingSend>();
  const [chartDispatchLane, setChartDispatchLane] = useState<"locked_clinical" | "staff_switchable">("staff_switchable");
  const [availableChannels, setAvailableChannels] = useState<EducationChannelAvailability>(UNAVAILABLE_CHANNELS);
  const [lane, setLane] = useState<"clinical" | "frontdesk">("clinical");
  const [overrideMode, setOverrideMode] = useState(false);
  const [overrideValue, setOverrideValue] = useState("");
  const [alsoUpdateChart, setAlsoUpdateChart] = useState(false);
  const [smsState, setSmsState] = useState<SmsOptOutState>();
  const [smsAvailability, setSmsAvailability] = useState<"loading" | "available" | "unavailable">("loading");
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [printUrl, setPrintUrl] = useState<string>();
  const [sending, setSending] = useState(false);
  const minor = patient.birthDate ? isMinorOn(patient.birthDate, today()) : false;
  const [preferences, setPreferences] = useState<CommunicationPreferencesResponse>();
  const [preferenceAvailability, setPreferenceAvailability] = useState<"loading" | "available" | "unavailable">("loading");
  const [preferenceRevision, setPreferenceRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPreferences(undefined);
    setPreferenceAvailability("loading");
    readCommunicationPreferences(patientReference).then(value => {
      if (active) { setPreferences(value); setPreferenceAvailability("available"); }
    }).catch(() => { if (active) setPreferenceAvailability("unavailable"); });
    return () => { active = false; };
  }, [open, patientReference, preferenceRevision]);

  const preferenceCell = (item: EducationContentItem, channel: "sms" | "email") =>
    preferences?.matrix[item.consentClass === "marketing" ? "marketing-promo" : "education"][channel];
  const preferenceBlocked = (item: EducationContentItem, channel: PendingSend["channel"]) => {
    if (channel === "print") return false;
    const cell = preferenceCell(item, channel);
    return preferenceAvailability === "loading" || cell?.source === "suppression"
      || (cell?.value === false && (channel === "sms" || item.consentClass === "marketing"));
  };
  const educationEmailWithheld = (item: EducationContentItem) => item.consentClass !== "marketing"
    && preferenceCell(item, "email")?.source === "explicit" && preferenceCell(item, "email")?.value === false;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPending(undefined);
    setStatus(undefined);
    setError(undefined);
    setPrintUrl(undefined);
    setSmsState(undefined);
    setSmsAvailability("loading");
    setAvailableChannels(UNAVAILABLE_CHANNELS);
    Promise.all([
      api.listEducation(diagnosis?.code ? { dxCode: diagnosis.code } : {}),
      minor ? api.listConsentGuardians(patientReference) : Promise.resolve([]),
    ]).then(([catalog, relatedPeople]) => {
      if (!active) return;
      setItems(catalog.items.filter((item) => item.audience === "patient"));
      setChartDispatchLane(catalog.chartDispatchLane);
      setAvailableChannels(catalog.availableChannels);
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
    setPending({ item, channel, idempotencyKeys: {}, educationEmailWithheld: channel === "email" && educationEmailWithheld(item) });
    setLane(chartDispatchLane === "locked_clinical"
      ? "clinical"
      : item.laneHint === "retail" ? "frontdesk" : "clinical");
    setOverrideMode(false);
    setOverrideValue("");
    setAlsoUpdateChart(false);
    setStatus(undefined);
    setError(undefined);
    setPrintUrl(undefined);
  };

  useEffect(() => {
    if (selectedRecipients.length <= 1) return;
    setOverrideMode(false);
    setOverrideValue("");
    setAlsoUpdateChart(false);
  }, [selectedRecipients]);

  const confirmSend = async () => {
    if (!pending) return;
    const chosenRecipients = recipients.filter((candidate) => selectedRecipients.includes(candidate.reference));
    if (chosenRecipients.length === 0) {
      setError("Choose a recipient before sending education.");
      return;
    }
    if (overrideMode && chosenRecipients.length !== 1) {
      setError("Override is available only when one recipient is selected.");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      const results: EducationDispatchResult[] = [];
      const idempotencyKeys = { ...pending.idempotencyKeys };
      for (const recipient of pending.channel === "print" ? [chosenRecipients[0]!] : chosenRecipients) {
        const value = overrideMode ? overrideValue.trim() : recipient[pending.channel === "email" ? "email" : "phone"];
        const recipientOverride = pending.channel === "print"
          ? undefined
          : {
              ...(recipient.reference !== patientReference ? { reference: recipient.reference } : {}),
              ...(pending.channel === "sms" && value ? { phone: value } : {}),
              ...(pending.channel === "email" && value ? { email: value } : {}),
            };
        const confirmationIdentity = JSON.stringify({
          channel: pending.channel,
          educationId: pending.item.id,
          version: pending.item.version,
          recipient: recipient.reference,
          value: value ?? "",
          lane,
          alsoUpdateChart,
        });
        idempotencyKeys[confirmationIdentity] ??= idempotencyKeyFactory();
        setPending((current) => current && current.item === pending.item && current.channel === pending.channel
          ? { ...current, idempotencyKeys }
          : current);
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
          idempotencyKey: idempotencyKeys[confirmationIdentity],
        }));
      }
      const printResult = results.find((result): result is Extract<EducationDispatchResult, { outcome: "print" }> => result.outcome === "print");
      const refusal = results.find((result): result is Extract<EducationDispatchResult, { outcome: "refused" }> => result.outcome === "refused");
      const suppression = results.find((result): result is Extract<EducationDispatchResult, { outcome: "suppressed" }> => result.outcome === "suppressed");
      const rescheduled = results.find((result): result is Extract<EducationDispatchResult, { outcome: "rescheduled" }> => result.outcome === "rescheduled");
      if (printResult) {
        setPrintUrl(printResult.url);
      } else if (refusal) {
        setError(refusal.reason);
      } else if (suppression?.reason === "patient-opt-out") {
        setError("Texting is blocked — this patient opted out.");
      } else if (suppression?.reason === "preference-withheld") {
        setError(preferenceWithheldMessage(pending.item, pending.channel));
      } else if (suppression) {
        setError("Texting is blocked by the communication frequency limit.");
      } else if (rescheduled) {
        setStatus(`Not sent — try after ${rescheduled.rescheduledAt}.`);
      } else {
        const preferenceFailed = results.some(result => result.outcome === "sent" && result.preferenceUpdate === "failed");
        const chartConflict = results.some(result => result.outcome === "sent" && result.chartUpdate === "conflict");
        const sentMessage = preferenceFailed
          ? "Education sent, but their education email setting couldn't be switched on. Update it in Edit demographics."
          : pending.educationEmailWithheld ? "Education sent. Their education email setting is now on."
            : results.length > 1 ? `Education sent to ${results.length} recipients.` : "Education sent.";
        setStatus(`${sentMessage}${chartConflict ? " The chart's contact wasn't updated because the record changed — update it from Edit demographics." : ""}`);
        if (pending.educationEmailWithheld && !preferenceFailed) setPreferenceRevision(current => current + 1);
      }
      setPending(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Education send failed.");
    } finally {
      setSending(false);
    }
  };

  const selectedSmsLaneUnavailableReason = pending?.channel === "sms"
    ? smsLaneUnavailableReason(availableChannels, lane)
    : undefined;

  return (
    <ExamEntrySheet
      sectionId="engage"
      onCancel={onClose}
      panelId={panelId}
      panelLabelledBy={panelLabelledBy}
      panelTabs={panelTabs}
      active={open}
      hidden={!open}
    >
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
            <SmsOptOutControl
              patientReference={patientReference}
              onStateChange={(value) => {
                setSmsState(value);
                setSmsAvailability("available");
              }}
              onUnavailable={() => setSmsAvailability("unavailable")}
              onPatientWritten={() => setPreferenceRevision(current => current + 1)}
            />
          </SmsOptOutErrorBoundary>
        </section>

        {preferenceAvailability === "unavailable" && <p className="text-sm text-[color:var(--odos-muted)]">Communication preferences could not be read; dispatch will enforce them.</p>}
        {preferenceAvailability === "loading" && <p className="text-sm text-[color:var(--odos-muted)]">Checking communication preferences…</p>}
        {error && <p role="alert" className="text-sm text-[color:var(--odos-alert)]">{error}</p>}
        {status && <p role="status" className="text-sm text-[color:var(--odos-emerald)]">{status}</p>}
        {printUrl && <a aria-label="Open print artifact" href={printUrl} target="_blank" rel="noreferrer">Open print artifact</a>}

        <section className="grid gap-3" aria-label="Education content">
          {items.map((item) => {
            const defaultSmsLane = chartDispatchLane === "locked_clinical"
              ? "clinical"
              : item.laneHint === "retail" ? "frontdesk" : "clinical";
            const defaultSmsLaneConfigured = isSmsLaneConfigured(availableChannels, defaultSmsLane);
            const defaultSmsLaneUnavailableReason = smsLaneUnavailableReason(availableChannels, defaultSmsLane);
            return (
              <article key={`${item.id}@${item.version}`} className="rounded border border-[color:var(--odos-line)] p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-semibold">{item.title}</h3>
                  <span className="text-xs uppercase text-[color:var(--odos-muted)]">{item.kind}</span>
                </div>
                {preferenceCell(item, "sms")?.value === false && preferenceCell(item, "sms")?.source !== "suppression" && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">{preferenceWithheldMessage(item, "sms")}</p>}
                {item.consentClass === "marketing" && preferenceCell(item, "email")?.value === false && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">Marketing email is off for this patient.</p>}
                {educationEmailWithheld(item) && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">Their education email setting is off. Sending will switch it on.</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <ChannelButton label="Text" channel="sms" item={item} disabled={!recipients.length || preferenceBlocked(item, "sms") || !item.channels.includes("sms") || !defaultSmsLaneConfigured || smsAvailability === "loading" || isSmsLaneSuppressed(smsState, defaultSmsLane)} onClick={beginSend} />
                  <ChannelButton label="Email" channel="email" item={item} disabled={!recipients.length || preferenceBlocked(item, "email") || !item.channels.includes("email") || !availableChannels.email} onClick={beginSend} />
                  <ChannelButton label="Print" channel="print" item={item} disabled={!recipients.length || !item.channels.includes("print") || !availableChannels.print} onClick={beginSend} />
                </div>
                {item.channels.includes("email") && !availableChannels.email && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">Email is not configured for this practice.</p>}
                {item.channels.includes("sms") && defaultSmsLaneUnavailableReason && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">{defaultSmsLaneUnavailableReason}</p>}
                {smsAvailability === "loading" && item.channels.includes("sms") && <p className="mt-2 text-sm text-[color:var(--odos-muted)]">Checking SMS availability…</p>}
                {smsAvailability === "unavailable" && item.channels.includes("sms") && <p className="mt-2 text-sm text-[color:var(--odos-muted)]">SMS preferences could not be read; dispatch will enforce opt-outs.</p>}
                {(isSmsLaneSuppressed(smsState, defaultSmsLane) || preferenceCell(item, "sms")?.source === "suppression") && <p className="mt-2 text-sm text-[color:var(--odos-amber)]">Texting is suppressed on this item’s default lane. Re-enroll above to send.</p>}
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
                  <option value="clinical" disabled={!availableChannels.clinicalSms}>Clinical</option>
                  <option value="frontdesk" disabled={!availableChannels.frontdeskSms}>Front desk</option>
                </select>
              </label>
            )}
            {pending.channel === "sms" && chartDispatchLane !== "locked_clinical" && selectedSmsLaneUnavailableReason && (
              <p className="text-sm text-[color:var(--odos-amber)]">{selectedSmsLaneUnavailableReason}</p>
            )}
            {pending.channel === "sms" && diagnosis && lane === "frontdesk" && (
              <p className="text-sm text-[color:var(--odos-amber)]">Front-desk lane is not BAA-covered; this content is tied to a diagnosis.</p>
            )}
            {pending.channel === "sms" && isSmsLaneSuppressed(smsState, lane) && (
              <p className="text-sm text-[color:var(--odos-alert)]">Texting is suppressed on the selected lane. Re-enroll above before sending.</p>
            )}
            {pending.channel !== "print" && (
              <div className="grid gap-2">
                <button type="button" disabled={selectedRecipients.length !== 1} className="justify-self-start underline" onClick={() => setOverrideMode((current) => !current)}>✎ Override for this send</button>
                {selectedRecipients.length > 1 && <p className="text-sm text-[color:var(--odos-muted)]">Override is available only when one recipient is selected.</p>}
                {overrideMode && (
                  <>
                    <label className="grid gap-1 text-sm">
                      {pending.channel === "sms" ? "Phone" : "Email"}
                      <input aria-label="Recipient override" value={overrideValue} onChange={(event) => setOverrideValue(event.target.value)} />
                    </label>
                    {overrideValue.trim() && (
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={alsoUpdateChart} onChange={(event) => setAlsoUpdateChart(event.target.checked)} />
                        Also update chart
                      </label>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setPending(undefined)}>Cancel</button>
              <button type="button" aria-label="Confirm education send" disabled={sending || preferenceBlocked(pending.item, pending.channel) || (overrideMode && !overrideValue.trim()) || (pending.channel === "sms" && (!isSmsLaneConfigured(availableChannels, lane) || isSmsLaneSuppressed(smsState, lane)))} onClick={() => void confirmSend()}>
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
  return <button type="button" aria-label={`${label} ${item.title}`} className="rounded border border-[color:var(--odos-line)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40" disabled={disabled} onClick={() => onClick(item, channel)}>{label}</button>;
}

function isSmsLaneConfigured(
  availableChannels: EducationChannelAvailability,
  lane: "clinical" | "frontdesk",
): boolean {
  return lane === "clinical" ? availableChannels.clinicalSms : availableChannels.frontdeskSms;
}

function smsLaneUnavailableReason(
  availableChannels: EducationChannelAvailability,
  lane: "clinical" | "frontdesk",
): string | undefined {
  if (!availableChannels.clinicalSms && !availableChannels.frontdeskSms) {
    return "No SMS lane is configured for this practice.";
  }
  if (isSmsLaneConfigured(availableChannels, lane)) return undefined;
  return lane === "clinical"
    ? "The clinical SMS lane is not configured for this practice."
    : "The front-desk SMS lane is not configured for this practice.";
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

function preferenceWithheldMessage(item: EducationContentItem, channel: PendingSend["channel"]): string {
  if (item.consentClass === "marketing") return channel === "sms" ? "Marketing texts are off for this patient." : "Marketing email is off for this patient.";
  return channel === "email" ? "Education by email is switched off in this patient's communication preferences."
    : "Education by text is switched off in this patient's communication preferences.";
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
