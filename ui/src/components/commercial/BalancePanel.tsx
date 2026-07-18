import type { PatientPackageInstance } from "../../lib/commercial-engine";

export function BalancePanel({ packages, onClose }: { packages: readonly PatientPackageInstance[]; onClose: () => void }) {
  return (
    <aside role="dialog" aria-modal="true" aria-label="Package balances" className="fixed inset-y-0 right-0 z-[65] flex w-[min(660px,100vw)] flex-col overflow-y-auto border-l border-white/15 bg-[#0c0c18] text-white shadow-2xl">
      <header className="flex items-start justify-between border-b border-white/10 px-5 py-4">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300/70">Prepaid care</p><h2 className="mt-1 text-xl font-semibold">Package balances</h2></div>
        <button type="button" aria-label="Close package balances" onClick={onClose}>✕</button>
      </header>
      <div className="grid gap-4 p-5">
        {packages.map((instance) => (
          <article key={instance.id} className="rounded border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="font-semibold">{instance.name}</h3><p className="mt-1 text-sm text-white/50">Expires {localDate(instance.expiryDate)} · sold on Invoice/{instance.sourceSaleInvoiceId}</p></div>
              <span className="rounded-full border border-cyan-300/30 bg-cyan-950/30 px-3 py-1 text-sm font-bold text-cyan-100">{instance.remainingSessions} of {instance.sessionCount} remaining</span>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead className="text-white/40"><tr><th className="pb-2">Date</th><th className="pb-2">Entry</th><th className="pb-2 text-right">Sessions</th><th className="pb-2">Linked record</th></tr></thead>
                <tbody className="divide-y divide-white/10">
                  {[...instance.ledger].reverse().map((entry) => (
                    <tr key={entry.id}>
                      <td className="py-2">{localDateTime(entry.createdAt)}</td>
                      <td className="py-2 capitalize">{entry.entryType}{entry.reason ? ` · ${entry.reason}` : ""}</td>
                      <td className="py-2 text-right font-bold">{entry.sessionsDelta > 0 ? "+" : ""}{entry.sessionsDelta}</td>
                      <td className="py-2 text-white/55">{[
                        entry.linkedFhirProcedureId ? `Procedure/${entry.linkedFhirProcedureId}` : undefined,
                        entry.linkedFhirInvoiceId ? `Invoice/${entry.linkedFhirInvoiceId}` : undefined,
                      ].filter(Boolean).join(" · ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
        {packages.length === 0 && <p className="rounded border border-dashed border-white/10 p-8 text-center text-sm text-white/40">No packages have been sold to this patient.</p>}
      </div>
    </aside>
  );
}

function localDate(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString();
}

function localDateTime(value: string): string {
  return new Date(value).toLocaleString();
}
