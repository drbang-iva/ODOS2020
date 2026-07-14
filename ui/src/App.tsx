import { useEffect, useRef, useState, type ComponentType } from "react";
import { EncounterCharting } from "./scenes/EncounterCharting";
import { AuditLog } from "./scenes/AuditLog";
import { PatientDirector } from "./scenes/PatientDirector";
import { PatientOverview } from "./scenes/PatientOverview";
import { PatientPicker } from "./scenes/PatientPicker";
import { NewPatient } from "./scenes/NewPatient";
import { fhir } from "./lib/fhir";
import { RoleProvider } from "./lib/role-context";
import { patientOverviewView, useViewState, type ViewState } from "./lib/view-state";
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
import { Statements } from "./scenes/claims/Statements";
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
import { StaffSettings } from "./scenes/settings/StaffSettings";
import { DeskHome, CLINIC_PATH, DESK_HOME_PATH } from "./scenes/DeskHome";
import { ClinicHome, CLINIC_PATIENTS_PATH } from "./scenes/ClinicHome";
import { ClinicOfficeShell } from "./components/OfficeChannel";
import { LoginScreen } from "./scenes/LoginScreen";
import { SetPasswordScreen } from "./scenes/SetPasswordScreen";
import { resolveSessionRoles, type PracticeRoleId, type WhoAmIResponse } from "./lib/practice-roles";
import { interceptAppNavigation } from "./lib/navigation";
import type { Patient } from "@medplum/fhirtypes";

export function App({
  resolveRoles = resolveSessionRoles,
  login = fhir.login,
  RouteComponent = RouteSwitch,
}: {
  resolveRoles?: () => Promise<WhoAmIResponse>;
  login?: (email: string, password: string) => Promise<void>;
  RouteComponent?: ComponentType<RouteSwitchProps>;
} = {}) {
  const setPasswordRoute = parseSetPasswordPath(window.location.pathname);
  if (setPasswordRoute) {
    return <SetPasswordScreen id={setPasswordRoute.id} secret={setPasswordRoute.secret} />;
  }
  if (window.location.pathname === "/oauth2/authorize") {
    return <AuthorizeConsent />;
  }
  if (window.location.pathname === "/oauth2/grants") {
    return <GrantsManagement />;
  }

  const [authed, setAuthed] = useState(() => fhir.rehydrateSession());
  const [roles, setRoles] = useState<PracticeRoleId[]>();
  const [roleError, setRoleError] = useState<string>();
  const [path, setPath] = useState(window.location.pathname);
  const view = useViewState((state) => state.view);
  const setView = useViewState((state) => state.setView);
  const previousPath = useRef(path);
  const initialSearch = useRef(window.location.search);
  const initialClinicView = useRef(clinicViewFromSearch(initialSearch.current, { kind: "picker" }));

  useEffect(() => {
    const updatePath = () => {
      const nextPath = window.location.pathname;
      setView(clinicViewAfterNavigation(previousPath.current, nextPath, useViewState.getState().view));
      previousPath.current = nextPath;
      setPath(nextPath);
    };
    const interceptLink = (event: MouseEvent) => {
      if (interceptAppNavigation(event)) updatePath();
    };
    window.addEventListener("popstate", updatePath);
    window.addEventListener("click", interceptLink);
    return () => {
      window.removeEventListener("popstate", updatePath);
      window.removeEventListener("click", interceptLink);
    };
  }, [setView]);

  useEffect(() => {
    const stopIntercepting = fhir.interceptUnauthorizedResponses(window);
    const stopListening = fhir.onSessionCleared(() => {
      setAuthed(false);
      setRoles(undefined);
      setRoleError(undefined);
    });
    return () => {
      stopListening();
      stopIntercepting();
    };
  }, []);

  useEffect(() => {
    if (!authed) return;
    let active = true;
    resolveRoles()
      .then((whoami) => {
        if (!active) return;
        const destination = defaultHomePath(whoami.roles);
        const clinicDeepLink = initialClinicView.current.kind !== "picker";
        const destinationUrl = clinicDeepLink ? `${CLINIC_PATH}${initialSearch.current}` : destination;
        const renderedPath = clinicDeepLink ? CLINIC_PATH : destination;
        setRoles(whoami.roles);
        if (clinicDeepLink) setView(initialClinicView.current);
        window.history.replaceState({}, "", destinationUrl);
        previousPath.current = renderedPath;
        setPath(renderedPath);
      })
      .catch((error) => {
        if (active && fhir.isAuthenticated()) {
          setRoleError(error instanceof Error ? error.message : "Practice role lookup failed.");
        }
      });
    return () => { active = false; };
  }, [authed, resolveRoles, setView]);

  if (!authed) {
    const returnTo = initialClinicView.current.kind === "picker" ? "/" : `${CLINIC_PATH}${initialSearch.current}`;
    return <LoginScreen returnTo={returnTo} onAuthenticated={() => setAuthed(true)} login={login} />;
  }

  if (roleError) return <main role="alert">Unable to open your practice home: {roleError}</main>;
  if (!roles) return <main>Opening your practice home…</main>;

  return (
    <RoleProvider>
      <RouteComponent view={view} path={path} roles={roles} />
    </RoleProvider>
  );
}

