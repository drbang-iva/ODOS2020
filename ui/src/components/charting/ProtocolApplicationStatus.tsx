import { useState } from "react";
import { normalizeApplicationScope } from "../../../../src/protocol-application-scope";
import type { ProtocolItem } from "../../lib/protocol-authoring";
import { protocolItemLabel } from "./ProtocolStagingList";

export interface ApplicationSummary {
  id: string;
  protocolId: string;
  confirmed: boolean;
  undoState: string;
  scope?: "whole" | "item";
  itemClaimLeaseExpiresAt?: string;
  itemKeys?: string[];
}
export function ProtocolApplicationStatus({
  applications,
  items,
  busy,
  onUndo,
  showProtocolIds = false,
}: {
  showProtocolIds?: boolean;
  applications: ApplicationSummary[];
  items: ProtocolItem[];
  busy: boolean;
  onUndo: (id: string) => Promise<void>;
}) {
  const active = applications.filter(
    (a) => a.confirmed && a.undoState === "active",
  );
  const whole = active.filter((a) => normalizeApplicationScope(a) === "whole");
  const individual = active.filter(
    (a) => normalizeApplicationScope(a) === "item",
  );
  return (
    <div className="space-y-2 text-sm">
      {whole.map((a) => (
        <div key={a.id}>
          <span>Applied{showProtocolIds ? `: ${a.protocolId}` : ""}</span>{" "}
          <button
            className="m-1 rounded border border-slate-400 px-3 py-1 disabled:opacity-50"
            type="button"
            disabled={busy}
            onClick={() => onUndo(a.id)}
          >
            {showProtocolIds ? `Undo plan ${a.protocolId}` : "Undo plan"}
          </button>
        </div>
      ))}
      {individual.length > 0 && (
        <div>
          {individual.length}{" "}
          {individual.length === 1 ? "item added" : "items added"}
        </div>
      )}
      {individual.map((a) => {
        const label =
          (a.itemKeys ?? [])
            .map((key) => {
              const item = items.find((i) => i.itemKey === key);
              return item ? protocolItemLabel(item) : key.replace(/[-_]/g, " ");
            })
            .join(", ") || "added item";
        return (
          <div key={a.id}>
            <button
              className="m-1 rounded border border-slate-400 px-3 py-1 disabled:opacity-50"
              type="button"
              disabled={busy}
              onClick={() => onUndo(a.id)}
            >{`Undo ${label}`}</button>
          </div>
        );
      })}
    </div>
  );
}
export interface FollowUpAction {
  id: string;
  payload: {
    interval?: number;
    unit?: string;
    needsConfirmation?: boolean;
    alternatives?: Array<{
      protocolId: string;
      interval: number;
      unit: string;
      reason?: string;
    }>;
  };
}
export function FollowUpConfirmation({
  action,
  protocolTitles,
  onSave,
  readOnly = false,
}: {
  readOnly?: boolean;
  action: FollowUpAction;
  protocolTitles: Record<string, string>;
  onSave: (change: { interval?: number; unit?: string }) => Promise<void>;
}) {
  const [interval, setInterval] = useState(
    String(action.payload.interval ?? ""),
  );
  const [unit, setUnit] = useState(action.payload.unit ?? "months");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save(change: { interval?: number; unit?: string }) {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(change);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!action.payload.needsConfirmation) return null;
  return (
    <div
      className="mt-3 rounded border p-3"
      aria-label="Follow-up recommendation review"
    >
      <p>
        {action.payload.alternatives
          ?.map(
            (a) =>
              `${a.interval} ${a.unit} (${protocolTitles[a.protocolId] ?? a.protocolId})${a.reason ? ` — ${a.reason}` : ""}`,
          )
          .join(" · ")}{" "}
        — confirm or change
      </p>
      <button
        className="m-1 rounded border border-slate-400 px-3 py-1 disabled:opacity-50"
        type="button"
        disabled={busy || readOnly}
        onClick={() => save({})}
      >
        Confirm follow-up
      </button>
      <input
        className="m-1 w-20 rounded border border-slate-400 px-2 py-1"
        aria-label="Follow-up interval"
        disabled={readOnly}
        type="number"
        min="1"
        value={interval}
        onChange={(e) => setInterval(e.target.value)}
      />
      <select
        disabled={readOnly}
        className="m-1 rounded border border-slate-400 px-2 py-1"
        aria-label="Follow-up unit"
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
      >
        {["days", "weeks", "months"].map((u) => (
          <option key={u}>{u}</option>
        ))}
      </select>
      <button
        className="m-1 rounded border border-slate-400 px-3 py-1 disabled:opacity-50"
        type="button"
        disabled={
          busy ||
          readOnly ||
          !(Number(interval) > 0) ||
          !Number.isInteger(Number(interval))
        }
        onClick={() => save({ interval: Number(interval), unit })}
      >
        Save change
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
