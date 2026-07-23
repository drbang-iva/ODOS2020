import { useEffect, useRef, useState } from "react";
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
  type FaxStatus,
  type ReferralApi,
  type ReferralConsultant,
  type ReferralDraftUpdate,
  type ReferralIncludeList,
  type ReferralPriority,
} from "./referral-api";
import { buildReferralPdfBase64 } from "./referral-pdf";

const SYSTEM_DEFAULTS: ReferralIncludeList = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: false,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};

const INCLUDE_ROWS: Array<{
  key: Exclude<keyof ReferralIncludeList, "history_count">;
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
  createPdf?: (artifactHtml: string) => Promise<string>;
}

export function ReferralCompose({
  patientReference,
  encounterReference,
  onClose,
  api = referralApi,
  loadContext = loadComposeContext,
  createPdf = buildReferralPdfBase64,
}: Props) {
  const patientId = patientReference.replace(/^Patient\//, "");
  const [includeList, setIncludeList] = useState<ReferralIncludeList>(SYSTEM_DEFAULTS);
  const [recent, setRecent] = useState<ReferralConsultant[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReferralConsultant[]>([]);
  const [directoryStatus, setDirectoryStatus] = useState<"idle" | "searching" | "ready" | "error">("idle");
  const [selectedConsultant, setSelectedConsultant] = useState<ReferralConsultant>();
  const [priority, setPriority] = useState<ReferralPriority>("routine");
  const [reasonText, setReasonText] = useState("");
  const [referral, setReferral] = useState<ServiceRequest>();
  const [letterBody, setLetterBody] = useState("");
  const [letterTouched, setLetterTouchedState] = useState(false);
  const [consultantWarning, setConsultantWarning] = useState(false);
  const [artifact, setArtifact] = useState("");
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
      api.loadDefaults(controller.signal),
      api.loadRecentConsultants(controller.signal),
      loadContext(encounterReference),
    ]).then(([defaults, recentConsultants, loadedContext]) => {
      if (controller.signal.aborted) return;
      setIncludeList(defaults);
      setRecent(recentConsultants);
      setContext(loadedContext);
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    });
    return () => controller.abort();
  }, [api, encounterReference, loadContext]);

  useEffect(() => {
    if (isSending) return;
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      setDirectoryStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setDirectoryStatus("searching");
      api.searchConsultants(normalized, controller.signal)
        .then((consultants) => {
          if (controller.signal.aborted) return;
          setResults(consultants);
          setDirectoryStatus("ready");
        })
        .catch((caught) => {
          if (controller.signal.aborted || (caught as Error).name === "AbortError") return;
          setDirectoryStatus("error");
          setError(errorMessage(caught));
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, isSending, query]);

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
        .then(() => api.previewReferral(patientId, referral.id!, letterBody))
        .then((response) => {
          if (previewSequence.current === sequence) setArtifact(response.artifact);
        })
        .catch((caught) => {
          if (previewSequence.current === sequence) handleFailure(caught);
        })
        .finally(() => {
          if (previewSequence.current === sequence) setPreviewBusy(false);
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [api, includeList, isSending, letterBody, patientId, priority, reasonText, referral?.id, selectedConsultant?.reference, sent]);

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
    return enqueueMutation((current) => api.regenerateReferral(patientId, current.id!));
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
        const generated = readReferralLetterBody(created);
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
      setQuery(consultant.display);
      setResults([]);
      setDirectoryStatus("idle");
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
        const preview = await api.previewReferral(patientId, finalReferral.id!, finalLetterBody);
        setArtifact(preview.artifact);
        const filename = `referral-${finalReferral.id}.pdf`;
        const response = await api.faxReferral({
          patientId,
          referralId: finalReferral.id!,
          destinationNumber,
          documentBase64: await createPdf(preview.artifact),
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
        const response = await api.sendReferral(patientId, finalReferral.id!, finalLetterBody);
        setArtifact(response.artifact);
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
    const url = URL.createObjectURL(new Blob([artifact], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `referral-${referral?.id ?? "packet"}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const visibleConsultants = query.trim().length < 2 ? recent : results;

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
              <label className="block text-xs font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]" htmlFor="referral-consultant">Search the Directory</label>
              <input
                id="referral-consultant"
                className="sidebar-input mt-2 w-full"
                value={query}
                disabled={composerLocked}
                placeholder="Name or organization"
                autoComplete="off"
                onChange={(event) => { if (!sendingRef.current) setQuery(event.target.value); }}
              />
              <div className="mt-2 text-xs text-[color:var(--odos-muted)]" aria-live="polite">
                {directoryStatus === "searching" ? "Searching…" : directoryStatus === "error" ? "Directory unavailable" : ""}
              </div>
              {visibleConsultants.length > 0 && (
                <div className="mt-2 overflow-hidden rounded border border-[color:var(--odos-line)] bg-[var(--odos-deep-surface)]">
                  {visibleConsultants.map((consultant) => (
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
                      {query.trim().length < 2 && <span className="rounded-full border border-brand/35 bg-brand/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-brand">Recent</span>}
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
              <textarea
                aria-label="Referral letter"
                className="sidebar-input min-h-48 w-full resize-y font-serif leading-relaxed"
                value={letterBody}
                disabled={!referral || composerLocked}
                placeholder="Choose a consultant to generate the letter."
                onChange={(event) => {
                  if (!sendingRef.current) {
                    setCurrentLetterBody(event.target.value);
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
              <div className="space-y-1">
                {INCLUDE_ROWS.map((row) => (
                  <label key={row.key} className={`flex items-center justify-between gap-3 rounded px-2 py-2 ${includeList[row.key] ? "bg-[var(--odos-surface-2)]" : "opacity-45"}`}>
                    <span className="flex items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={includeList[row.key]}
                        disabled={composerLocked}
                        className="h-4 w-4 accent-brand"
                        onChange={(event) => updateIncludeList({ ...includeList, [row.key]: event.target.checked })}
                      />
                      {row.label}
                    </span>
                    {row.key === "history" && (
                      <span className="flex items-center overflow-hidden rounded border border-[color:var(--odos-line)]">
                        <button type="button" aria-label="Reduce history count" disabled={composerLocked || includeList.history_count <= 1} className="px-2 py-1" onClick={(event) => { event.preventDefault(); updateIncludeList({ ...includeList, history_count: Math.max(1, includeList.history_count - 1) }); }}>−</button>
                        <span className="min-w-7 text-center text-xs">{includeList.history_count}</span>
                        <button type="button" aria-label="Increase history count" disabled={composerLocked || includeList.history_count >= 50} className="px-2 py-1" onClick={(event) => { event.preventDefault(); updateIncludeList({ ...includeList, history_count: Math.min(50, includeList.history_count + 1) }); }}>+</button>
                      </span>
                    )}
                  </label>
                ))}
              </div>
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
                    <button type="button" disabled={!artifact || isSending} className="px-2 py-2 text-xs font-semibold disabled:opacity-35" onClick={() => { setFaxSelected(false); iframeRef.current?.contentWindow?.print(); }}>Print</button>
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
                  sandbox="allow-modals"
                  srcDoc={artifact}
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
