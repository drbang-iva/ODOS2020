import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Bundle,
  CarePlan,
  Observation,
  Practitioner,
  PractitionerRole,
  ServiceRequest,
} from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  ReferralConflictError,
  readReferralLetterBody,
  referralApi,
  type CorrespondenceTemplate,
  type FaxStatus,
  type ReferralApi,
  type ReferralConsultant,
  type ReferralDraftUpdate,
  type ReferralIncludeList,
  type ReferralPriority,
} from "./referral-api";
import { OdosChips } from "../inputs/OdosChips";
import { OdosSearchPicker } from "../inputs/OdosSearchPicker";
import { OdosWheel } from "../inputs/OdosWheel";

const SYSTEM_DEFAULTS: ReferralIncludeList = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: false,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};

type ReferralPacketKey = Exclude<keyof ReferralIncludeList, "history_count">;

const INCLUDE_ROWS: Array<{
  key: ReferralPacketKey;
  label: string;
}> = [
  { key: "letter", label: "Referral letter" },
  { key: "demographics", label: "Patient demographics" },
  { key: "history", label: "Prior finalized exam history" },
  { key: "clinical_summary", label: "Clinical summary" },
  { key: "images", label: "Clinical imaging" },
  { key: "hipaa_cover_sheet", label: "HIPAA cover sheet" },
];

interface ComposeContext {
  doctorDisplay: string;
  findingCount: number;
  hasPlan: boolean;
}

interface Props {
  patientReference: string;
  encounterReference: string;
  onClose: () => void;
  api?: ReferralApi;
  loadContext?: (encounterReference: string) => Promise<ComposeContext>;
}

