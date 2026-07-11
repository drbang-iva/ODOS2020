import type { Task } from "@medplum/fhirtypes";
import { useCallback, useEffect, useState } from "react";
import {
  advanceLabOrderTransport,
  cancelLabOrder,
  fetchLabOrderWorklist,
} from "../lib/lab-order-transport";
import type { LabOrderExport } from "../lib/optical-lab-order";

const TRANSPORT_STATE_SYSTEM = "https://osod.dev/fhir/CodeSystem/lab-transport-state";
const LAB_ORDER_INPUT_SYSTEM = "https://osod.dev/fhir/CodeSystem/lab-order-task-input";
const LAB_ORDER_EXPORT_CODE = "lab-order-export";
const FILTER_STATES = ["queued", "sent", "received", "cancelled", "error"] as const;

export interface LabOrderWorklistItem {
  reference: string;
  transportState: string;
  date: string;
  lab: string;
  patientName: string;
}

export function LabOrdersWorklist() {
  const [state, setState] = useState("");
  const [items, setItems] = useState<LabOrderWorklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await fetchLabOrderWorklist(state || undefined);
      setItems(result.items.map(labOrderWorklistItem));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [state]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <main className="min-h-screen bg-bg-deep p-5 text-white">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Dispensary</p>
          <h1 className="text-2xl font-semibold">Lab orders</h1>
          <p className="mt-1 text-sm text-white/50">Track orders sent to the lab.</p>
        </div>
        <label className="grid gap-1 text-xs text-white/60">
          <span>Transport state</span>
          <select className="sidebar-input min-w-40" value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">All</option>
            {FILTER_STATES.map((filter) => <option key={filter} value={filter}>{stateLabel(filter)}</option>)}
          </select>
        </label>
      </header>

      {error && <div role="alert" className="mb-4 rounded border border-red-500/50 bg-red-950/30 p-3 text-sm text-red-100">{error}</div>}
      {loading
        ? <div className="grid min-h-52 place-items-center text-sm text-white/50">Loading lab orders…</div>
        : <LabOrdersTable
            items={items}
            onReceive={(reference) => void runAction(() => advanceLabOrderTransport(reference, "received"))}
            onCancel={(reference) => void runAction(() => cancelLabOrder(reference))}
          />}
    </main>
  );
}

export function LabOrdersTable({
  items,
  onReceive,
  onCancel,
}: {
  items: readonly LabOrderWorklistItem[];
  onReceive: (reference: string) => void;
  onCancel: (reference: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded border border-white/10 bg-bg-panel/80">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-white/10 bg-white/[0.04] text-xs uppercase tracking-wide text-white/45">
          <tr><th className="p-3">Lab order</th><th className="p-3">State</th><th className="p-3">Updated</th><th className="p-3">Lab</th><th className="p-3">Patient</th><th className="p-3">Actions</th></tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {items.map((item) => (
            <tr key={item.reference}>
              <td className="p-3 font-mono text-xs text-white/70">{item.reference}</td>
              <td className="p-3"><span className="rounded-full bg-white/10 px-2 py-1 text-xs font-semibold">{stateLabel(item.transportState)}</span></td>
              <td className="p-3 text-white/60">{formatDate(item.date)}</td>
              <td className="p-3">{item.lab}</td>
              <td className="p-3">{item.patientName}</td>
              <td className="p-3">
                {!isTerminal(item.transportState) && <div className="flex gap-2">
                  <button className="sidebar-button py-1" type="button" onClick={() => onReceive(item.reference)}>Mark Received</button>
                  <button className="sidebar-button py-1" type="button" onClick={() => onCancel(item.reference)}>Cancel</button>
                </div>}
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-white/40">No lab orders match this filter.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function labOrderWorklistItem(value: unknown): LabOrderWorklistItem {
  if (!isTask(value) || !value.id) throw new Error("Lab-order worklist returned a Task without an id.");
  const transportState = value.businessStatus?.coding?.find((coding) => coding.system === TRANSPORT_STATE_SYSTEM)?.code;
  if (!transportState) throw new Error(`Task/${value.id} is missing its lab transport state.`);
  const stored = storedExport(value);
  return {
    reference: `Task/${value.id}`,
    transportState,
    date: value.lastModified ?? value.authoredOn ?? "",
    lab: stored.order.header.lab,
    patientName: stored.order.header.patientName,
  };
}

function storedExport(task: Task): LabOrderExport {
  const raw = task.input?.find((input) => input.type.coding?.some((coding) =>
    coding.system === LAB_ORDER_INPUT_SYSTEM && coding.code === LAB_ORDER_EXPORT_CODE))?.valueString;
  if (!raw) throw new Error(`Task/${task.id} is missing its stored lab-order export.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Task/${task.id} contains invalid lab-order export JSON.`);
  }
  if (!isLabOrderExport(parsed)) throw new Error(`Task/${task.id} contains an unsupported lab-order export.`);
  return parsed;
}

function isTask(value: unknown): value is Task {
  return typeof value === "object" && value !== null && (value as { resourceType?: unknown }).resourceType === "Task";
}

function isLabOrderExport(value: unknown): value is LabOrderExport {
  if (typeof value !== "object" || value === null) return false;
  const exportValue = value as Partial<LabOrderExport>;
  return exportValue.format === "osod-lab-order"
    && exportValue.version === "0"
    && typeof exportValue.order?.header?.lab === "string"
    && typeof exportValue.order.header.patientName === "string";
}

function isTerminal(state: string): boolean {
  return state === "received" || state === "cancelled";
}

function stateLabel(state: string): string {
  return state.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function formatDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
