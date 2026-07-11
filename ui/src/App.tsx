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
import { LabOrdersWorklist } from "./scenes/LabOrdersWorklist";
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
import { OpticalPricingSettings } from "./scenes/settings/OpticalPricingSettings";
import { DeskHome, CLINIC_PATH, DESK_HOME_PATH } from "./scenes/DeskHome";
import { LoginScreen } from "./scenes/LoginScreen";
import { resolveSessionRoles, type PracticeRoleId } from "./lib/practice-roles";
import type { Patient } from "@medplum/fhirtypes";

export function App() {
  if (window.location.pathname === "/oauth2/authorize") {
    return <AuthorizeConsent />;
  }
  if (window.location.pathname === "/oauth2/grants") {
    return <GrantsManagement />;
  }

  const [authed, setAuthed] = useState(false);
  const [roles, setRoles] = useState<PracticeRoleId[]>();
  const [roleError, setRoleError] = useState<string>();
  const [path, setPath] = useState(window.location.pathname);
  const view = useViewState((state) => state.view);

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  useEffect(() => {
    if (!authed) return;
    let active = true;
    resolveSessionRoles()
      .then((whoami) => {
        if (!active) return;
        const destination = defaultHomePath(whoami.roles);
        setRoles(whoami.roles);
        window.history.replaceState({}, "", destination);
        setPath(destination);
      })
      .catch((error) => active && setRoleError(error instanceof Error ? error.message : "Practice role lookup failed."));
    return () => { active = false; };
  }, [authed]);

  if (!authed) {
    return <LoginScreen returnTo="/" onAuthenticated={() => setAuthed(true)} />;
  }

  if (roleError) return <main role="alert">Unable to open your practice home: {roleError}</main>;
  if (!roles) return <main>Opening your practice home…</main>;

  return (
    <RoleProvider>
      <RouteSwitch view={view} path={path} roles={roles} />
    </RoleProvider>
  );
}

export function defaultHomePath(roles: readonly PracticeRoleId[]): typeof CLINIC_PATH | typeof DESK_HOME_PATH {
  return roles.includes("clinician") || roles.includes("aesthetics-provider") ? CLINIC_PATH : DESK_HOME_PATH;
}

export function hasCrossSideAccess(roles: readonly PracticeRoleId[]): boolean {
  return roles.includes("front-desk") && defaultHomePath(roles) === CLINIC_PATH;
}

export function openOtherSide(path: typeof CLINIC_PATH | typeof DESK_HOME_PATH, open = window.open): void {
  open(path, "_blank", "noopener,noreferrer");
}

export function RoleSwitchPill({ target, open }: { target: typeof CLINIC_PATH | typeof DESK_HOME_PATH; open?: typeof window.open }) {
  const label = target === CLINIC_PATH ? "Clinic" : "Desk";
  return <button className="odos-pill odos-clinic-pill" type="button" onClick={() => openOtherSide(target, open ?? window.open)}>Switch to {label} <span aria-hidden>↗</span></button>;
}

export function RouteSwitch({ view, path = window.location.pathname, roles = [] }: { view: ViewState; path?: string; roles?: readonly PracticeRoleId[] }) {
  const showSwitch = hasCrossSideAccess(roles);
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
    case "/dispensary/lab-orders":
      return <LabOrdersWorklist />;
    case "/schedule/day":
    case "/scheduler/day":
      return <SchedulerDayGrid />;
    case "/frontdesk":
      return <FrontDeskCockpit />;
    case DESK_HOME_PATH:
      return <DeskHome switchPill={showSwitch ? <RoleSwitchPill target={CLINIC_PATH} /> : null} />;
    case CLINIC_PATH:
      return <><div className="odos-clinic-switch">{showSwitch && <RoleSwitchPill target={DESK_HOME_PATH} />}</div><ViewRouter view={view} /></>;
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
    case "/settings/optical-pricing":
      return <OpticalPricingSettings />;
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
