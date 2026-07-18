import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PracticeRoleId } from "../lib/practice-roles";
import {
  fetchDayClose,
  fetchDaySealArchive,
  postDaySeal,
  type DayCloseData,
  type DaySealArchiveRow,
} from "../lib/day-close";
import type { PaymentTenderCode } from "../lib/day-ledger";

const TENDERS: Array<{ code: PaymentTenderCode; label: string }> = [
  { code: "CASH", label: "Cash" },
  { code: "CHECK", label: "Check" },
  { code: "CARD_MANUAL", label: "Manual card" },
];

export function CloseDay({ roles, date, initialData }: {
  roles: readonly PracticeRoleId[];
  date?: string;
  initialData?: DayCloseData;
}) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState<string>();
  const [counted, setCounted] = useState<Record<PaymentTenderCode, string>>({ CASH: "", CHECK: "", CARD_MANUAL: "" });
  const [sealing, setSealing] = useState(false);
  const canSeal = roles.includes("front-desk") || roles.includes("practice-admin");

  useEffect(() => {
    if (initialData) return;
    let active = true;
    fetchDayClose(date)
      .then((loaded) => active && setData(loaded))
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "Day close unavailable."));
    return () => { active = false; };
  }, [date, initialData]);

  const countedCents = useMemo(() => Object.fromEntries(TENDERS.map(({ code }) => [code, parseMoney(counted[code])])) as Record<PaymentTenderCode, number | null>, [counted]);
  const countsComplete = TENDERS.every(({ code }) => countedCents[code] !== null);
  const recordedTotal = data?.ledger.payments.available ? data.ledger.payments.totalCents : null;
  const countedTotal = countsComplete ? TENDERS.reduce((total, { code }) => total + countedCents[code]!, 0) : null;
  const variance = recordedTotal !== null && countedTotal !== null ? countedTotal - recordedTotal : null;
  const sealBlocked = !canSeal || !data || Boolean(data.seal) || !data.ledger.payments.available || !data.ledger.heldCreditsToday.available || !data.review.available || !countsComplete || sealing;

  async function seal() {
    if (!data || sealBlocked) return;
    setSealing(true);
    setError(undefined);
    try {
      const result = await postDaySeal(data.date);
      setData({ ...data, ledger: result.ledger, seal: result.seal });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Day seal failed.");
    } finally {
      setSealing(false);
    }
  }

  return <main className="odos-day-close">
    <header className="odos-close-header">
      <div><a href={`/desk/ledger${date ? `?${new URLSearchParams({ date })}` : ""}`}>← Day Ledger</a><p>Financials · close ceremony</p><h1>Close the Day</h1><span>{data?.date ?? date ?? "Today"}</span></div>
      <a className="odos-close-archive-link" href="/desk/ledger/archive">Archive</a>
    </header>
    {!canSeal && <p className="odos-close-role-note">A Front Desk or Practice Admin staffer can seal a day.</p>}
    {error && <p className="odos-close-error" role="alert">{error}</p>}
    {!data && !error && <p className="odos-close-loading">Preparing the day for review…</p>}
    {data && <div className="odos-close-steps">
      <section className="odos-close-step">
        <StepTitle number="01" eyebrow="Verify" title="Count what is here" />
        {data.ledger.payments.available ? <>
          <div className="odos-close-count-grid">{TENDERS.map(({ code, label }) => <label key={code}><span>{label}<small>Recorded {money(data.ledger.payments.available ? data.ledger.payments.tenderTotalsCents[code] : 0)}</small></span><span className="odos-close-money-input">$<input aria-label={`${label} counted`} inputMode="decimal" placeholder="0.00" value={counted[code]} onChange={(event) => setCounted((current) => ({ ...current, [code]: event.target.value }))} /></span></label>)}</div>
          <div className={`odos-close-variance ${variance === 0 ? "is-balanced" : ""}`}><span>Counted variance</span><strong>{variance === null ? "Enter all counts" : signedMoney(variance)}</strong><small>A nonzero variance stays visible here for review; it does not block sealing.</small></div>
        </> : <Unavailable reason={data.ledger.payments.reason} />}
      </section>

      <section className="odos-close-step">
        <StepTitle number="02" eyebrow="Review" title="Look for what needs attention" />
        {data.review.available ? <div className="odos-close-review-grid">
          <ReviewCard title="Unattached billable charges" value={`${data.review.unattachedCharges.length}`}>
            {data.review.unattachedCharges.length ? data.review.unattachedCharges.map((charge) => <ReviewRow key={charge.chargeItemReference} label={referenceLabel(charge.patientReference)} detail={charge.description} value={money(charge.amountCents)} />) : <Empty>No unattached billable charges.</Empty>}
          </ReviewCard>
          <ReviewCard title="Held credits today" value={data.review.heldCreditsToday.available ? money(data.review.heldCreditsToday.totalCents) : "Unavailable"}>
            {data.review.heldCreditsToday.available ? <Empty>{data.review.heldCreditsToday.count} held credit{data.review.heldCreditsToday.count === 1 ? "" : "s"}.</Empty> : <Unavailable reason={data.review.heldCreditsToday.reason} />}
          </ReviewCard>
          <ReviewCard title="Patient skim" value={`${data.review.patientSkim.length}`}>
            {data.review.patientSkim.length ? data.review.patientSkim.map((row) => <ReviewRow key={row.patientReference} label={referenceLabel(row.patientReference)} detail={`Charges ${money(row.chargesTotalCents)} · paid ${money(row.paidTotalCents)}`} value={money(row.paidTotalCents)} />) : <Empty>No patient payments to skim.</Empty>}
          </ReviewCard>
        </div> : <Unavailable reason={data.review.reason} />}
      </section>

      <section className="odos-close-step odos-close-seal-step">
        <StepTitle number="03" eyebrow="Seal" title={data.seal ? "The day is sealed" : "Mark the day complete"} />
        {data.seal ? <SealSummary data={data} /> : <>
          <p className="odos-close-seal-copy">This soft close freezes new record-only payments on {data.date}. Claims and billing work continue unchanged.</p>
          <button type="button" disabled={sealBlocked} onClick={seal}>{sealing ? "Sealing…" : "Seal this day"}</button>
          {!countsComplete && <small>Enter a counted amount for all three tenders to continue.</small>}
        </>}
      </section>
    </div>}
  </main>;
}

