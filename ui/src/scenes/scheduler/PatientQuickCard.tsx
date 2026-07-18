import type { Appointment, Bundle, Encounter, Invoice, Patient, PaymentReconciliation } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import { fhir } from "../../lib/fhir";
import { useSchedulingStore } from "../../lib/scheduling-store";
import { patientQuickCardViewModel } from "../../lib/scheduler-appointment-ui";
import { BalanceChips } from "../../components/commercial/BalanceChips";

export function PatientQuickCard({
  appointment,
  pinned,
  onPinnedChange,
  onClose,
  onDetails,
  date,
}: {
  appointment: Appointment | null;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onClose: () => void;
  onDetails: (appointment: Appointment) => void;
  date: string;
}) {
  const patientReference = patientReferenceOf(appointment);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [lastExamDate, setLastExamDate] = useState<string>("unknown");
  const [openInvoiceCount, setOpenInvoiceCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = Boolean(appointment);

  const updateAppointment = useSchedulingStore((state) => state.updateAppointment);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleCheckIn() {
    if (!appointment) return;
    setActionError(null);
    try {
      await updateAppointment(appointment, { status: "checked-in", floorStation: "waiting" });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCheckOut() {
    if (!appointment) return;
    setActionError(null);
    try {
      await updateAppointment(appointment, { status: "checked-out", floorStation: null });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!patientReference) {
      setPatient(null);
      setLastExamDate("unknown");
      setOpenInvoiceCount(null);
      setError(null);
      return;
    }
    const id = patientReference.split("/")[1];
    if (!id) return;
    const subject = patientReference;
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        const [patientResource, encounters, openInvoices] = await Promise.all([
          fhir.read<Patient>("Patient", id),
          fhir.search<Encounter>("Encounter", {
            patient: id,
            status: "finished",
            _sort: "-date",
            _count: "1",
          }),
          loadOpenInvoiceCount(subject),
        ]);
        if (cancelled) return;
        setPatient(patientResource);
        const encounter = encounters.entry?.[0]?.resource;
        setLastExamDate(encounter?.period?.start?.slice(0, 10) ?? "unknown");
        setOpenInvoiceCount(openInvoices);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setPatient(null);
          setLastExamDate("unknown");
          setOpenInvoiceCount(null);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [patientReference]);

  const viewModel = useMemo(
    () => (patient ? patientQuickCardViewModel({ patient, onDate: date }) : null),
    [date, patient],
  );

  if (!visible || !appointment) {
    return null;
  }

  return (
    <aside className="fixed bottom-0 left-0 top-0 z-40 w-full max-w-sm border-r border-white/15 bg-[#10111c] text-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <div className="text-xs uppercase text-white/45">Patient Quick Card</div>
          <h2 className="text-lg font-semibold">
            {viewModel?.name ?? appointment.description ?? "Non-patient block"}
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            className="scheduler-icon-button"
            type="button"
            aria-label={pinned ? "Unpin quick card" : "Pin quick card"}
            onClick={() => onPinnedChange(!pinned)}
          >
            {pinned ? "!" : "+"}
          </button>
          <button className="scheduler-icon-button" type="button" aria-label="Close quick card" onClick={onClose}>
            x
          </button>
        </div>
      </header>

      <div className="grid gap-3 p-4 text-sm">
        {error && (
          <div className="border border-red-400/40 bg-red-950/50 px-3 py-2 text-red-100">
            {error}
          </div>
        )}

        {!patientReference && (
          <div className="border border-white/10 bg-black/20 p-3 text-white/70">
            {appointment.description ?? "Non-patient block"}
          </div>
        )}

        {patientReference && !viewModel && !error && (
          <div className="border border-white/10 bg-black/20 p-3 text-white/55">Loading patient</div>
        )}

        {viewModel && (
          <>
            {patientReference && <BalanceChips patientReference={patientReference} />}
            <QuickCardRow label="DOB + Age" value={`${viewModel.birthDate} (${viewModel.age ?? "unknown"})`} />
            <QuickCardRow label="Birth Sex" value={viewModel.birthSex} />
            <QuickCardRow label="Phone" value={viewModel.phones.join(", ") || "none"} />
            <QuickCardRow label="Email" value={viewModel.emails.join(", ") || "none"} />
            <QuickCardRow label="Address" value={viewModel.address} />
            <QuickCardRow label="MRN" value={viewModel.mrn} />
            <QuickCardRow label="SSN" value={viewModel.ssnLast4} />
            <QuickCardRow label="Provider" value={viewModel.provider} />
            <QuickCardRow label="Last Exam" value={lastExamDate} />
            <QuickCardRow
              label="Patient Balance"
              value={
                openInvoiceCount === null ? "Open invoices: unknown" : `Open invoices: ${openInvoiceCount}`
              }
            />
          </>
        )}

        {actionError && (
          <div className="border border-red-400/40 bg-red-950/50 px-3 py-2 text-red-100">
            {actionError}
          </div>
        )}

        {patientReference && (
          <div className="flex gap-2">
            <button className="scheduler-button" type="button" onClick={() => void handleCheckIn()}>
              Check In
            </button>
            <button className="scheduler-button" type="button" onClick={() => void handleCheckOut()}>
              Check Out
            </button>
          </div>
        )}

        <button className="scheduler-button mt-2" type="button" onClick={() => onDetails(appointment)}>
          Details
        </button>
      </div>
    </aside>
  );
}

function QuickCardRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-white/10 pb-2">
      <div className="text-xs uppercase text-white/40">{label}</div>
      <div className="break-words text-white/80">{value}</div>
    </div>
  );
}

function patientReferenceOf(appointment: Appointment | null): string | undefined {
  return appointment?.participant.find((participant) =>
    participant.actor?.reference?.startsWith("Patient/"),
  )?.actor?.reference;
}

async function loadOpenInvoiceCount(subject: string): Promise<number> {
  const invoices = await fhir.search<Invoice>("Invoice", {
    subject,
    status: "issued",
    _count: "100",
    _elements: "id",
  });
  const invoiceReferences = (invoices.entry ?? [])
    .map((entry) => entry.resource?.id)
    .filter((id): id is string => Boolean(id))
    .map((id) => `Invoice/${id}`);
  const settled = await Promise.all(
    invoiceReferences.map(async (invoiceReference) => {
      const reconciliations = await fhir.search<PaymentReconciliation>("PaymentReconciliation", {
        request: invoiceReference,
        _summary: "count",
      });
      return bundleTotal(reconciliations) > 0;
    }),
  );
  return settled.filter((isSettled) => !isSettled).length;
}

function bundleTotal(bundle: Bundle): number {
  return typeof bundle.total === "number" ? bundle.total : (bundle.entry ?? []).length;
}
