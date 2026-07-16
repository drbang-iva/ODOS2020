import { useEffect, useState } from "react";
import {
  fetchDayLedger,
  type DayLedger as DayLedgerData,
  type DayLedgerPayment,
  type PaymentTenderCode,
} from "../lib/day-ledger";

const TENDERS: Array<{ code: PaymentTenderCode; label: string }> = [
  { code: "CASH", label: "Cash" },
  { code: "CHECK", label: "Check" },
  { code: "CARD_MANUAL", label: "Card" },
];

export function DayLedger({ initialLedger }: { initialLedger?: DayLedgerData } = {}) {
  const [ledger, setLedger] = useState(initialLedger);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (initialLedger) return;
    let active = true;
    fetchDayLedger()
      .then((value) => active && setLedger(value))
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "Day Ledger unavailable."));
    return () => { active = false; };
  }, [initialLedger]);

  return (
    <main className="odos-day-ledger">
      <div className="odos-ledger-ambient" aria-hidden="true" />
      <section className="odos-ledger-body">
        <header className="odos-ledger-header">
          <div>
            <a href="/desk">← The Desk</a>
            <p>Financials · live view</p>
            <h1>Day Ledger</h1>
            <span>{ledger ? longDate(ledger.date) : "Today"}</span>
          </div>
          <div className="odos-ledger-close">
            <button type="button" disabled>Close the day</button>
            <small>Coming soon</small>
          </div>
        </header>

        {error && <p className="odos-ledger-error" role="alert">{error}</p>}
        {!ledger && !error && <p className="odos-ledger-loading">Opening today’s ledger…</p>}
        {ledger && (
          <>
            {ledger.payments.available
              ? <TenderMonuments payments={ledger.payments.detail} totals={ledger.payments.tenderTotalsCents} />
              : <Unavailable title="Payment totals unavailable" reason={ledger.payments.reason} />}

            <section className="odos-ledger-lower">
              <article className="odos-ledger-panel odos-ledger-feed">
                <div className="odos-ledger-panel-head"><div><p>Live feed</p><h2>Payments today</h2></div>{ledger.payments.available && <strong>{ledger.payments.detail.length}</strong>}</div>
                {ledger.payments.available
                  ? ledger.payments.detail.length > 0
                    ? <div className="odos-ledger-rows">{ledger.payments.detail.map((payment, index) => <PaymentRow key={`${payment.time}-${payment.patientReference}-${index}`} payment={payment} />)}</div>
                    : <p className="odos-ledger-empty">No recorded payments yet today.</p>
                  : <p className="odos-ledger-unavailable">{ledger.payments.reason}</p>}
              </article>

              <div className="odos-ledger-side">
                <article className="odos-ledger-panel odos-ledger-credit">
                  <p>Held credits today</p>
                  {ledger.heldCreditsToday.available
                    ? <><strong>{money(ledger.heldCreditsToday.totalCents)}</strong><span>{ledger.heldCreditsToday.count} unapplied credit{ledger.heldCreditsToday.count === 1 ? "" : "s"}</span></>
                    : <span className="odos-ledger-unavailable">{ledger.heldCreditsToday.reason}</span>}
                </article>
                <article className="odos-ledger-panel odos-ledger-sessions">
                  <div className="odos-ledger-panel-head"><div><p>Sessions</p><h2>By staffer</h2></div></div>
                  {ledger.payments.available
                    ? ledger.payments.staffLedgerTotals.length > 0
                      ? ledger.payments.staffLedgerTotals.map((session) => <div className="odos-ledger-session" key={session.staffer}><span><b>{referenceLabel(session.staffer)}</b><small>{session.count} payment{session.count === 1 ? "" : "s"}</small></span><strong>{money(session.subtotalCents)}</strong></div>)
                      : <p className="odos-ledger-empty">No staff payment sessions yet.</p>
                    : <p className="odos-ledger-unavailable">{ledger.payments.reason}</p>}
                </article>
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function TenderMonuments({ payments, totals }: { payments: DayLedgerPayment[]; totals: Record<PaymentTenderCode, number> }) {
  return <section className="odos-ledger-tenders" aria-label="Tender totals">{TENDERS.map((tender) => {
    const rows = payments.filter((payment) => payment.tender === tender.code);
    return <details key={tender.code} className="odos-ledger-tender">
      <summary><span>{tender.label}</span><strong>{money(totals[tender.code])}</strong><small>{rows.length} payment{rows.length === 1 ? "" : "s"} · view detail</small></summary>
      <div>{rows.length > 0 ? rows.map((payment, index) => <PaymentRow key={`${payment.time}-${index}`} payment={payment} />) : <p className="odos-ledger-empty">No {tender.label.toLowerCase()} payments today.</p>}</div>
    </details>;
  })}</section>;
}

function PaymentRow({ payment }: { payment: DayLedgerPayment }) {
  return <div className="odos-ledger-payment"><time>{timeLabel(payment.time)}</time><span><b>{referenceLabel(payment.patientReference)}</b><small>{referenceLabel(payment.staffer)} · {tenderLabel(payment.tender)}</small></span><strong>{money(payment.amountCents)}</strong></div>;
}

function Unavailable({ title, reason }: { title: string; reason: string }) {
  return <section className="odos-ledger-unavailable-card" role="status"><strong>{title}</strong><span>{reason}</span></section>;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function longDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function referenceLabel(reference: string): string {
  return reference.split("/").at(-1) ?? reference;
}

function tenderLabel(tender: PaymentTenderCode): string {
  return TENDERS.find((candidate) => candidate.code === tender)?.label ?? tender;
}