export function parseSetPasswordPath(pathname: string): { id: string; secret: string } | undefined {
  const match = pathname.match(/^\/setpassword\/([^/]+)\/([^/]+)$/);
  if (!match) return undefined;
  try {
    return { id: decodeURIComponent(match[1]), secret: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}

export function defaultHomePath(roles: readonly PracticeRoleId[]): typeof CLINIC_PATH | typeof DESK_HOME_PATH {
  if (roles.includes("front-desk") || roles.includes("practice-admin")) return DESK_HOME_PATH;
  return roles.includes("clinician") || roles.includes("aesthetics-provider") ? CLINIC_PATH : DESK_HOME_PATH;
}

export function hasCrossSideAccess(roles: readonly PracticeRoleId[]): boolean {
  const hasDeskSideRole = roles.includes("front-desk") || roles.includes("practice-admin");
  const hasClinicSideRole = roles.includes("clinician") || roles.includes("aesthetics-provider");
  return hasDeskSideRole && hasClinicSideRole;
}

export function shouldResetClinicView(previousPath: string, nextPath: string): boolean {
  return (previousPath === CLINIC_PATH || previousPath === CLINIC_PATIENTS_PATH) && previousPath !== nextPath;
}

export function clinicViewAfterNavigation(previousPath: string, nextPath: string, view: ViewState): ViewState {
  return shouldResetClinicView(previousPath, nextPath) ? { kind: "picker" } : view;
}

export function clinicViewFromSearch(search: string, fallback: ViewState): ViewState {
  const params = new URLSearchParams(search);
  const patientId = params.get("patientId")?.trim();
  if (!patientId) return fallback;
  const encounterId = params.get("encounterId")?.trim();
  return encounterId
    ? { kind: "encounter", patientId, encounterId }
    : patientOverviewView(patientId);
}

export function clinicRouteView(search: string, view: ViewState): ViewState {
  return view.kind === "picker" ? clinicViewFromSearch(search, view) : view;
}

export function openOtherSide(path: typeof CLINIC_PATH | typeof DESK_HOME_PATH): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event("popstate"));
}

export function RoleSwitchPill({ target }: { target: typeof CLINIC_PATH | typeof DESK_HOME_PATH }) {
  const label = target === CLINIC_PATH ? "Clinic" : "Desk";
  return <button className="odos-pill odos-clinic-pill" type="button" onClick={() => openOtherSide(target)}>Switch to {label} <span aria-hidden>→</span></button>;
}

export interface RouteSwitchProps {
  view: ViewState;
  path?: string;
  roles?: readonly PracticeRoleId[];
  search?: string;
}

export function RouteSwitch({
  view,
  path = window.location.pathname,
  roles = [],
  search = typeof window === "undefined" ? "" : window.location.search,
}: RouteSwitchProps) {
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
      return (
        <ClinicOfficeShell location="The Clinic · Orders" roles={roles} switchPill={showSwitch ? <RoleSwitchPill target={DESK_HOME_PATH} /> : null}>
          <LabOrdersWorklist />
        </ClinicOfficeShell>
      );
    case "/schedule/day":
    case "/scheduler/day":
      return <SchedulerDayGrid />;
    case "/frontdesk":
      return <FrontDeskCockpit />;
    case DESK_HOME_PATH:
      return <DeskHome switchPill={showSwitch ? <RoleSwitchPill target={CLINIC_PATH} /> : null} />;
    case CLINIC_PATH: {
      const clinicView = clinicRouteView(search, view);
      return (
        <ClinicOfficeShell location={clinicLocation(clinicView)} roles={roles} switchPill={showSwitch ? <RoleSwitchPill target={DESK_HOME_PATH} /> : null}>
          {clinicView.kind === "picker" ? <ClinicHome /> : <ViewRouter view={clinicView} />}
        </ClinicOfficeShell>
      );
    }
    case CLINIC_PATIENTS_PATH:
      return <ViewRouter view={view.kind === "picker" ? view : { kind: "picker" }} />;
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
    case "/billing/statements":
      return <Statements />;
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
      return <SettingsIndex roles={roles} />;
    case "/settings/staff":
      return roles.includes("practice-admin")
        ? <StaffSettings />
        : <main role="alert">Practice-admin access is required to manage staff.</main>;
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

function clinicLocation(view: ViewState): string {
  if (view.kind === "picker") return "Clinic home";
  if (view.kind === "overview") return "Patient overview";
  if (view.kind === "director") return "Patient director";
  return "Encounter";
}

function ViewRouter({ view }: { view: ViewState }) {
  switch (view.kind) {
    case "picker":
      return <PatientPicker />;
    case "overview":
      return <PatientRoute patientId={view.patientId} mode="overview" />;
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
  mode: "overview" | "director" | "encounter";
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

  if (mode === "overview") {
    return <PatientOverview patient={patient} />;
  }

  return <PatientDirector patient={patient} />;
}
