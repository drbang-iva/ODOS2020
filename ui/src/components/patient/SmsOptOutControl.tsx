import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  clearSmsOptOut,
  CommunicationsResponseError,
  readSmsOptOut,
  recordSmsOptOut,
  type SmsOptOutIdentityVerification,
  type SmsLaneRole,
  type SmsOptOutState,
} from "../../lib/communications-client";

const IDENTITY_VERIFICATION_OPTIONS: Array<{
  value: SmsOptOutIdentityVerification;
  label: string;
}> = [
  { value: "in-person", label: "In person" },
  { value: "phone-verified", label: "Phone verified" },
  { value: "portal", label: "Patient portal" },
];

export function SmsOptOutControl({
  patientReference,
  activeLaneRole,
  onActiveLaneSuppressionChange,
  onStateChange,
  onUnavailable,
}: {
  patientReference: string;
  // The approved B2a compose bar will supply these props for the second mount.
  activeLaneRole?: SmsLaneRole;
  onActiveLaneSuppressionChange?: (suppressed: boolean) => void;
  onStateChange?: (state: SmsOptOutState) => void;
  onUnavailable?: (reason: "denied" | "error") => void;
}) {
  const [state, setState] = useState<SmsOptOutState>();
  const [error, setError] = useState<string>();
  const [denied, setDenied] = useState(false);
  const [clearNumber, setClearNumber] = useState<string | null>();
  const [recording, setRecording] = useState(false);
  const [recordScope, setRecordScope] = useState<"global" | "per-number">("global");
  const [recordNumber, setRecordNumber] = useState("");
  const [reason, setReason] = useState("");
  const [identityVerification, setIdentityVerification] = useState<SmsOptOutIdentityVerification | "">("");
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<string>();
  const operationGenerationRef = useRef(0);
  const suppressionChangeRef = useRef(onActiveLaneSuppressionChange);
  const stateChangeRef = useRef(onStateChange);
  const unavailableRef = useRef(onUnavailable);
  suppressionChangeRef.current = onActiveLaneSuppressionChange;
  stateChangeRef.current = onStateChange;
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    let active = true;
    operationGenerationRef.current += 1;
    setClearing(false);
    setState(undefined);
    setError(undefined);
    setDenied(false);
    setClearNumber(undefined);
    setRecording(false);
    setResult(undefined);
    readSmsOptOut(patientReference).then((value) => {
      if (!active) return;
      setState(value);
      stateChangeRef.current?.(value);
      if (activeLaneRole) {
        const lane = value.smsLanes.find((candidate) => candidate.roles.includes(activeLaneRole));
        suppressionChangeRef.current?.(Boolean(
          value.remainingOptOuts.global
          || (lane ? value.remainingOptOuts.numbers.includes(lane.number) : value.remainingOptOuts.numbers.length > 0),
        ));
      }
    }).catch((cause) => {
      if (!active) return;
      if (cause instanceof CommunicationsResponseError && cause.status === 403) {
        setDenied(true);
        suppressionChangeRef.current?.(false);
        unavailableRef.current?.("denied");
        return;
      }
      setError(cause instanceof Error ? cause.message : "SMS preferences unavailable.");
      unavailableRef.current?.("error");
    });
    return () => { active = false; operationGenerationRef.current += 1; };
  }, [activeLaneRole, patientReference]);

  if (denied) return null;
  if (error) return <p role="status" className="text-xs text-[color:var(--odos-amber)]">SMS preferences unavailable.</p>;
  if (!state) return <p className="text-xs text-[color:var(--odos-faint)]">Checking SMS preferences…</p>;

  const configuredNumbers = new Set(state.smsLanes.map((lane) => lane.number));
  const unmatchedOptOutNumbers = state.remainingOptOuts.numbers.filter((number) => !configuredNumbers.has(number));

  const chooseClear = (number: string | null) => {
    setRecording(false);
    setClearNumber(number);
    setReason("");
    setIdentityVerification("");
    setResult(undefined);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if ((!recording && clearNumber === undefined) || !reason.trim() || !identityVerification
      || (recording && recordScope === "per-number" && !recordNumber)) return;
    const operationGeneration = operationGenerationRef.current;
    const isCurrentOperation = () => operationGeneration === operationGenerationRef.current;
    setClearing(true);
    setError(undefined);
    setResult(undefined);
    try {
      if (recording) {
        const nextState = await recordSmsOptOut({
          patientReference, reason: reason.trim(), identityVerification, scope: recordScope,
          ...(recordScope === "per-number" ? { number: recordNumber } : {}),
        });
        if (!isCurrentOperation()) return;
        setState(nextState);
        stateChangeRef.current?.(nextState);
        if (activeLaneRole) {
          const lane = nextState.smsLanes.find((candidate) => candidate.roles.includes(activeLaneRole));
          suppressionChangeRef.current?.(Boolean(nextState.remainingOptOuts.global
            || (lane ? nextState.remainingOptOuts.numbers.includes(lane.number) : nextState.remainingOptOuts.numbers.length > 0)));
        }
        setRecording(false);
        setResult(recordScope === "global" ? "All text messages are now blocked." : "This SMS lane is now blocked.");
        return;
      }
      const response = await clearSmsOptOut({
        patientReference,
        reason: reason.trim(),
        identityVerification,
        ...(clearNumber ? { number: clearNumber } : {}),
      });
      if (!isCurrentOperation()) return;
      const remainingOptOuts = response.remainingOptOuts
        ?? (clearNumber === null && !response.smsOptedOut ? { global: false, numbers: [] } : state.remainingOptOuts);
      setState({ ...state, smsOptedOut: response.smsOptedOut, remainingOptOuts });
      stateChangeRef.current?.({ ...state, smsOptedOut: response.smsOptedOut, remainingOptOuts });
      if (activeLaneRole) {
        const lane = state.smsLanes.find((candidate) => candidate.roles.includes(activeLaneRole));
        suppressionChangeRef.current?.(Boolean(
          remainingOptOuts.global
          || (lane ? remainingOptOuts.numbers.includes(lane.number) : remainingOptOuts.numbers.length > 0),
        ));
      }
      if (clearNumber && response.suppressionCleared === false) {
        setResult(remainingOptOuts.global
          ? "This patient still has a general SMS opt-out — clearing one lane did not restore texting."
          : "This SMS lane remains suppressed; texting was not restored.");
      } else {
        setResult(clearNumber
          ? "Texting restored for this SMS lane."
          : "All SMS opt-outs cleared.");
      }
      setClearNumber(undefined);
    } catch (cause) {
      if (!isCurrentOperation()) return;
      if (cause instanceof CommunicationsResponseError && cause.status === 409) {
        setRecording(false);
        setClearNumber(undefined);
        try {
          const nextState = await readSmsOptOut(patientReference);
          if (!isCurrentOperation()) return;
          setState(nextState);
          stateChangeRef.current?.(nextState);
          if (activeLaneRole) {
            const lane = nextState.smsLanes.find((candidate) => candidate.roles.includes(activeLaneRole));
            suppressionChangeRef.current?.(Boolean(nextState.remainingOptOuts.global
              || (lane ? nextState.remainingOptOuts.numbers.includes(lane.number) : nextState.remainingOptOuts.numbers.length > 0)));
          }
          setResult(cause.message);
        } catch (refreshCause) {
          if (!isCurrentOperation()) return;
          setError(refreshCause instanceof Error ? refreshCause.message : "SMS preferences unavailable.");
          unavailableRef.current?.("error");
        }
        return;
      }
      setError(cause instanceof Error ? cause.message : "SMS preferences unavailable.");
    } finally {
      if (isCurrentOperation()) setClearing(false);
    }
  };

  return (
    <section aria-label="SMS text preferences" className="grid gap-2 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-3">
      <h3 className="text-sm font-semibold text-[color:var(--odos-text)]">SMS text preferences</h3>
      {state.remainingOptOuts.global && (
        <p className="text-sm font-semibold text-[color:var(--odos-amber)]">General SMS opt-out — all text lanes are blocked.</p>
      )}
      {activeLaneRole && state.smsLanes.some((lane) =>
        lane.roles.includes(activeLaneRole)
        && (state.remainingOptOuts.global || state.remainingOptOuts.numbers.includes(lane.number))) && (
        <p className="text-sm font-semibold text-[color:var(--odos-amber)]">
          Texting is blocked for this patient on the front-desk lane.
        </p>
      )}
      {state.smsLanes.map((lane) => {
        const optedOut = state.remainingOptOuts.global || state.remainingOptOuts.numbers.includes(lane.number);
        return (
          <div key={lane.number} className="flex flex-wrap items-center justify-between gap-2 text-sm text-[color:var(--odos-muted)]">
            <span>{lane.label} — {optedOut ? "opted out (STOP)" : "OK"}</span>
            {optedOut && (
              <button type="button" onClick={() => chooseClear(lane.number)} className="text-[color:var(--odos-accent)] underline">
                Re-enroll…
              </button>
            )}
          </div>
        );
      })}
      {unmatchedOptOutNumbers.map((number) => (
        <div key={number} className="flex flex-wrap items-center justify-between gap-2 text-sm text-[color:var(--odos-muted)]">
          <span>SMS number {number} — opted out (STOP)</span>
          <button type="button" onClick={() => chooseClear(number)} className="text-[color:var(--odos-accent)] underline">
            Re-enroll…
          </button>
        </div>
      ))}
      {state.smsOptedOut && (
        <button type="button" onClick={() => chooseClear(null)} className="justify-self-start text-xs text-[color:var(--odos-accent)] underline">
          Clear all SMS opt-outs…
        </button>
      )}
      {!state.remainingOptOuts.global && (
        <button type="button" onClick={() => {
          setClearNumber(undefined);
          setRecording(true);
          setRecordScope("global");
          setRecordNumber(state.smsLanes.find((lane) => activeLaneRole && lane.roles.includes(activeLaneRole))?.number ?? state.smsLanes[0]?.number ?? "");
          setReason("");
          setIdentityVerification("");
          setResult(undefined);
        }} className="justify-self-start text-xs text-[color:var(--odos-accent)] underline">
          Record opt-out — patient asked…
        </button>
      )}
      {(recording || clearNumber !== undefined) && (
        <form onSubmit={(event) => void submit(event)} className="mt-2 grid gap-2 border-t border-[color:var(--odos-line)] pt-3">
          <strong className="text-sm text-[color:var(--odos-text)]">
            {recording ? "Record SMS opt-out" : clearNumber ? "Re-enroll this SMS lane" : "Clear all SMS opt-outs"}
          </strong>
          {recording && <>
            <label className="grid gap-1 text-xs text-[color:var(--odos-muted)]">
              Scope
              <select aria-label="Opt-out scope" value={recordScope} onChange={(event) => setRecordScope(event.target.value as "global" | "per-number")} className="scheduler-input">
                <option value="global">All text messages</option>
                <option value="per-number" disabled={state.smsLanes.length === 0}>This lane only</option>
              </select>
            </label>
            {recordScope === "per-number" && <label className="grid gap-1 text-xs text-[color:var(--odos-muted)]">
              SMS lane
              <select aria-label="SMS lane" required value={recordNumber} onChange={(event) => setRecordNumber(event.target.value)} className="scheduler-input">
                {state.smsLanes.map((lane) => <option key={lane.number} value={lane.number}>{lane.label}</option>)}
              </select>
            </label>}
          </>}
          <label className="grid gap-1 text-xs text-[color:var(--odos-muted)]">
            Reason
            <textarea
              aria-label={recording ? "Reason for opt-out" : "Reason for re-enrollment"}
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="scheduler-input min-h-20"
            />
          </label>
          <label className="grid gap-1 text-xs text-[color:var(--odos-muted)]">
            Identity verification
            <select
              aria-label="Identity verification"
              required
              value={identityVerification}
              onChange={(event) => setIdentityVerification(event.target.value as SmsOptOutIdentityVerification | "")}
              className="scheduler-input"
            >
              <option value="">Select…</option>
              {IDENTITY_VERIFICATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setClearNumber(undefined); setRecording(false); }} className="rounded border border-[color:var(--odos-line-2)] px-3 py-1 text-xs">
              Cancel
            </button>
            <button type="submit" disabled={clearing || !reason.trim() || !identityVerification || (recording && recordScope === "per-number" && !recordNumber)} className="rounded bg-brand px-3 py-1 text-xs font-semibold text-[color:var(--odos-accent-ink)] disabled:opacity-50">
              {clearing ? (recording ? "Recording…" : "Clearing…") : recording ? "Confirm opt-out" : "Confirm re-enrollment"}
            </button>
          </div>
        </form>
      )}
      {result && <p role="status" className="text-sm font-semibold text-[color:var(--odos-amber)]">{result}</p>}
    </section>
  );
}
