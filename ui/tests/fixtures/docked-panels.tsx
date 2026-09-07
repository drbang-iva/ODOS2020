import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CollectPanel } from "../../src/components/CollectPanel";
import { BalancePanel } from "../../src/components/commercial/BalancePanel";
import { CreditBankDepositSheet } from "../../src/components/commercial/CreditBankDepositSheet";
import { SaleSheet } from "../../src/components/commercial/SaleSheet";
import type { PatientCreditBank, PatientPackageInstance } from "../../src/lib/commercial-engine";
import type { OpenChargeLine } from "../../src/lib/collect";
import "../../src/styles/globals.css";

const CHARGES: OpenChargeLine[] = [
  { id: "charge-1", amountCents: 10_000, openCents: 10_000, attributedCents: 0, description: "Exam balance", date: "2026-08-16", source: "other" },
];

const CREDIT_BANK: PatientCreditBank = {
  patientFhirId: "patient-1",
  balanceCents: 1_500,
  ledger: [],
};

const PACKAGES: PatientPackageInstance[] = [{
  id: "package-1",
  patientFhirId: "patient-1",
  definitionId: "definition-1",
  name: "Dry eye care",
  eligibleProcedureTypeCodes: ["dry-eye"],
  sessionCount: 4,
  priceCents: 40_000,
  expiryDate: "2027-08-16",
  refundPolicy: "store_credit_only",
  sourceSaleInvoiceId: "invoice-1",
  remainingSessions: 3,
  createdAt: "2026-08-16T12:00:00Z",
  ledger: [],
}];

type PanelName = "collect" | "balance" | "sale" | "credit";

function Fixture() {
  const panel = (new URLSearchParams(window.location.search).get("panel") ?? "collect") as PanelName;
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <main className="min-h-screen bg-black p-8 text-white">
      <button id="panel-opener" type="button" onClick={() => setOpen(true)}>Open {panel}</button>
      <button id="background-action" type="button">Background action</button>
      <output id="panel-state">{open ? "open" : "closed"}</output>
      {open && panel === "collect" && (
        <CollectPanel
          patientReference="Patient/patient-1"
          patientName="Alex Rivera"
          onClose={close}
          initialCharges={CHARGES}
        />
      )}
      {open && panel === "balance" && (
        <BalancePanel
          patientReference="Patient/patient-1"
          packages={PACKAGES}
          creditBank={CREDIT_BANK}
          canAdminister
          onPackageChanged={() => undefined}
          onClose={close}
        />
      )}
      {open && panel === "sale" && (
        <SaleSheet patientReference="Patient/patient-1" patientName="Alex Rivera" onClose={close} />
      )}
      {open && panel === "credit" && (
        <CreditBankDepositSheet patientReference="Patient/patient-1" patientName="Alex Rivera" onClose={close} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
