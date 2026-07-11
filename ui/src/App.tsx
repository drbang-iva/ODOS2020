import { useEffect, useState } from "react";
import { EncounterCharting } from "./scenes/EncounterCharting";
import { AuditLog } from "./scenes/AuditLog";
import { PatientDirector } from "./scenes/PatientDirector";
import { PatientPicker } from "./scenes/PatientPicker";
import { NewPatient } from "./scenes/NewPatient";
import { fhir } from "./lib/fhir";
import { RoleProvider } from "./lib/role-context";
import { useViewState, type ViewState } from "./lib/view-state";
import { AuthorizeConsent } from "./smart/authorize-consent";
import { GrantsManagement } from "./smart/grants-management";
import { OpticalFrames } from "./scenes/OpticalFrames";
import { OpticalOrder } from "./scenes/OpticalOrder";
import { SchedulerDayGrid } from "./scenes/SchedulerDayGrid";
import { FrontDeskCockpit } from "./scenes/frontdesk/FrontDeskCockpit";
import { ClaimsWorklist } from "./scenes/claims/ClaimsWorklist";
import { ClaimSearch } from "./scenes/claims/ClaimSearch";
import { RemittanceQueue } from "./scenes/claims/RemittanceQueue";
import { SubmitClaims } from "./scenes/claims/SubmitClaims";
import { CarrierPayments } from "./scenes/claims/CarrierPayments";
import { PatientPayments } from "./scenes/claims/PatientPayments";
import { ChartFieldsSettings } from "./scenes/ChartFieldsSettings";
import { PatientInsurance } from "./scenes/insurance/PatientInsurance";
import { VisionPlanBenefits } from "./scenes/insurance/VisionPlanBenefits";
import { AccountsReceivableDashboard } from "./scenes/claims/AccountsReceivableDashboard";
import { SettingsIndex } from "./scenes/settings/SettingsIndex";
import { FloorConfigSettings } from "./scenes/settings/FloorConfigSettings";
import { VisionPlanTemplatesSettings } from "./scenes/settings/VisionPlanTemplatesSettings";
import { VisitTypeSettings } from "./scenes/settings/VisitTypeSettings";
import { DiagnosisSettings } from "./scenes/settings/DiagnosisSettings";
import { DeskHome, CLINIC_PATH, DESK_HOME_PATH } from "./scenes/DeskHome";
import { LoginScreen } from "./scenes/LoginScreen";
import type { Patient } from "@medplum/fhirtypes";

export function App() {
  if (window.location.pathname === "/oauth2/authorize") {
    return <AuthorizeConsent />;
  }
  if (window.location.pathname === "/oauth2/grants") {
    return <GrantsManagement />;
  }

  const [authed, setAuthed] = useState(false);
  const [path, setPath] = useState(window.location.pathname);
  const view = useViewState((state) => state.view);

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  if (!authed) {
    const returnTo = window.location.pathname === CLINIC_PATH ? CLINIC_PATH : DESK_HOME_PATH;
    return <LoginScreen returnTo={returnTo} onAuthenticated={() => setAuthed(true)} />;
  }

  return (
    <RoleProvider>
      <RouteSwitch view={view} path={path} />
    </RoleProvider>
  );
}

export function RouteSwitch({ view, path = window.location.pathname }: { view: ViewState; path?: string }) {
  switch (path) {
    case "/audit/log":
      return <AuditLog />;
    case "/admin/optical/catalog/frames":
      return <OpticalFrames route="catalog" />;
    case "/admin/optical/inventory/frames":
      return <OpticalFrames route="inventory" />;
    case "/dispensary/lookup":
      return <OpticalFrames route="lookup" />;
    case "/dispensary/orders":
      return <OpticalOrder />;
    case "/schedule/day":
    case "/scheduler/day":
      return <SchedulerDayGrid />;
    case "/frontdesk":
      return <FrontDeskCockpit />;
    case DESK_HOME_PATH:
      return <DeskHome />;
    case CLINIC_PATH:
      return <ViewRouter view={view} />;
    case "/billing/claims/worklist":
      return <ClaimsWorklist />;
    case "/billing/claims/search":
      return <ClaimSearch />;
    case "/billing/claims/remittances":
      return <RemittanceQueue />;
    case "/billing/claims/submit":
      return <SubmitClaims />;
    case "/billing/claims/carrier-payments":
      return <CarrierPayments />;
    case "/billing/claims/patient-payments":
      return <PatientPayments />;
    case "/patient/insurance":
      return <PatientInsurance initialPatientId={new URLSearchParams(window.location.search).get("patientId") ?? undefined} />;
    case "/patient/new":
      return <NewPatient />;
    case "/patient/vision-benefits":
      return <VisionPlanBenefits initialPatientId={new URLSearchParams(window.location.search).get("patientId") ?? undefined} />;
    case "/billing/claims/reports/accounts-receivable":
      return <AccountsReceivableDashboard />;
    case "/admin/practice/settings/frames-data":
      return <OpticalFrames route="settings" />;
    case "/settings/chart-fields-sections":
    case "/admin/practice/settings/chart-fields":
      return <ChartFieldsSettings />;
    case "/settings":
      return <SettingsIndex />;
    case "/settings/floor-config":
      return <FloorConfigSettings />;
    case "/settings/vision-plan-templates":
      return <VisionPlanTemplatesSettings />;
    case "/settings/visit-types":
      return <VisitTypeSettings />;
    case "/settings/suggested-diagnoses":
      return <DiagnosisSettings />;
    default:
      return <ViewRouter view={view} />;
  }
}

function ViewRouter({ view }: { view: ViewState }) {
  switch (view.kind) {
    case "picker":
      return <PatientPicker />;
    case "director":
      return <PatientRoute patientId={view.patientId} mode="director" />;
    case "encounter":
      return (
        <PatientRoute
          patientId={view.patientId}
          mode="encounter"
          encounterId={view.encounterId}
        />
      );
  }
}

function PatientRoute({
  patientId,
  mode,
  encounterId,
}: {
  patientId: string;
  mode: "director" | "encounter";
  encounterId?: string;
}) {
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPatient() {
      setPatient(null);
      setError(null);
      try {
        const loaded = await fhir.read<Patient>("Patient", patientId);
        if (!cancelled) setPatient(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void loadPatient();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  if (error) {
    return (
      <div className="h-screen grid place-items-center p-8">
        <div className="bg-bg-panel border border-red-500/50 rounded-lg p-6 max-w-xl">
          <h1 className="text-red-400 text-lg font-semibold mb-2">Unable to load patient</h1>
          <pre className="text-sm text-red-200 whitespace-pre-wrap">{error}</pre>
        </div>
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="h-screen grid place-items-center">
        <div className="text-white/60">Loading patient…</div>
      </div>
    );
  }

  if (mode === "encounter") {
    return <EncounterCharting patient={patient} encounterId={encounterId ?? ""} />;
  }

  return <PatientDirector patient={patient} />;
}
