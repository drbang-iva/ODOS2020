import { useEffect, useState } from "react";
import {
  fetchApplicablePackages,
  redeemPackage,
  type PatientPackageInstance,
} from "../../lib/commercial-engine";

export function CheckoutRedeem({
  patientReference,
  chargeItemReference,
  procedureReference,
  procedureCode,
  revision = 0,
  onRedeemed,
}: {
  patientReference: string;
  chargeItemReference: string;
  procedureReference?: string;
  procedureCode?: string;
  revision?: number;
  onRedeemed?: (packageInstance: PatientPackageInstance) => void;
}) {
  const [packages, setPackages] = useState<PatientPackageInstance[]>([]);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  useEffect(() => {
    if (!procedureReference || !procedureCode) {
      setPackages([]);
      return;
    }
    let cancelled = false;
    fetchApplicablePackages(patientReference, procedureCode)
      .then((items) => !cancelled && setPackages(items))
      .catch((cause) => !cancelled && setError(messageOf(cause)));
    return () => { cancelled = true; };
  }, [patientReference, procedureCode, procedureReference, revision]);

  if (!procedureReference || !procedureCode || (packages.length === 0 && !error && !done)) return null;
  async function apply(instance: PatientPackageInstance) {
    if (done) return;
    setBusyId(instance.id);
    setError(undefined);
    try {
      const result = await redeemPackage({
        patientReference,
        packageInstanceId: instance.id,
        procedureReference: procedureReference!,
        chargeItemReference,
      });
      setPackages((current) => current.map((item) => item.id === result.package.id ? result.package : item).filter((item) => item.remainingSessions > 0));
      setDone(`Package credit applied · ${result.invoiceReference}`);
      onRedeemed?.(result.package);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusyId(undefined);
    }
  }
  return (
    <div className="mt-2 grid gap-2">
      {packages.map((instance) => (
        <button key={instance.id} type="button" disabled={Boolean(busyId) || Boolean(done)} onClick={() => void apply(instance)} className="rounded border border-cyan-300/25 bg-cyan-950/20 px-3 py-2 text-left text-xs text-cyan-100 disabled:opacity-40">
          <strong>Package available: {instance.name}</strong> — {instance.remainingSessions} of {instance.sessionCount} remaining
          <span className="ml-2 font-bold">Apply credit</span>
        </button>
      ))}
      {done && <p role="status" className="text-xs text-emerald-300">{done}</p>}
      {error && <p role="alert" className="text-xs text-red-200">{error}</p>}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
