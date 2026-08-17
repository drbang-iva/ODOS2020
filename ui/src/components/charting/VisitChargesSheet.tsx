import { useMemo } from "react";
import type { Encounter } from "@medplum/fhirtypes";
import { INTENDED_COVERAGE_EXTENSION_URL } from "../../lib/encounter-bundles";
import { computeMdmHint, type MdmHint } from "../../lib/clinical-view-model";
import type {
  ProcedureChargeApi,
  VisitChargeApi,
  VisitChargeResponse,
} from "../../lib/clinical-graph-client";
import { BalanceChips } from "../commercial/BalanceChips";
import { ExamEntrySheet } from "./ExamEntrySheet";
import { MdmProblemsAxis } from "./EncounterHeader";
import { ProcedureChargeList } from "./ProcedureChargeList";
import { VisitCodeSelector, visitProcedureFamilyForConceptKey } from "./VisitCodeSelector";

export function VisitChargesSheet({
  open,
  encounter,
  encounterId,
  patientReference,
  disabled,
  visitCharge,
  onClose,
  onVisitChargeChange,
}: {
  open: boolean;
  encounter: Encounter | undefined;
  encounterId: string;
  patientReference: string;
  disabled: boolean;
  visitCharge: VisitChargeResponse | undefined;
  onClose: () => void;
  onVisitChargeChange: (response: VisitChargeResponse | undefined) => void;
}) {
  return (
    <ExamEntrySheet sectionId="visit-charges" onCancel={onClose} active={open} hidden={!open}>
      <VisitChargesSheetContent
        encounter={encounter}
        encounterId={encounterId}
        patientReference={patientReference}
        disabled={disabled}
        visitCharge={visitCharge}
        onVisitChargeChange={onVisitChargeChange}
      />
    </ExamEntrySheet>
  );
}

export function VisitChargesSheetContent({
  encounter,
  encounterId,
  patientReference,
  disabled,
  visitCharge,
  onVisitChargeChange,
  visitApi,
  procedureApi,
}: {
  encounter: Encounter | undefined;
  encounterId: string;
  patientReference: string;
  disabled: boolean;
  visitCharge: VisitChargeResponse | undefined;
  onVisitChargeChange: (response: VisitChargeResponse | undefined) => void;
  visitApi?: VisitChargeApi;
  procedureApi?: ProcedureChargeApi;
}) {
  const mdmHint = useMemo<MdmHint | undefined>(
    () => encounter ? computeMdmHint({ encounter }) : undefined,
    [encounter],
  );

  return (
    <section className="odos-visit-charges-content" data-testid="visit-charges-content">
      <CoverageRecordedAtBooking encounter={encounter} />
      <div className="odos-visit-charges-section">
        <VisitCodeSelector
          encounterId={encounterId}
          disabled={disabled}
          api={visitApi}
          onVisitChargeChange={onVisitChargeChange}
        />
        <p className="odos-visit-charges-note">
          The linked diagnosis is the operator-selected link, not a code-support determination.
        </p>
      </div>
      {mdmHint && visitProcedureFamilyForConceptKey(visitCharge?.selectedProcedureConceptKey) === "em" && (
        <MdmProblemsAxis mdmHint={mdmHint} procedureFamily="em" />
      )}
      <div className="odos-visit-charges-section">
        <ProcedureChargeList encounterId={encounterId} disabled={disabled} api={procedureApi} />
        <p className="odos-visit-charges-note">
          Reassigning a procedure diagnosis here does not establish that a changed diagnosis stays aligned with its supporting interpretation.
        </p>
      </div>
      <div className="odos-visit-charges-section">
        <h3>Balances</h3>
        <BalanceChips patientReference={patientReference} />
      </div>
    </section>
  );
}

export function CoverageRecordedAtBooking({ encounter }: { encounter: Encounter | undefined }) {
  const references = (encounter?.extension ?? [])
    .filter((extension) => extension.url === INTENDED_COVERAGE_EXTENSION_URL)
    .map((extension) => extension.valueReference)
    .filter((reference): reference is NonNullable<typeof reference> => Boolean(reference?.reference));

  return (
    <section className="odos-booking-coverage" data-testid="booking-coverage">
      <div>
        <span>Administrative context</span>
        <h3>Coverage recorded at booking</h3>
      </div>
      {references.length > 0 ? (
        <ul>
          {references.map((reference) => (
            <li key={reference.reference}>
              {reference.reference}{reference.display ? ` · ${reference.display}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>No coverage was recorded at booking.</p>
      )}
      <small>Exact intended-coverage references recorded on the encounter from booking; not a clinical or billing identity.</small>
    </section>
  );
}
