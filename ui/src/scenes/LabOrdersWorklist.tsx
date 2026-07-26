import { useCallback, useEffect, useState } from "react";
import {
  LAB_ORDER_STATUSES,
  fetchLabOrderSheet,
  fetchLabOrderWorklist,
  flagLabOrderProblem,
  resolveLabOrderProblem,
  setLabOrderStatus,
  type LabOrderBoardItem,
  type LabOrderBoardSummary,
  type LabOrderNotificationReason,
  type LabOrderProblemReason,
  type LabOrderStatus,
} from "../lib/lab-order-transport";
import { openPrintWindow } from "../lib/print-window";

type BoardFilter = "all-active" | LabOrderStatus;

const FILTERS: Array<{ status: LabOrderStatus; label: string }> = [
  { status: "patients-frame", label: "Patient's frame" },
  { status: "in-office-not-sent", label: "In office — not sent" },
  { status: "outbound", label: "Outbound" },
  { status: "at-lab", label: "At lab" },
  { status: "lenses-on-order", label: "Lenses on order" },
  { status: "frame-on-order", label: "Frame on order" },
  { status: "inbound", label: "Inbound" },
  { status: "received", label: "Received" },
  { status: "notified", label: "Notified" },
];

const PROBLEM_REASONS: Array<{ value: LabOrderProblemReason; label: string }> = [
  { value: "lab-lost", label: "Lab lost it" },
  { value: "lab-breakage-remake", label: "Lab breakage/remake" },
  { value: "cannot-locate", label: "Can't locate in office" },
  { value: "other", label: "Other" },
];