export function DaySealArchive({ initialRows }: { initialRows?: DaySealArchiveRow[] } = {}) {
  const [rows, setRows] = useState(initialRows);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (initialRows) return;
    let active = true;
    fetchDaySealArchive().then((loaded) => active && setRows(loaded)).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Archive unavailable."));
    return () => { active = false; };
  }, [initialRows]);
  return <main className="odos-day-close"><header className="odos-close-header"><div><a href="/desk/ledger">← Day Ledger</a><p>Financials · sealed days</p><h1>Day Archive</h1></div></header>{error && <p className="odos-close-error" role="alert">{error}</p>}{!rows && !error && <p className="odos-close-loading">Opening the archive…</p>}{rows && <section className="odos-close-archive">{rows.length ? rows.map((row) => <a key={row.id} href={`/desk/ledger?${new URLSearchParams({ date: row.date })}`}><span><strong>{row.date}</strong><small>Sealed by {referenceLabel(row.sealedBy)} · {new Date(row.sealedAt).toLocaleString()}</small></span><b>{row.totalCents === null ? "Total unavailable" : money(row.totalCents)}</b></a>) : <Empty>No sealed days yet.</Empty>}</section>}</main>;
}

function StepTitle({ number, eyebrow, title }: { number: string; eyebrow: string; title: string }) { return <header className="odos-close-step-title"><span>{number}</span><div><p>{eyebrow}</p><h2>{title}</h2></div></header>; }
function ReviewCard({ title, value, children }: { title: string; value: string; children: ReactNode }) { return <article className="odos-close-review-card"><header><span>{title}</span><strong>{value}</strong></header><div>{children}</div></article>; }
function ReviewRow({ label, detail, value }: { label: string; detail: string; value: string }) { return <div className="odos-close-review-row"><span><b>{label}</b><small>{detail}</small></span><strong>{value}</strong></div>; }
function Empty({ children }: { children: ReactNode }) { return <p className="odos-close-empty">{children}</p>; }
function Unavailable({ reason }: { reason: string }) { return <p className="odos-close-unavailable" role="status">{reason}</p>; }
function SealSummary({ data }: { data: DayCloseData }) { const seal = data.seal!; return <div className="odos-close-sealed"><strong>{data.ledger.payments.available ? money(data.ledger.payments.totalCents) : "Total unavailable"}</strong><span>{data.date} · {referenceLabel(seal.sealedBy)} · {new Date(seal.sealedAt).toLocaleString()}</span><p>Soft close complete. The day is now with Billing; no claims or billing workflow was changed.</p></div>; }

function parseMoney(value: string): number | null { const trimmed = value.trim(); if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed)) return null; const [whole, fraction = ""] = trimmed.split("."); const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0")); return Number.isSafeInteger(cents) ? cents : null; }
function money(cents: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function signedMoney(cents: number): string { return `${cents > 0 ? "+" : ""}${money(cents)}`; }
function referenceLabel(reference: string): string { return reference === "unattributed" ? "Unattributed" : reference.split("/").at(-1) ?? reference; }
