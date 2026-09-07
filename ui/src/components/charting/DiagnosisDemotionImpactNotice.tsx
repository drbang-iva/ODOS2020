import type { DiagnosisDemotionImpact } from "../../lib/clinical-graph-client";

export function DiagnosisDemotionImpactNotice({ impact }: { impact?: DiagnosisDemotionImpact }) {
  if (!impact) return null;
  if (!impact.strandedChargesComputed) {
    return (
      <div role="status" aria-live="polite" className="rounded border border-[color:var(--odos-alert)] bg-[color:var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-alert)]">
        Charge impact could not be computed. Review diagnosis links on this encounter's charges.
      </div>
    );
  }
  if (impact.strandedCharges.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="rounded border border-[color:var(--odos-amber)] bg-[color:var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-text)]">
      <div className="font-semibold">Diagnosis change affects charges</div>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {impact.strandedCharges.map((charge) => (
          <li key={charge.reference}>
            {charge.display} · {formatAmount(charge.amount)} — will not reach claim until re-pointed.
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatAmount(amount: DiagnosisDemotionImpact["strandedCharges"][number]["amount"]): string {
  if (amount?.value === undefined) return "Amount unavailable";
  if (amount.currency === "USD") return `$${amount.value.toFixed(2)}`;
  return `${amount.value.toFixed(2)}${amount.currency ? ` ${amount.currency}` : ""}`;
}