export function ReferralCompose({
  patientReference,
  encounterReference,
  onClose,
  api = referralApi,
  loadContext = loadComposeContext,
}: Props) {
  const patientId = patientReference.replace(/^Patient\//, "");
  const [includeList, setIncludeList] = useState<ReferralIncludeList>(SYSTEM_DEFAULTS);
  const [recent, setRecent] = useState<ReferralConsultant[]>([]);
  const [templates, setTemplates] = useState<CorrespondenceTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [consultantPickerValue, setConsultantPickerValue] = useState("");
  const [selectedConsultant, setSelectedConsultant] = useState<ReferralConsultant>();
  const [priority, setPriority] = useState<ReferralPriority>("routine");
  const [reasonText, setReasonText] = useState("");
  const [referral, setReferral] = useState<ServiceRequest>();
  const [letterBody, setLetterBody] = useState("");
  const [letterTouched, setLetterTouchedState] = useState(false);
  const [consultantWarning, setConsultantWarning] = useState(false);
  const [artifact, setArtifact] = useState("");
  const [artifactReference, setArtifactReference] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [sent, setSent] = useState<{
    provenanceReference?: string;
    sentAt: string;
    fax?: FaxStatus;
    warning?: string;
  }>();
  const [faxSelected, setFaxSelected] = useState(false);
  const [context, setContext] = useState<ComposeContext>({
    doctorDisplay: "clinician",
    findingCount: 0,
    hasPlan: false,
  });
  const referralRef = useRef<ServiceRequest>();
  const reasonTextRef = useRef("");
  const letterBodyRef = useRef("");
  const letterTouchedRef = useRef(false);
  const sendingRef = useRef(false);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewSequence = useRef(0);
  const isSending = busy === "send";
  const composerLocked = Boolean(sent) || isSending;

  useEffect(() => {
    if (!sent?.fax || !referral?.id || isFinalFaxStatus(sent.fax.status)) return;
    const timer = window.setTimeout(() => {
      api.loadFaxStatus(patientId, referral.id!)
        .then((fax) => {
          if (fax) setSent((current) => current ? { ...current, fax } : current);
        })
        .catch((caught) => setError(errorMessage(caught)));
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [api, patientId, referral?.id, sent?.fax, sent?.fax?.status]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.listTemplates(controller.signal),
      api.loadDefaults(controller.signal),
      api.loadRecentConsultants(controller.signal),
      loadContext(encounterReference),
    ]).then(([loadedTemplates, defaults, recentConsultants, loadedContext]) => {
      if (controller.signal.aborted) return;
      setTemplates(loadedTemplates);
      setTemplateId(loadedTemplates[0]?.id ?? "");
      setIncludeList(defaults);
      setRecent(recentConsultants);
      setContext(loadedContext);
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    });
    return () => controller.abort();
  }, [api, encounterReference, loadContext]);

  const searchConsultantOptions = useCallback(async (query: string, signal: AbortSignal) => {
    const consultants = await api.searchConsultants(query, signal);
    return consultants.map((consultant) => ({
      value: consultant.reference,
      label: consultant.display,
      description: `${consultant.reference}${consultant.faxNumber ? ` · Fax ${consultant.faxNumber}` : ""}`,
      item: consultant,
    }));
  }, [api]);

  useEffect(() => {
    if (!referral?.id || sent || isSending) return;
    const normalized = reasonText.trim() || null;
    if (referralReasonText(referral) === normalized) return;
    const timer = window.setTimeout(() => {
      if (!sendingRef.current) void patchDraft({ reasonText: normalized }).catch(handleFailure);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [isSending, reasonText, referral, sent]);

  useEffect(() => {
    if (!referral?.id || !letterBody || sent || isSending) return;
    const sequence = ++previewSequence.current;
    const timer = window.setTimeout(() => {
      setPreviewBusy(true);
      mutationQueue.current
        .then(() => api.previewReferral(patientId, referral.id!, letterBody, templateId))
        .then((response) => {
          if (previewSequence.current === sequence) {
            setArtifact(response.pdfBase64);
            setArtifactReference(response.documentReference);
          }
        })
        .catch((caught) => {
          if (previewSequence.current === sequence) handleFailure(caught);
        })
        .finally(() => {
          if (previewSequence.current === sequence) setPreviewBusy(false);
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [api, includeList, isSending, letterBody, patientId, priority, reasonText, referral?.id, selectedConsultant?.reference, sent, templateId]);

  function setCurrentReferral(next: ServiceRequest): ServiceRequest {
    referralRef.current = next;
    setReferral(next);
    return next;
  }

  function setLetterTouched(value: boolean): void {
    letterTouchedRef.current = value;
    setLetterTouchedState(value);
  }

  function setCurrentReasonText(value: string): void {
    reasonTextRef.current = value;
    setReasonText(value);
  }

  function setCurrentLetterBody(value: string): void {
    letterBodyRef.current = value;
    setLetterBody(value);
  }

  function enqueueMutation(operation: (current: ServiceRequest) => Promise<ServiceRequest>): Promise<ServiceRequest> {
    const run = mutationQueue.current.then(async () => {
      const current = referralRef.current;
      if (!current?.id) throw new Error("Choose a consultant before changing this referral.");
      return setCurrentReferral(await operation(current));
    });
    mutationQueue.current = run.then(() => undefined, () => undefined);
    return run;
  }

  function patchDraft(input: ReferralDraftUpdate): Promise<ServiceRequest> {
    return enqueueMutation((current) => api.updateReferral(patientId, current.id!, input));
  }

  function regenerateDraft(): Promise<ServiceRequest> {
    return enqueueMutation((current) => templateId
      ? api.applyTemplate(patientId, current.id!, templateId)
      : api.regenerateReferral(patientId, current.id!));
  }

  async function chooseConsultant(consultant: ReferralConsultant): Promise<void> {
    if (sent || sendingRef.current) return;
    setBusy("consultant");
    setError(undefined);
    setConflict(false);
    try {
      if (!referralRef.current) {
        const created = setCurrentReferral(await api.createReferral({
          patientId,
          targetReference: consultant.reference,
          encounterReference,
          includeList,
          priority,
          ...(reasonText.trim() ? { reasonText: reasonText.trim() } : {}),
        }));
        const templated = templateId
          ? setCurrentReferral(await api.applyTemplate(patientId, created.id!, templateId))
          : created;
        const generated = readReferralLetterBody(templated);
        setCurrentLetterBody(generated);
        setLetterTouched(false);
      } else if (selectedConsultant?.reference !== consultant.reference) {
        await patchDraft({ targetReference: consultant.reference });
        if (consultantChangeAction(letterTouchedRef.current) === "warn") {
          setConsultantWarning(true);
        } else {
          const regenerated = await regenerateDraft();
          const generated = readReferralLetterBody(regenerated);
          setCurrentLetterBody(generated);
          setLetterTouched(false);
          setConsultantWarning(false);
        }
      }
      setSelectedConsultant(consultant);
      setConsultantPickerValue(consultant.reference);
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(undefined);
    }
  }

  async function regenerate(confirmDiscard = letterTouchedRef.current): Promise<void> {
    if (!referralRef.current || sent || sendingRef.current) return;
    if (confirmDiscard && !window.confirm("Regenerate this letter and discard your edits?")) return;
    setBusy("regenerate");
    setError(undefined);
    try {
      const regenerated = await regenerateDraft();
      const generated = readReferralLetterBody(regenerated);
      setCurrentLetterBody(generated);
      setLetterTouched(false);
      setConsultantWarning(false);
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(undefined);
    }
  }

  async function chooseTemplate(nextTemplateId: string): Promise<void> {
    if (sent || sendingRef.current || nextTemplateId === templateId) return;
    if (letterTouchedRef.current && !window.confirm("Change templates and discard your letter edits?")) return;
    setTemplateId(nextTemplateId);
    if (!referralRef.current) return;
    setBusy("template");
    setError(undefined);
    try {
      const templated = await enqueueMutation((current) =>
        api.applyTemplate(patientId, current.id!, nextTemplateId));
      setCurrentLetterBody(readReferralLetterBody(templated));
      setLetterTouched(false);
      setConsultantWarning(false);
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(undefined);
    }
  }

  function updateIncludeList(next: ReferralIncludeList): void {
    if (sent || sendingRef.current) return;
    setIncludeList(next);
    if (referralRef.current && !sent) void patchDraft({ includeList: next }).catch(handleFailure);
  }

  function updatePriority(next: ReferralPriority): void {
    if (sent || sendingRef.current) return;
    setPriority(next);
    if (referralRef.current && !sent) void patchDraft({ priority: next }).catch(handleFailure);
  }

  async function saveDefaults(): Promise<void> {
    if (sent || sendingRef.current) return;
    setBusy("defaults");
    setError(undefined);
    try {
      setIncludeList(await api.saveDefaults(includeList));
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(undefined);
    }
  }

  async function sendPacket(): Promise<void> {
    if (sendingRef.current) return;
    const current = referralRef.current;
    if (!current?.id || !letterBodyRef.current) return;
    sendingRef.current = true;
    setBusy("send");
    setError(undefined);
    setConflict(false);
    previewSequence.current += 1;
    setPreviewBusy(false);
    try {
      await mutationQueue.current;
      let finalReferral = referralRef.current;
      if (!finalReferral?.id) throw new Error("Choose a consultant before sending this referral.");
      const finalReasonText = reasonTextRef.current.trim() || null;
      if (referralReasonText(finalReferral) !== finalReasonText) {
        finalReferral = await patchDraft({ reasonText: finalReasonText });
      }
      const finalLetterBody = letterBodyRef.current;
      if (!finalLetterBody) throw new Error("A referral letter is required before sending.");
      if (faxSelected) {
        const destinationNumber = selectedConsultant?.faxNumber;
        if (!destinationNumber) {
          throw new Error("The selected consultant does not have a fax number in the Directory.");
        }
        if (readReferralLetterBody(finalReferral) !== finalLetterBody) {
          finalReferral = await patchDraft({ letterBody: finalLetterBody });
        }
        const preview = await api.previewReferral(
          patientId,
          finalReferral.id!,
          finalLetterBody,
          templateId,
        );
        setArtifact(preview.pdfBase64);
        setArtifactReference(preview.documentReference);
        const filename = `referral-${finalReferral.id}.pdf`;
        const response = await api.faxReferral({
          patientId,
          referralId: finalReferral.id!,
          destinationNumber,
          documentBase64: preview.pdfBase64,
          filename,
          billingCode: finalReferral.id!,
        });
        setSent({
          provenanceReference: response.provenanceReference,
          sentAt: new Date().toLocaleString(),
          fax: response.fax,
          warning: response.warning,
        });
      } else {
        const response = await api.sendReferral(
          patientId,
          finalReferral.id!,
          finalLetterBody,
          templateId,
        );
        setArtifact(response.pdfBase64);
        setArtifactReference(response.documentReference);
        setSent({
          provenanceReference: response.provenanceReference,
          sentAt: new Date().toLocaleString(),
        });
      }
    } catch (caught) {
      handleFailure(caught);
    } finally {
      sendingRef.current = false;
      setBusy(undefined);
    }
  }

  function handleFailure(caught: unknown): void {
    if (caught instanceof ReferralConflictError) {
      setConflict(true);
      setError("This referral changed — reopen it before continuing.");
      return;
    }
    setError(errorMessage(caught));
  }

  function downloadPacket(): void {
    if (!artifact) return;
    const url = URL.createObjectURL(new Blob([base64PdfBytes(artifact)], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `referral-${referral?.id ?? "packet"}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function printPacket(): void {
    setFaxSelected(false);
    void api.recordPrintRequested({
      documentReference: artifactReference,
      patientReference,
    }).catch((caught) => {
      console.error("ODOS referral print audit failed:", caught);
    });
    iframeRef.current?.contentWindow?.print();
  }

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[var(--odos-ground)] text-[color:var(--odos-text)]" data-testid="referral-compose">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between border-b border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] px-4 py-3 sm:px-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.24em] text-brand">Referral packet</div>
            <h1 className="mt-1 text-xl font-semibold">One packet, one send</h1>
          </div>
          <button type="button" className="sidebar-button" disabled={isSending} onClick={() => { if (!sendingRef.current) onClose(); }}>Return to chart</button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(340px,430px)_minmax(0,1fr)] lg:overflow-hidden">
          <aside className="space-y-3 border-r border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4 lg:overflow-y-auto sm:p-5">
            <Tile title="Consultant" index="01">
              <OdosSearchPicker
                label="Search the Directory"
                value={consultantPickerValue}
                selectedLabel={selectedConsultant?.display}
                disabled={composerLocked}
                placeholder="Name or organization"
                searchDelayMs={300}
                search={searchConsultantOptions}
                onClear={() => setConsultantPickerValue("")}
                onSelect={(option) => void chooseConsultant(option.item)}
              />
              {!consultantPickerValue && recent.length > 0 && (
                <div className="mt-2 overflow-hidden rounded border border-[color:var(--odos-line)] bg-[var(--odos-deep-surface)]">
                  {recent.map((consultant) => (
                    <button
                      key={consultant.reference}
                      type="button"
                      disabled={busy === "consultant" || composerLocked}
                      className="flex w-full items-center justify-between gap-3 border-b border-[color:var(--odos-line)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--odos-surface-2)] disabled:opacity-50"
                      onClick={() => void chooseConsultant(consultant)}
                    >
                      <span>
                        <span className="block text-sm font-semibold">{consultant.display}</span>
                        <span className="block text-xs text-[color:var(--odos-faint)]">{consultant.reference}</span>
                        {consultant.faxNumber && <span className="block text-xs text-[color:var(--odos-muted)]">Fax {consultant.faxNumber}</span>}
                      </span>
                      <span className="rounded-full border border-brand/35 bg-brand/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-brand">Recent</span>
                    </button>
                  ))}
                </div>
              )}
              {consultantWarning && (
                <div role="alert" className="mt-3 rounded border border-amber-300/35 bg-amber-300/10 p-3 text-sm text-amber-50">
                  <div className="font-semibold">Consultant changed — this letter may still address the previous consultant.</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" disabled={composerLocked} className="rounded border border-amber-200/40 px-3 py-1.5 text-xs font-semibold" onClick={() => void regenerate(true)}>Regenerate and discard edits</button>
                    <button type="button" disabled={composerLocked} className="rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-xs" onClick={() => { if (!sendingRef.current) setConsultantWarning(false); }}>I’ll fix it manually</button>
                  </div>
                </div>
              )}
            </Tile>

            <Tile title="Reason & urgency" index="02">
              <input
                aria-label="Referral reason"
                className="sidebar-input w-full"
                value={reasonText}
                disabled={composerLocked}
                placeholder="Reason for consultation"
                onChange={(event) => { if (!sendingRef.current) setCurrentReasonText(event.target.value); }}
              />
              <div className="mt-3 grid grid-cols-3 overflow-hidden rounded border border-[color:var(--odos-line)]" role="group" aria-label="Referral urgency">
                {(["routine", "urgent", "stat"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={composerLocked}
                    aria-pressed={priority === value}
                    className={`px-2 py-2 text-xs font-semibold uppercase tracking-wide ${priority === value ? "bg-brand text-black" : "bg-[var(--odos-surface-2)] text-[color:var(--odos-muted)] hover:brightness-110"}`}
                    onClick={() => updatePriority(value)}
                  >{value}</button>
                ))}
              </div>
            </Tile>

            <Tile title="Letter" index="03">
              <label className="mb-2 block text-xs font-semibold text-[color:var(--odos-muted)]" htmlFor="referral-template">Template</label>
              <select
                id="referral-template"
                aria-label="Referral letter template"
                className="sidebar-input mb-3 w-full"
                value={templateId}
                disabled={!templates.length || composerLocked || busy === "template"}
                onChange={(event) => void chooseTemplate(event.target.value)}
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · {template.register}
                  </option>
                ))}
              </select>
              <div
                aria-label="Referral letter"
                role="textbox"
                aria-multiline="true"
                contentEditable={Boolean(referral) && !composerLocked}
                suppressContentEditableWarning
                className="sidebar-input min-h-48 w-full overflow-y-auto font-serif leading-relaxed"
                dangerouslySetInnerHTML={{ __html: letterBody }}
                onInput={(event) => {
                  if (!sendingRef.current) {
                    setCurrentLetterBody(event.currentTarget.innerHTML);
                    setLetterTouched(true);
                  }
                }}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--odos-muted)]">
                <span>{letterTouched
                  ? `Edited by ${context.doctorDisplay} — the packet sends your words`
                  : `Generated from ${context.findingCount} findings · ${context.hasPlan ? "plan" : "no plan recorded"}`}</span>
                <button type="button" disabled={!referral || busy === "regenerate" || composerLocked} className="text-brand disabled:opacity-40" onClick={() => void regenerate()}>
                  ↺ Regenerate
                </button>
              </div>
            </Tile>

            <Tile title="Packet contents" index="04">
              <OdosChips
                options={INCLUDE_ROWS.map((row) => ({ value: row.key, label: row.label }))}
                selected={INCLUDE_ROWS.filter((row) => includeList[row.key]).map((row) => row.key)}
                onChange={(selected) => {
                  const nextSelected = new Set(selected);
                  const nextIncludeList = { ...includeList };
                  for (const row of INCLUDE_ROWS) nextIncludeList[row.key] = nextSelected.has(row.key);
                  updateIncludeList(nextIncludeList);
                }}
                ariaLabel="Referral packet contents"
                disabled={composerLocked}
              />
              {includeList.history && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded border border-[color:var(--odos-line)] px-3 py-2 text-sm">
                  <span>Prior finalized exams</span>
                  <div className="w-28">
                    <OdosWheel
                      value={includeList.history_count}
                      centerOn={0}
                      min={1}
                      max={50}
                      step={1}
                      format={String}
                      onChange={(history_count) => updateIncludeList({ ...includeList, history_count })}
                      ariaLabel="Prior finalized exam history count"
                      disabled={composerLocked}
                    />
                  </div>
                </div>
              )}
              <button type="button" disabled={busy === "defaults" || composerLocked} className="mt-3 text-xs font-semibold text-brand disabled:opacity-40" onClick={() => void saveDefaults()}>
                Save as my default
              </button>
            </Tile>

            <Tile title="Send" index="05">
              {sent ? (
                <div className={`rounded border p-4 ${faxTone(sent.fax?.status)}`}>
                  <div className="text-lg font-semibold">{sent.fax ? faxStatusLabel(sent.fax.status) : "✓ Packet sent"}</div>
                  <div className="mt-2 text-xs leading-relaxed opacity-75">
                    {sent.fax?.reference ? `${sent.fax.reference} · ` : ""}
                    Disclosure recorded{sent.provenanceReference ? ` · ${sent.provenanceReference}` : ""} · {context.doctorDisplay} · {sent.sentAt}
                  </div>
                  {sent.fax?.error && <div className="mt-2 text-sm">{sent.fax.error}</div>}
                  {sent.warning && <div role="alert" className="mt-2 text-sm">{sent.warning}</div>}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 overflow-hidden rounded border border-[color:var(--odos-line)]">
                    <button type="button" disabled={!artifact || !artifactReference || isSending} className="px-2 py-2 text-xs font-semibold disabled:opacity-35" onClick={printPacket}>Print</button>
                    <button type="button" disabled={!artifact || isSending} className="border-x border-[color:var(--odos-line)] px-2 py-2 text-xs font-semibold disabled:opacity-35" onClick={() => { setFaxSelected(false); downloadPacket(); }}>Download</button>
                    <button
                      type="button"
                      disabled={!artifact || isSending || !selectedConsultant?.faxNumber}
                      aria-pressed={faxSelected}
                      className={`px-2 py-2 text-xs font-semibold disabled:opacity-35 ${faxSelected ? "bg-brand text-black" : ""}`}
                      onClick={() => setFaxSelected(true)}
                    >Fax</button>
                  </div>
                  {faxSelected && selectedConsultant?.faxNumber && (
                    <p className="mt-2 text-xs text-[color:var(--odos-muted)]">
                      Fax to {selectedConsultant.display} · {selectedConsultant.faxNumber}
                    </p>
                  )}
                  <button type="button" disabled={!referral || !letterBody || Boolean(busy) || conflict || (faxSelected && !selectedConsultant?.faxNumber)} className="mt-3 w-full rounded bg-brand px-4 py-3 text-sm font-bold text-black disabled:opacity-35" onClick={() => void sendPacket()}>
                    {busy === "send" ? "Sending…" : faxSelected ? "Fax packet" : "Send packet"}
                  </button>
                  <p className="mt-2 text-xs leading-relaxed text-[color:var(--odos-faint)]">Sending records a disclosure — who sent what, to whom, and when.</p>
                </>
              )}
            </Tile>

            {error && <div role="alert" className="rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
          </aside>

          <main className="relative min-h-[70vh] overflow-auto bg-[var(--odos-deep-surface)] p-4 sm:p-8 lg:min-h-0">
            <div className="relative mx-auto min-h-[72rem] max-w-[8.5in] bg-white shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
              {artifact ? (
                <iframe
                  ref={iframeRef}
                  title="Referral packet preview"
                  src={`data:application/pdf;base64,${artifact}`}
                  className="h-[72rem] w-full border-0 bg-white"
                />
              ) : (
                <div className="grid h-[72rem] place-items-center p-10 text-center text-slate-400">
                  <div>
                    <div className="text-lg font-semibold text-slate-600">The Packet</div>
                    <div className="mt-2 text-sm">Choose a consultant to assemble the live referral.</div>
                  </div>
                </div>
              )}
              {(priority === "urgent" || priority === "stat") && (
                <div className="pointer-events-none absolute right-8 top-8 rotate-[-8deg] border-4 border-red-600 px-4 py-1 text-2xl font-black uppercase tracking-[0.18em] text-red-600/80">
                  {priority}
                </div>
              )}
              {sent && (
                <div className="pointer-events-none absolute right-8 top-24 rotate-[-8deg] border-4 border-emerald-600 px-4 py-1 text-2xl font-black tracking-[0.18em] text-emerald-700/80">
                  {sent.fax?.status === "Sent" ? "FAX SENT" : "SENT"}
                </div>
              )}
              {previewBusy && <div className="absolute bottom-4 right-4 rounded bg-slate-900/80 px-3 py-1 text-xs text-[color:var(--odos-text)]">Updating packet…</div>}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

export function consultantChangeAction(letterTouched: boolean): "regenerate" | "warn" {
  return letterTouched ? "warn" : "regenerate";
}

function referralReasonText(referral: ServiceRequest): string | null {
  return referral.reasonCode?.[0]?.text?.trim() || null;
}

function isFinalFaxStatus(status: string): boolean {
  return !["Pending", "Dialing"].includes(status);
}

function faxStatusLabel(status: string): string {
  if (status === "Sent") return "✓ Fax sent";
  if (status === "Pending") return "Fax pending";
  if (status === "Dialing") return "Fax dialing";
  return `Fax failed · ${status}`;
}

function faxTone(status: string | undefined): string {
  if (!status || status === "Sent") return "border-emerald-300/35 bg-emerald-300/10 text-emerald-100";
  if (!isFinalFaxStatus(status)) return "border-amber-300/35 bg-amber-300/10 text-amber-100";
  return "border-red-400/40 bg-red-400/10 text-red-100";
}

function Tile({ title, index, children }: { title: string; index: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-3">
        <span className="font-mono text-[10px] text-brand/65">{index}</span>
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export async function loadComposeContext(encounterReference: string): Promise<ComposeContext> {
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const [observations, plans, doctorDisplay] = await Promise.all([
    fhir.search<Observation>("Observation", { encounter: encounterId, _count: "200" }),
    fhir.search<CarePlan>("CarePlan", { encounter: encounterId, _count: "200" }),
    loadAuthenticatedDoctorDisplay(),
  ]);
  return {
    doctorDisplay,
    findingCount: bundleResources(observations)
      .filter((observation) => ["final", "amended", "corrected"].includes(observation.status)).length,
    hasPlan: bundleResources(plans)
      .some((plan) => !["revoked", "entered-in-error", "unknown"].includes(plan.status)),
  };
}

async function loadAuthenticatedDoctorDisplay(): Promise<string> {
  const profile = sessionProfileReference(fhir.authHeader());
  if (!profile) return "clinician";
  const [resourceType, id] = profile.split("/");
  if (!id) return "clinician";
  if (resourceType === "Practitioner") {
    return doctorName(await fhir.read<Practitioner>("Practitioner", id));
  }
  if (resourceType === "PractitionerRole") {
    const role = await fhir.read<PractitionerRole>("PractitionerRole", id);
    if (role.practitioner?.display?.trim()) return role.practitioner.display.trim();
    const practitionerId = role.practitioner?.reference?.match(/^Practitioner\/(.+)$/)?.[1];
    if (practitionerId) return doctorName(await fhir.read<Practitioner>("Practitioner", practitionerId));
  }
  return "clinician";
}

function doctorName(practitioner: Practitioner): string {
  const name = practitioner.name?.find((candidate) => candidate.use === "official") ?? practitioner.name?.[0];
  const display = name?.text?.trim()
    || [...(name?.prefix ?? []), ...(name?.given ?? []), name?.family, ...(name?.suffix ?? [])]
      .filter(Boolean).join(" ").trim();
  if (!display) return "clinician";
  return /^(dr\.?|doctor)\b/i.test(display) ? display : `Dr. ${display}`;
}

function sessionProfileReference(authorization: string | undefined): string | undefined {
  const token = authorization?.replace(/^Bearer\s+/i, "");
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { profile?: unknown };
    return typeof claims.profile === "string" ? claims.profile : undefined;
  } catch {
    return undefined;
  }
}

function bundleResources<T extends Observation | CarePlan>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function base64PdfBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
