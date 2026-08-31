import { useEffect, useState, type FormEvent } from "react";
import {
  clearSmsOptOut,
  CommunicationsResponseError,
  readSmsOptOut,
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
}: {
  patientReference: string;
  activeLaneRole?: SmsLaneRole;
  onActiveLaneSuppressionChange?: (suppressed: boolean) => void;
}) {
  const [state, setState] = useState<SmsOptOutState>();
  const [error, setError] = useState<string>();
  const [denied, setDenied] = useState(false);
  const [clearNumber, setClearNumber] = useState<string | null>();
  const [reason, setReason] = useState("");
  const [identityVerification, setIdentityVerification] = useState<SmsOptOutIdentityVerification | "">("");
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<string>();

  useEffect(() => {
    let active = true;
    setState(undefined);
    setError(undefined);
    setDenied(false);
    setClearNumber(undefined);
    setResult(undefined);
    readSmsOptOut(patientReference).then((value) => {
      if (!active) return;
      setState(value);
      if (activeLaneRole) {
        const lane = value.smsLanes.find((candidate) => candidate.roles.includes(activeLaneRole));
        onActiveLaneSuppressionChange?.(Boolean(
          value.remainingOptOuts.global || (lane && value.remainingOptOuts.numbers.includes(lane.number)),
        ));
      }
    }).catch((cause) => {
      if (!active) return;
      if (cause instanceof CommunicationsResponseError && cause.status === 403) {
        setDenied(true);
        onActiveLaneSuppressionChange?.(false);
        return;
      }
      setError(cause instanceof Error ? cause.message : "SMS preferences unavailable.");
    });
    return () => { active = false; };
  }, [activeLaneRole, onActiveLaneSuppressionChange, patientReference]);

  if (denied) return null;
  if (error) return <p role="status" className="text-xs text-[color:var(--odos-amber)]">SMS preferences unavailable.</p>;
  if (!state) return <p className="text-xs text-[color:var(--odos-faint)]">Checking SMS preferences…</p>;

  const chooseClear = (number: string | null) => {
    setClearNumber(number);
    setReason("");
    setIdentityVerification("");
    setResult(undefined);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (clearNumber === undefined || !reason.trim() || !identityVerification) return;
    setClearing(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await clearSmsOptOut({
        patientReference,
        reason: reason.trim(),
        identityVerification,
        ...(clearNumber ? { number: clearNumber } : {}),
      });
      const remainingOptOuts = response.remainingOptOuts
        ?? (clearNumber === null && !response.smsOptedOut ? { global: false, numbers: [] } : state.remainingOptOuts);
      setState({ ...state, smsOptedOut: response.smsOptedOut, remainingOptOuts });
      if (activeLaneRole) {
        const lane = state.smsLanes.find((candidate) => candidate.roles.includes(activeLaneRole));
        onActiveLaneSuppressionChange?.(Boolean(
          remainingOptOuts.global || (lane && remainingOptOuts.numbers.includes(lane.number)),
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
      setError(cause instanceof Error ? cause.message : "SMS preferences unavailable.");
    } finally {
      setClearing(false);
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
      {state.smsOptedOut && (
        <button type="button" onClick={() => chooseClear(null)} className="justify-self-start text-xs text-[color:var(--odos-accent)] underline">
          Clear all SMS opt-outs…
        </button>
      )}
      {clearNumber !== undefined && (
        <form onSubmit={(event) => void submit(event)} className="mt-2 grid gap-2 border-t border-[color:var(--odos-line)] pt-3">
          <strong className="text-sm text-[color:var(--odos-text)]">
            {clearNumber ? "Re-enroll this SMS lane" : "Clear all SMS opt-outs"}
          </strong>
          <label className="grid gap-1 text-xs text-[color:var(--odos-muted)]">
            Reason
            <textarea
              aria-label="Reason for re-enrollment"
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
            <button type="button" onClick={() => setClearNumber(undefined)} className="rounded border border-[color:var(--odos-line-2)] px-3 py-1 text-xs">
              Cancel
            </button>
            <button type="submit" disabled={clearing || !reason.trim() || !identityVerification} className="rounded bg-brand px-3 py-1 text-xs font-semibold text-[color:var(--odos-accent-ink)] disabled:opacity-50">
              {clearing ? "Clearing…" : "Confirm re-enrollment"}
            </button>
          </div>
        </form>
      )}
      {result && <p role="status" className="text-sm font-semibold text-[color:var(--odos-amber)]">{result}</p>}
    </section>
  );
}