export function LabOrdersWorklist() {
  const [summary, setSummary] = useState<LabOrderBoardSummary>();
  const [filter, setFilter] = useState<BoardFilter>("all-active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await fetchLabOrderWorklist());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runAction = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const visible = summary?.items.filter((item) => filter === "all-active" || item.status === filter) ?? [];

  return (
    <main className="odos-orders-page">
      <div className="odos-orders-ambient" aria-hidden="true" />
      <section className="odos-orders-body">
        <div className="odos-orders-head">
          <h1>Orders</h1>
          <span>{dateLabel()} · {summary?.activeCount ?? "…"} active</span>
        </div>
        {error && <div role="alert" className="odos-orders-error">{error}</div>}
        {summary && <AlarmStrip summary={summary} setFilter={setFilter} />}
        {summary && <FilterRail summary={summary} filter={filter} setFilter={setFilter} />}
        {loading && !summary
          ? <div className="odos-orders-loading">Loading orders…</div>
          : summary && (
            <OrdersBoard
              items={visible}
              busy={busy}
              onStatus={(item, status, notificationReason) => void runAction(`${item.reference}:status`, () => setLabOrderStatus(item.reference, status, notificationReason))}
              onFlag={(item, reason, note) => runAction(`${item.reference}:flag`, () => flagLabOrderProblem(item.reference, reason, note))}
              onResolve={(item) => item.openFlag && void runAction(`${item.reference}:resolve`, () => resolveLabOrderProblem(item.reference, item.openFlag!.id))}
              onPrint={(item) => void runAction(`${item.reference}:print`, async () => {
                const sheet = await fetchLabOrderSheet(item.reference);
                if (!openPrintWindow(`Lab Order ${item.orderId}`, sheet.content)) throw new Error("The browser blocked the lab sheet print window.");
              })}
            />
          )}
        <div className="odos-orders-seam">
          <b>Notify seam:</b> Send pickup text remains honestly not wired. Staff notify by phone and log reached, left message, or unable. Inbound means “it's on the way.” Status is staff-set; transmission remains a separate system fact.
        </div>
      </section>
    </main>
  );
}

export function AlarmStrip({ summary, setFilter }: { summary: LabOrderBoardSummary; setFilter(filter: BoardFilter): void }) {
  const alarms = summary.alarms;
  return (
    <div className="odos-orders-alarms" aria-label="Order alarms">
      <button type="button" onClick={() => setFilter("all-active")}><span />⚑ {alarms.flaggedProblems} flagged problem{alarms.flaggedProblems === 1 ? "" : "s"}</button>
      <button type="button" onClick={() => setFilter("at-lab")}><span />{alarms.atLabOverdue} at lab past {summary.agingConfig.atLabDays} days</button>
      <button type="button" onClick={() => setFilter("all-active")}><span />{alarms.transmissionFailures} order{alarms.transmissionFailures === 1 ? "" : "s"} didn't reach the lab</button>
      <button className="is-amber" type="button" onClick={() => setFilter("received")}><span />{alarms.receivedNotNotified} received, patient not yet notified</button>
    </div>
  );
}

export function FilterRail({ summary, filter, setFilter }: { summary: LabOrderBoardSummary; filter: BoardFilter; setFilter(filter: BoardFilter): void }) {
  return (
    <>
      <div className="odos-orders-rail" aria-label="Order status filters">
        <FilterChip label="All active" count={summary.activeCount} active={filter === "all-active"} onClick={() => setFilter("all-active")} />
        {FILTERS.map(({ status, label }) => (
          <FilterChip key={status} label={label} count={summary.counts[status]} active={filter === status} onClick={() => setFilter(status)} />
        ))}
        <span className="odos-orders-rail-sep">·</span>
        <FilterChip label="Upstream — quote / pre-auth / payment" count={0} active={false} disabled />
        <FilterChip label="Done — dispensed" count={summary.counts.dispensed} active={false} disabled title="Dispensed orders live on the patient record" />
      </div>
      <p className="odos-orders-rail-note">The whole status vocabulary stays visible. FSRC is the DCS frame-source value; ownership appears only for Frame-to-come and Frame enclosed. Status and transmission stay separate.</p>
    </>
  );
}

function FilterChip({ label, count, active, disabled, title, onClick }: { label: string; count: number; active: boolean; disabled?: boolean; title?: string; onClick?(): void }) {
  return <button type="button" className={`${active ? "is-active " : ""}${count === 0 ? "is-zero" : ""}`} disabled={disabled} title={title} onClick={onClick}>{label} <b>{count}</b></button>;
}

export function OrdersBoard({
  items,
  busy,
  onStatus,
  onFlag,
  onResolve,
  onPrint,
}: {
  items: readonly LabOrderBoardItem[];
  busy?: string;
  onStatus(item: LabOrderBoardItem, status: LabOrderStatus, notificationReason?: LabOrderNotificationReason): void;
  onFlag(item: LabOrderBoardItem, reason: LabOrderProblemReason, note: string): Promise<unknown>;
  onResolve(item: LabOrderBoardItem): void;
  onPrint(item: LabOrderBoardItem): void;
}) {
  return (
    <div className="odos-orders-board">
      <div className="odos-orders-row is-head"><span>Order</span><span>Patient</span><span>Frame · lenses</span><span>Lab</span><span>Status</span><span>In status</span><span>Sent</span><span>Advance</span></div>
      {items.map((item) => (
        <OrderRow
          key={item.reference}
          item={item}
          busy={busy === item.reference || Boolean(busy?.startsWith(`${item.reference}:`))}
          onStatus={onStatus}
          onFlag={onFlag}
          onResolve={onResolve}
          onPrint={onPrint}
        />
      ))}
      {items.length === 0 && <div className="odos-orders-empty">No orders match this status.</div>}
      <div className="odos-orders-foot">Sort: open problems first, then needs-action and in-status age. Dispensed falls off the active board; full history stays on the order.</div>
    </div>
  );
}

function OrderRow({ item, busy, onStatus, onFlag, onResolve, onPrint }: {
  item: LabOrderBoardItem;
  busy: boolean;
  onStatus(item: LabOrderBoardItem, status: LabOrderStatus, notificationReason?: LabOrderNotificationReason): void;
  onFlag(item: LabOrderBoardItem, reason: LabOrderProblemReason, note: string): Promise<unknown>;
  onResolve(item: LabOrderBoardItem): void;
  onPrint(item: LabOrderBoardItem): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [reason, setReason] = useState<LabOrderProblemReason>("lab-lost");
  const [note, setNote] = useState("");
  const action = nextAction(item);

  const submitFlag = async () => {
    await onFlag(item, reason, note);
    setFlagOpen(false);
    setMenuOpen(false);
    setNote("");
  };

  return (
    <div className={`odos-orders-row${item.openFlag ? " is-flagged" : item.needsAction ? " is-alarm" : ""}`}>
      <span className="odos-orders-id">#{item.orderId}</span>
      <span className="odos-orders-who">{item.patientName}</span>
      <span className="odos-orders-what">{item.frame} · {item.lenses}<small><i>{item.frameSourceLabel.toUpperCase()}</i>{item.frameOwnership && <i className={item.frameOwnership === "patients-own" ? "is-pof" : ""}>{item.frameOwnership === "patients-own" ? "POF — PATIENT'S OWN" : "IN-HOUSE"}</i>}{item.inventoryStatusLabel && <i>INVENTORY · {item.inventoryStatusLabel.toUpperCase()}</i>}</small></span>
      <span className="odos-orders-lab">{item.lab}</span>
      <span><StatusChip item={item} /></span>
      <span className={`odos-orders-age${item.overdue ? " is-hot" : item.needsAction ? " is-warm" : ""}`}>{ageLabel(item.ageMinutes)}<small>{ageDetail(item)}</small></span>
      <span className={`odos-orders-tx is-${item.transmissionFact.kind}`}>{item.transmissionFact.label}</span>
      <span className="odos-orders-actions">
        {item.transportState === "error"
          ? <button type="button" className="is-warn" disabled={busy} onClick={() => onPrint(item)}>Resend / print sheet</button>
          : action?.status === "notified"
            ? <span className="odos-orders-pop"><button type="button" className="is-hot" disabled={busy} onClick={() => setNotifyOpen(!notifyOpen)}>Notify patient</button>{notifyOpen && <NotifyMenu item={item} onStatus={onStatus} close={() => setNotifyOpen(false)} />}</span>
            : action && <button type="button" disabled={busy} onClick={() => onStatus(item, action.status)}>{action.label}</button>}
        <button type="button" className="odos-orders-more" aria-label={`More actions for ${item.patientName}`} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>⋯</button>
        {menuOpen && (
          <div className="odos-orders-menu">
            {item.status === "at-lab" && <button type="button" onClick={() => onStatus(item, "inbound")}>Mark inbound</button>}
            <button type="button" onClick={() => setFlagOpen(!flagOpen)}>Flag a problem</button>
            {item.openFlag && <button type="button" onClick={() => onResolve(item)}>Resolved ✓</button>}
            <div className="odos-orders-phone-action">
              {action?.status === "notified"
                ? <>
                    <button type="button" onClick={() => onStatus(item, "notified", "reached")}>Reached patient</button>
                    <button type="button" onClick={() => onStatus(item, "notified", "left-message")}>Left message</button>
                    <button type="button" onClick={() => onStatus(item, "notified", "unable")}>Unable to reach</button>
                  </>
                : action && <button type="button" onClick={() => onStatus(item, action.status)}>{action.label}</button>}
            </div>
          </div>
        )}
      </span>
      {item.openFlag && (
        <span className="odos-orders-flagline"><b>⚑ {problemLabel(item.openFlag.reason)}</b> {item.openFlag.note}<small>flagged by {staffLabel(item.openFlag.flaggedBy)} · {relativeAge(item.openFlag.flaggedAt)}</small><button type="button" onClick={() => onResolve(item)}>Resolved ✓</button></span>
      )}
      {flagOpen && (
        <form className="odos-orders-flagform" onSubmit={(event) => { event.preventDefault(); void submitFlag(); }}>
          <label>Reason<select value={reason} onChange={(event) => setReason(event.target.value as LabOrderProblemReason)}>{PROBLEM_REASONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>Note<input required value={note} onChange={(event) => setNote(event.target.value)} placeholder="What happened and what staff need to know" /></label>
          <button type="submit" disabled={busy || !note.trim()}>Flag order</button>
        </form>
      )}
    </div>
  );
}

function NotifyMenu({ item, onStatus, close }: { item: LabOrderBoardItem; onStatus(item: LabOrderBoardItem, status: LabOrderStatus, reason: LabOrderNotificationReason): void; close(): void }) {
  const choose = (reason: LabOrderNotificationReason) => { onStatus(item, "notified", reason); close(); };
  return (
    <div className="odos-orders-notify">
      <button type="button" onClick={() => choose("reached")}>Reached patient<small>sets Notified</small></button>
      <button type="button" onClick={() => choose("left-message")}>Left message<small>sets Notified — left message</small></button>
      <button type="button" onClick={() => choose("unable")}>Unable to reach<small>sets Notified — retry remains due</small></button>
      <button type="button" disabled>Send pickup text<small>Front Line — not wired yet</small></button>
    </div>
  );
}

function StatusChip({ item }: { item: LabOrderBoardItem }) {
  return <span className={`odos-orders-status is-${item.status}`}>{item.statusLabel}{item.notificationReason && <sub>{item.notificationReason.replace("-", " ")}</sub>}</span>;
}

function nextAction(item: LabOrderBoardItem): { status: LabOrderStatus; label: string } | undefined {
  if (item.status === "patients-frame") return { status: "in-office-not-sent", label: "Frame arrived" };
  if (item.status === "in-office-not-sent") return item.frameSource === 0 || item.frameSource === 1
    ? { status: "at-lab", label: "At lab ✓" }
    : { status: "outbound", label: "Outbound ✓" };
  if (item.status === "outbound") return { status: "at-lab", label: "At lab ✓" };
  if (item.status === "at-lab" || item.status === "lenses-on-order" || item.status === "frame-on-order" || item.status === "inbound") return { status: "received", label: "Received ✓" };
  if (item.status === "received") return { status: "notified", label: "Notify patient" };
  if (item.status === "notified") return { status: "dispensed", label: "Dispensed ✓" };
  return undefined;
}

function ageDetail(item: LabOrderBoardItem): string {
  if (item.status === "notified" && item.warningMinutes !== undefined && item.ageMinutes >= item.warningMinutes && !item.overdue) return "retry due";
  if (item.limitMinutes !== undefined) return `limit ${ageLabel(item.limitMinutes)}`;
  return "in status";
}

function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

function problemLabel(reason: LabOrderProblemReason): string {
  return PROBLEM_REASONS.find((option) => option.value === reason)?.label ?? reason;
}

function staffLabel(reference: string): string {
  return reference.split("/").pop() ?? reference;
}

function relativeAge(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  return `${ageLabel(minutes)} ago`;
}

function dateLabel(): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

export function isLabOrderStatus(value: string): value is LabOrderStatus {
  return (LAB_ORDER_STATUSES as readonly string[]).includes(value);
}
