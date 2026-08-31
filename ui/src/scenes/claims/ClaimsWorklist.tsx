import clsx from "clsx";
import { useEffect, useState } from "react";
import {
  WORKLIST_LANES,
  dispositionsForLane,
  groupWorklistItems,
  type ClaimsApiOptions,
  type ClaimsWorklistItem,
  type ResolveWorklistInput,
  type WorklistDisposition,
} from "../../lib/claims-worklist";
import {
  previewStediClaimResubmission,
  type StediClaimResubmissionPreview,
  type StediPayerClassification,
} from "../../lib/submit-claims";

const LANE_COLOR = {
  "era-denial": "#f87171",
  "era-integrity": "#fb923c",
  "era-line-linkage": "#60a5fa",
  "era-underpayment": "#fbbf24",
  "era-unmatched": "#c084fc",
  "claim-rejected": "#fb7185",
} as const;

export function EraWorklistBoard({
  items,
  onSelect,
}: {
  items: readonly ClaimsWorklistItem[];
  onSelect: (item: ClaimsWorklistItem) => void;
}) {
  const grouped = groupWorklistItems(items);
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {WORKLIST_LANES.map((lane) => (
        <section key={lane.code} aria-label={lane.label} className="min-h-56 rounded-lg border border-white/10 bg-bg-panel/80 p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-white/80">{lane.label}</h2>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-bold text-white/60">{grouped[lane.code].length}</span>
          </div>
          <div className="space-y-2">
            {grouped[lane.code].map((item) => (
              <WorklistCard key={item.id} item={item} onClick={() => onSelect(item)} />
            ))}
            {grouped[lane.code].length === 0 && (
              <div className="rounded-md border border-dashed border-white/10 px-3 py-8 text-center text-xs text-white/35">
                No items in this lane
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function WorklistCard({ item, onClick }: { item: ClaimsWorklistItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border-l-4 border-white/10 bg-white/5 px-3 py-2 text-left text-xs hover:bg-white/10"
      style={{ borderLeftColor: LANE_COLOR[item.code] }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold text-white">{item.title}</span>
        <span className={clsx(
          "shrink-0 rounded-full bg-black/30 px-2 py-0.5 font-bold",
          item.severity === "high" ? "text-red-300" : "text-amber-300",
        )}>
          {ageLabel(item.ageTimer.elapsedMinutes)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-white/40">
        <span className="rounded-sm bg-white/10 px-1 py-0.5 text-[9px] font-bold uppercase text-white/75">{item.status}</span>
        <span className="truncate">{item.patientReference ?? "Patient not matched"}</span>
        {item.owner && <span className="ml-auto shrink-0">{item.owner}</span>}
      </div>
    </button>
  );
}

export function ClaimsWorklistPanel({
  item,
  onClose,
  onClaim,
  onResolve,
  onVoid,
  resubmissionApi = {},
}: {
  item: ClaimsWorklistItem;
  onClose: () => void;
  onClaim: () => Promise<void>;
  onResolve: (input: ResolveWorklistInput) => Promise<void>;
  onVoid: (input: { patientControlNumber: string; payerClassification?: StediPayerClassification }) => Promise<void>;
  resubmissionApi?: ClaimsApiOptions;
}) {
  const [disposition, setDisposition] = useState<WorklistDisposition>(dispositionsForLane(item.code)[0]);
  const [claimReference, setClaimReference] = useState(item.focusReference?.startsWith("Claim/") ? item.focusReference : "");
  const [patientReference, setPatientReference] = useState(item.patientReference ?? "");
  const [insurerReference, setInsurerReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [payerClassification, setPayerClassification] = useState<"" | StediPayerClassification>("");
  const [newPatientControlNumber, setNewPatientControlNumber] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState<StediClaimResubmissionPreview>();
  const [voidPreview, setVoidPreview] = useState<StediClaimResubmissionPreview>();
  const [resubmissionError, setResubmissionError] = useState<string>();

  useEffect(() => {
    if (disposition !== "rebilled" || !item.focusReference?.startsWith("Claim/")) return;
    let cancelled = false;
    setResubmissionError(undefined);
    const request = (intent: "correct" | "void") => previewStediClaimResubmission({
      originalClaimReference: item.focusReference!,
      intent,
      ...(payerClassification ? { payerClassification } : {}),
    }, resubmissionApi);
    Promise.all([request("correct"), request("void")])
      .then(([correction, voided]) => {
        if (!cancelled) {
          setCorrectionPreview(correction);
          setVoidPreview(voided);
        }
      })
      .catch((cause) => {
        if (!cancelled) setResubmissionError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [disposition, item.focusReference, payerClassification, resubmissionApi.authorization, resubmissionApi.baseUrl]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const resolve = () => act(() => onResolve({
    disposition,
    ...((disposition === "rebilled" || disposition === "matched") && claimReference ? { claimReference } : {}),
    ...(disposition === "matched" && patientReference ? { patientReference } : {}),
    ...(disposition === "matched" && insurerReference ? { insurerReference } : {}),
  }));

  return (
    <aside
      role="dialog"
      aria-label={item.title}
      className="fixed inset-y-0 right-12 z-40 flex w-[320px] flex-col border-l border-white/15 bg-[#0c0c18] shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm font-bold text-white">{item.title}</span>
        <button type="button" aria-label="Close panel" onClick={onClose} className="text-white/60 hover:text-white">✕</button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-sm text-white/65">
        <DetailRow label="Task" value={item.taskReference} />
        <DetailRow label="Patient" value={item.patientReference ?? "Not matched"} />
        <DetailRow label="Status" value={item.status} />
        {item.resolutionDisposition && <DetailRow label="Disposition" value={dispositionLabel(item.resolutionDisposition)} />}
        <DetailRow label="Owner" value={item.owner ?? "Unclaimed"} />
        <Evidence item={item} />

        {item.action === "claim" && (
          <button type="button" disabled={busy} onClick={() => void act(onClaim)} className="w-full rounded bg-blue-600 px-3 py-2 font-bold text-white disabled:opacity-50">
            Claim item
          </button>
        )}

        {item.action === "resolve" && (
          <div className="space-y-3 border-t border-white/10 pt-4">
            <label className="block text-xs font-bold text-white/70">
              Resolution
              <select value={disposition} onChange={(event) => setDisposition(event.target.value as WorklistDisposition)} className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-2 text-sm text-white">
                {dispositionsForLane(item.code).map((value) => <option key={value} value={value}>{dispositionLabel(value)}</option>)}
              </select>
            </label>
            {disposition === "matched" && (
              <ReferenceInput label="Claim reference" value={claimReference} onChange={setClaimReference} placeholder="Claim/123" />
            )}
            {disposition === "rebilled" && (
              <StediResubmissionActions
                item={item}
                payerClassification={payerClassification}
                onPayerClassification={setPayerClassification}
                patientControlNumber={newPatientControlNumber}
                onPatientControlNumber={setNewPatientControlNumber}
                correctionPreview={correctionPreview}
                voidPreview={voidPreview}
                error={resubmissionError}
                busy={busy}
                onVoid={() => act(() => onVoid({
                  patientControlNumber: newPatientControlNumber.trim(),
                  ...(payerClassification ? { payerClassification } : {}),
                }))}
              />
            )}
            {disposition === "matched" && (
              <>
                <ReferenceInput label="Patient reference" value={patientReference} onChange={setPatientReference} placeholder="Patient/123" />
                <ReferenceInput label="Insurer reference" value={insurerReference} onChange={setInsurerReference} placeholder="Organization/123" />
              </>
            )}
            {disposition !== "rebilled" && (
              <button type="button" disabled={busy} onClick={() => void resolve()} className="w-full rounded bg-emerald-700 px-3 py-2 font-bold text-[color:var(--odos-text)] disabled:opacity-50">
                Resolve item
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function StediResubmissionActions({
  item,
  payerClassification,
  onPayerClassification,
  patientControlNumber,
  onPatientControlNumber,
  correctionPreview,
  voidPreview,
  error,
  busy,
  onVoid,
}: {
  item: ClaimsWorklistItem;
  payerClassification: "" | StediPayerClassification;
  onPayerClassification: (value: "" | StediPayerClassification) => void;
  patientControlNumber: string;
  onPatientControlNumber: (value: string) => void;
  correctionPreview?: StediClaimResubmissionPreview;
  voidPreview?: StediClaimResubmissionPreview;
  error?: string;
  busy: boolean;
  onVoid: () => void;
}) {
  const originalClaimReference = item.focusReference?.startsWith("Claim/") ? item.focusReference : undefined;
  const correctionReady = correctionPreview?.determination.status === "ready";
  const voidReady = voidPreview?.determination.status === "ready";
  const query = originalClaimReference ? new URLSearchParams({
    originalClaim: originalClaimReference,
    intent: "correct",
    task: item.id,
    ...(payerClassification ? { payerClassification } : {}),
  }).toString() : "";
  return (
    <div className="space-y-3 rounded border border-blue-400/20 bg-blue-950/15 p-3">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-blue-200">Stedi correction or void</h3>
        <p className="mt-1 text-xs leading-relaxed text-[color:var(--odos-muted)]">The payer classification must be explicit. ODOS never infers Medicare from a payer name.</p>
      </div>
      <DetailRow label="Original Claim" value={originalClaimReference ?? "Not linked"} />
      <label className="block text-xs font-bold text-[color:var(--odos-text)]">
        Payer classification
        <select value={payerClassification} onChange={(event) => onPayerClassification(event.target.value as "" | StediPayerClassification)} className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-2 py-2 text-sm text-[color:var(--odos-text)]">
          <option value="">Not confirmed</option>
          <option value="confirmed-non-medicare">Confirmed not Original Medicare</option>
          <option value="original-medicare">Original Medicare Part A/B</option>
        </select>
      </label>
      <ReferenceInput label="New patient control number" value={patientControlNumber} onChange={onPatientControlNumber} placeholder="New unique PCN" />
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <ResubmissionDetermination label="Correction" preview={correctionPreview} />
      {correctionReady && originalClaimReference && patientControlNumber.trim() ? (
        <a href={`/billing/claims/submit?${query}&patientControlNumber=${encodeURIComponent(patientControlNumber.trim())}`} className="block w-full rounded bg-blue-700 px-3 py-2 text-center font-bold text-[color:var(--odos-text)]">Correct claim</a>
      ) : (
        <button type="button" disabled className="w-full rounded bg-blue-700 px-3 py-2 font-bold text-[color:var(--odos-text)] opacity-50">Correct claim</button>
      )}
      <ResubmissionDetermination label="Void" preview={voidPreview} />
      <button type="button" disabled={busy || !voidReady || !patientControlNumber.trim()} onClick={onVoid} className="w-full rounded bg-red-800 px-3 py-2 font-bold text-[color:var(--odos-text)] disabled:opacity-50">Void claim</button>
    </div>
  );
}

function ResubmissionDetermination({ label, preview }: { label: string; preview?: StediClaimResubmissionPreview }) {
  const determination = preview?.determination;
  if (!determination) return <p className="text-xs text-[color:var(--odos-muted)]">{label}: checking CFC and PCCN…</p>;
  if (determination.status === "manual") {
    return <p className="text-xs leading-relaxed text-amber-300">{label}: manual handling — {determination.reason}</p>;
  }
  return (
    <div className="space-y-1">
      <DetailRow label={`${label} CFC`} value={determination.claimFrequencyCode} />
      <DetailRow label="PCCN" value={determination.claimControlNumber ?? "Not included"} />
    </div>
  );
}

function Evidence({ item }: { item: ClaimsWorklistItem }) {
  if (item.evidence.kind === "claim-rejected") {
    return (
      <section>
        <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-white/45">Clearinghouse message</h3>
        <pre className="whitespace-pre-wrap rounded bg-black/30 p-2 text-xs text-white/75">{item.evidence.claimMdMessage || "No message supplied"}</pre>
      </section>
    );
  }
  const evidence = item.evidence;
  return (
    <section className="space-y-1 border-t border-white/10 pt-3">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/45">ERA evidence</h3>
      <DetailRow label="ERA" value={evidence.eraId} />
      <DetailRow label="PCN" value={evidence.pcn} />
      <DetailRow label="Payer ICN" value={evidence.payerIcn ?? "—"} />
      <DetailRow label="Charged" value={money(evidence.chargedCents)} />
      <DetailRow label="Allowed" value={money(evidence.allowedCents)} />
      <DetailRow label="Paid" value={money(evidence.paidCents)} />
      <DetailRow label="Patient responsibility" value={money(evidence.patientResponsibilityCents)} />
      <DetailRow label="Shortfall" value={money(evidence.shortfallCents)} />
      <div className="pt-1 text-xs text-white/50">
        Adjustments: {evidence.adjustments.length === 0 ? "None" : evidence.adjustments.map((value) => `${value.group ?? "?"}-${value.code ?? "?"}`).join(", ")}
      </div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 text-xs"><span className="text-white/40">{label}</span><span className="break-all text-right text-white/75">{value}</span></div>;
}

function ReferenceInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block text-xs font-bold text-white/70">
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-2 text-sm text-white" />
    </label>
  );
}

function dispositionLabel(value: WorklistDisposition): string {
  return value.replace("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
