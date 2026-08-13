import { useEffect, useState } from "react";
import {
  fetchCreditBank,
  fetchPatientPackages,
  type PatientCreditBank,
  type PatientPackageInstance,
} from "../../lib/commercial-engine";
import { BalancePanel } from "./BalancePanel";
import { fhir } from "../../lib/fhir";
import { resolveSessionRoles } from "../../lib/practice-roles";

export function BalanceChips({
  patientReference,
  revision = 0,
  onBalanceChanged,
}: {
  patientReference: string;
  revision?: number;
  onBalanceChanged?: () => void;
}) {
  const [packages, setPackages] = useState<PatientPackageInstance[]>([]);
  const [creditBank, setCreditBank] = useState<PatientCreditBank>();
  const [canAdminister, setCanAdminister] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!fhir.authHeader()) return;
    let cancelled = false;
    void Promise.allSettled([
      fetchPatientPackages(patientReference),
      fetchCreditBank(patientReference),
      resolveSessionRoles(),
    ])
      .then(([packageResult, bankResult, sessionResult]) => {
        if (cancelled) return;
        if (packageResult.status === "fulfilled") setPackages(packageResult.value);
        else console.error("Patient package balances unavailable.", packageResult.reason);
        if (bankResult.status === "fulfilled") setCreditBank(bankResult.value);
        else console.error("Patient Credit Bank balance unavailable.", bankResult.reason);
        setCanAdminister(
          sessionResult.status === "fulfilled"
          && sessionResult.value.roles.includes("admin"),
        );
      });
    return () => { cancelled = true; };
  }, [patientReference, revision]);

  const active = packages.filter((instance) => instance.remainingSessions > 0 && instance.expiryDate >= new Date().toISOString().slice(0, 10));
  const shown = active.slice(0, 2);
  if (packages.length === 0 && !creditBank?.ledger.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="Patient prepaid balances">
      {creditBank && creditBank.ledger.length > 0 && (
        <button type="button" onClick={() => setPanelOpen(true)} className="rounded-full border border-emerald-300/25 bg-emerald-950/25 px-3 py-1.5 text-xs font-semibold text-emerald-100">
          Credit Bank · {money(creditBank.balanceCents)}
        </button>
      )}
      {shown.map((instance) => (
        <button key={instance.id} type="button" onClick={() => setPanelOpen(true)} className="rounded-full border border-cyan-300/25 bg-cyan-950/25 px-3 py-1.5 text-xs font-semibold text-cyan-100">
          {shortName(instance.name)} {dots(instance.remainingSessions, instance.sessionCount)} {instance.remainingSessions} of {instance.sessionCount} · exp {shortDate(instance.expiryDate)}
        </button>
      ))}
      {active.length > shown.length && <button type="button" onClick={() => setPanelOpen(true)} className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/60">+{active.length - shown.length} more</button>}
      {active.length === 0 && <button type="button" onClick={() => setPanelOpen(true)} className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/50">Package history</button>}
      {panelOpen && (
        <BalancePanel
          patientReference={patientReference}
          packages={packages}
          creditBank={creditBank ?? { patientFhirId: patientReference.replace(/^Patient\//, ""), balanceCents: 0, ledger: [] }}
          canAdminister={canAdminister}
          onPackageChanged={(nextPackage, nextBank) => {
            setPackages((current) => current.map((item) => item.id === nextPackage.id ? nextPackage : item));
            if (nextBank) setCreditBank(nextBank);
            onBalanceChanged?.();
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
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
