import { useEffect, useMemo, useState } from "react";
import {
  fetchMarginLedger,
  type MarginLedger as MarginLedgerData,
  type MarginLine,
  type MarginLineState,
} from "../lib/margin-ledger";

type Segment = "all" | "frame" | "contact";

export function MarginLedger({
  initialLedger,
  initialPeriod,
}: {
  initialLedger?: MarginLedgerData;
  initialPeriod?: string;
} = {}) {
  const [period, setPeriod] = useState(initialLedger?.period ?? initialPeriod ?? currentPeriod());
  const [ledger, setLedger] = useState(initialLedger);
  const [error, setError] = useState<string>();
  const [segment, setSegment] = useState<Segment>("all");
  const [plan, setPlan] = useState("all");
  const [vendor, setVendor] = useState("all");
  const [state, setState] = useState<MarginLineState | "all">("all");
  const [expanded, setExpanded] = useState<string>();

  useEffect(() => {
    if (initialLedger && period === initialLedger.period) return;
    let active = true;
    setError(undefined);
    fetchMarginLedger(period)
      .then((value) => active && setLedger(value))
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "Margin ledger unavailable."));
    return () => { active = false; };
  }, [initialLedger, period]);

  const plans = useMemo(() => unique(ledger?.lines.map((line) => line.planName) ?? []), [ledger]);
  const vendors = useMemo(() => unique(ledger?.lines.map((line) => line.vendor) ?? []), [ledger]);
  const lines = useMemo(() => (ledger?.lines ?? []).filter((line) =>
    (segment === "all" || line.productClass === segment)
    && (plan === "all" || line.planName === plan)
    && (vendor === "all" || line.vendor === vendor)
    && (state === "all" || line.state === state),
  ), [ledger, plan, segment, state, vendor]);

  return (
    <main className="margin-ledger">
      <div className="margin-ledger-ambient" aria-hidden="true" />
      <section className="margin-ledger-body">
        <header className="margin-ledger-header">
          <div>
            <a href="/settings">← Practice</a>
            <p>The owner’s monthly truth</p>
            <h1>Product <span>Margin Ledger</span></h1>
            <small>The Day Ledger asks “did today balance?” This asks “was it worth it?”</small>
          </div>
        </header>

        <div className="margin-ledger-controls">
          <div className="margin-period-control">
            <button type="button" aria-label="Previous month" onClick={() => setPeriod(shiftPeriod(period, -1))}>‹</button>
            <label><span className="sr-only">Margin period</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
            <button type="button" aria-label="Next month" onClick={() => setPeriod(shiftPeriod(period, 1))}>›</button>
          </div>
          <SegmentControl value={segment} onChange={setSegment} />
          <Filter label="Plan" value={plan} onChange={setPlan} options={plans} />
          <Filter label="Vendor" value={vendor} onChange={setVendor} options={vendors} />
          <Filter label="State" value={state} onChange={(value) => setState(value as MarginLineState | "all")} options={["Estimated", "Settled", "Flagged"]} />
        </div>

        <section className="margin-genesis" role="status">
          <span aria-hidden="true" />
          The ledger begins <strong>2026-07-15</strong>. Every sale and every remit since is linked; history before it never will be.
        </section>

        {error && <p className="margin-ledger-error" role="alert">{error}</p>}
        {ledger ? (
          <>
            <MarginNumerals ledger={ledger} />
            <section className="margin-lines-card">
              <header><div><p>Lines</p><strong>{lines.length} this period</strong></div><span>Open a line for its complete money story</span></header>
              <div className="margin-table-scroll">
                <table>
                  <thead><tr><th>Item</th><th>Wholesale</th><th>Retail</th><th>Patient paid</th><th>Plan paid</th><th>Margin</th><th>×</th><th>State</th></tr></thead>
                  <tbody>
                    {lines.map((line) => (
                      <MarginRow
                        key={line.id}
                        line={line}
                        expanded={expanded === line.id}
                        onToggle={() => setExpanded((current) => current === line.id ? undefined : line.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {lines.length === 0 && <p className="margin-lines-empty">No linked optical lines match these filters.</p>}
            </section>
          </>
        ) : !error && <p className="margin-ledger-reading">Reading this month’s linked sales and remits…</p>}
      </section>
    </main>
  );
}

function MarginNumerals({ ledger }: { ledger: MarginLedgerData }) {
  const targetDelta = ledger.realizedMultiplierMilli === undefined
    ? undefined
    : ledger.realizedMultiplierMilli - ledger.targetMultiplierMilli;
  return <section className="margin-numerals" aria-label="Margin period totals">
    <Numeral label="Realized margin" value={money(ledger.realizedMarginCents)} detail={`${ledger.settledLineCount} settled line${ledger.settledLineCount === 1 ? "" : "s"}`} tone="solid" />
    <Numeral label="In flight" value={money(ledger.inFlightCents)} detail={`${ledger.inFlightLineCount} line${ledger.inFlightLineCount === 1 ? "" : "s"} awaiting truth`} tone="estimate" />
    <Numeral label="Drift" value={signedMoney(ledger.driftCents)} detail={ledger.driftCents < 0 ? "Settled under estimate · trust meter" : "Estimate trust meter"} tone={ledger.driftCents < 0 ? "warn" : "solid"} />
    <Numeral label="Realized ×" value={multiplier(ledger.realizedMultiplierMilli)} detail={`House target ${multiplier(ledger.targetMultiplierMilli)}${targetDelta === undefined ? "" : ` · ${signedMultiplier(targetDelta)}`}`} tone="solid" />
  </section>;
}

function Numeral({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "solid" | "estimate" | "warn" }) {
  return <article className={`margin-numeral margin-numeral-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function MarginRow({ line, expanded, onToggle }: { line: MarginLine; expanded: boolean; onToggle(): void }) {
  const shownMargin = line.state === "Settled" ? line.marginCents ?? 0 : line.estimatedMarginCents;
  return <>
    <tr className={`margin-line margin-line-${line.state.toLocaleLowerCase()}`}>
      <td><button className="margin-item" type="button" aria-expanded={expanded} onClick={onToggle}><span className={`margin-glyph margin-glyph-${line.productClass}`} aria-hidden="true">{line.productClass === "contact" ? "◎" : "◨"}</span><span><strong>{line.item}</strong><small>{line.vendor} · {line.planName}</small></span><i aria-hidden="true">{expanded ? "−" : "+"}</i></button></td>
      <td className="margin-muted">{money(line.wholesaleCents)}</td>
      <td className="margin-muted">{money(line.retailCents)}</td>
      <td>{money(line.patientPaidCents)}</td>
      <td><PlanPaidCell line={line} /></td>
      <td>{line.unpricedPlanPortion
        ? <span className="margin-floor">≥ {money(line.estimatedMarginCents)} <a href="/settings/plan-profiles">plan portion unpriced →</a></span>
        : line.state === "Settled"
          ? <span className="margin-solid-money">{money(shownMargin)}</span>
          : <Estimate>{money(shownMargin)}</Estimate>}</td>
      <td className={line.state === "Settled" ? "" : "margin-muted"}>{line.state === "Settled" ? multiplier(line.multiplierMilli) : "—"}</td>
      <td><StateChip line={line} /></td>
    </tr>
    {expanded && <tr className="margin-line-detail"><td colSpan={8}><MoneyStory line={line} /></td></tr>}
  </>;
}

function PlanPaidCell({ line }: { line: MarginLine }) {
  if (line.state === "Settled") {
    return <span className="margin-plan-settled">{money(line.planPaidCents ?? 0)}{line.deductions.length > 0 && <small>{line.deductions.length} named deduction{line.deductions.length === 1 ? "" : "s"}</small>}</span>;
  }
  if (line.unpricedPlanPortion) return <span className="margin-unpriced">plan unpriced</span>;
  return <Estimate>{money(line.estimatedPlanPaidCents ?? 0)}</Estimate>;
}

function Estimate({ children }: { children: string }) {
  return <span className="margin-estimate"><b>{children}</b><small>est</small></span>;
}

function StateChip({ line }: { line: MarginLine }) {
  if (line.state === "Flagged") {
    return <a className="margin-state margin-state-flagged" href="/billing/claims/worklist?lane=era-line-linkage"><span />Linkage review</a>;
  }
  return <span className={`margin-state margin-state-${line.state.toLocaleLowerCase()}`}><span />{line.state}</span>;
}

function MoneyStory({ line }: { line: MarginLine }) {
  return <div className="margin-money-story">
    <div>
      <StoryLine label={`Sold ${shortDate(line.saleDate)} · Collect receipt`} value={`${money(line.patientPaidCents)} patient`} />
      <StoryLine label={`Tax collected · pass-through, excluded`} value={money(line.taxCents)} muted />
      <StoryLine label={`Estimate at sale (${line.planName} profile)`} value={line.unpricedPlanPortion ? "Plan portion unpriced" : money(line.estimatedPlanPaidCents ?? 0)} estimate />
      {line.state === "Settled" && <StoryLine label="ERA line payment" value={money((line.planPaidCents ?? 0) + line.deductions.reduce((sum, deduction) => sum + deduction.amountCents, 0))} />}
      {line.deductions.map((deduction) => <StoryLine key={deduction.label} label={deduction.label} value={`−${money(deduction.amountCents)}`} deduction />)}
      <StoryLine
        label={line.state === "Settled" ? "Settled margin" : line.state === "Flagged" ? "Estimate only while linkage is reviewed" : "Estimated margin"}
        value={money(line.state === "Settled" ? line.marginCents ?? 0 : line.estimatedMarginCents)}
        total
        estimate={line.state !== "Settled"}
      />
    </div>
    <aside>
      <p>{line.collectReceiptReferences.join(" · ") || "Collect receipt unavailable"}</p>
      <p>{[line.claimReference, line.claimResponseReference, line.paymentReconciliationReference].filter(Boolean).join(" · ") || "No claim or ERA reference"}</p>
      {line.driftCents !== undefined && <strong className={line.driftCents < 0 ? "is-negative" : ""}>This line’s drift: {signedMoney(line.driftCents)}</strong>}
      {line.state === "Flagged" && <a href="/billing/claims/worklist?lane=era-line-linkage">Open ERA linkage worklist →</a>}
    </aside>
  </div>;
}

function StoryLine({ label, value, muted, estimate, deduction, total }: { label: string; value: string; muted?: boolean; estimate?: boolean; deduction?: boolean; total?: boolean }) {
  return <div className={`margin-story-line${muted ? " is-muted" : ""}${estimate ? " is-estimate" : ""}${deduction ? " is-deduction" : ""}${total ? " is-total" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function SegmentControl({ value, onChange }: { value: Segment; onChange(value: Segment): void }) {
  return <div className="margin-segment" role="group" aria-label="Product class">{(["all", "frame", "contact"] as const).map((segment) => <button key={segment} className={value === segment ? "is-active" : ""} type="button" onClick={() => onChange(segment)}>{segment === "all" ? "All" : segment === "frame" ? "Frames" : "Contacts"}</button>)}</div>;
}

function Filter({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange(value: string): void }) {
  return <label className="margin-filter"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">All</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Number.isInteger(cents / 100) ? 0 : 2 }).format(cents / 100);
}

function signedMoney(cents: number): string {
  return `${cents < 0 ? "−" : cents > 0 ? "+" : ""}${money(Math.abs(cents))}`;
}

function multiplier(milli: number | undefined): string {
  return milli === undefined ? "—" : `${(milli / 1_000).toFixed(1)}×`;
}

function signedMultiplier(milli: number): string {
  return `${milli < 0 ? "−" : milli > 0 ? "+" : ""}${Math.abs(milli / 1_000).toFixed(1)}`;
}

function currentPeriod(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shiftPeriod(period: string, delta: number): string {
  const [year, month] = period.split("-").map(Number);
  const next = new Date(year, month - 1 + delta, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", year: "2-digit" }).format(new Date(value));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
