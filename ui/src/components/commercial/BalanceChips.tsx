import { useEffect, useState } from "react";
import { fetchPatientPackages, type PatientPackageInstance } from "../../lib/commercial-engine";
import { BalancePanel } from "./BalancePanel";
import { fhir } from "../../lib/fhir";

export function BalanceChips({ patientReference, revision = 0 }: { patientReference: string; revision?: number }) {
  const [packages, setPackages] = useState<PatientPackageInstance[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!fhir.authHeader()) return;
    let cancelled = false;
    fetchPatientPackages(patientReference)
      .then((items) => !cancelled && setPackages(items))
      .catch((error) => console.error("Patient package balances unavailable.", error));
    return () => { cancelled = true; };
  }, [patientReference, revision]);

  const active = packages.filter((instance) => instance.remainingSessions > 0 && instance.expiryDate >= new Date().toISOString().slice(0, 10));
  const shown = active.slice(0, 2);
  if (packages.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="Patient package balances">
      {shown.map((instance) => (
        <button key={instance.id} type="button" onClick={() => setPanelOpen(true)} className="rounded-full border border-cyan-300/25 bg-cyan-950/25 px-3 py-1.5 text-xs font-semibold text-cyan-100">
          {shortName(instance.name)} {dots(instance.remainingSessions, instance.sessionCount)} {instance.remainingSessions} of {instance.sessionCount} · exp {shortDate(instance.expiryDate)}
        </button>
      ))}
      {active.length > shown.length && <button type="button" onClick={() => setPanelOpen(true)} className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/60">+{active.length - shown.length} more</button>}
      {active.length === 0 && <button type="button" onClick={() => setPanelOpen(true)} className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/50">Package history</button>}
      {panelOpen && <BalancePanel packages={packages} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}

function dots(remaining: number, total: number): string {
  const visible = Math.min(total, 6);
  return `${"●".repeat(Math.min(remaining, visible))}${"○".repeat(Math.max(0, visible - remaining))}`;
}

function shortName(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}
