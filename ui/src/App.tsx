import { useEffect, useRef, useState, type ComponentType } from "react";
import { EncounterCharting } from "./scenes/EncounterCharting";
import { ProcedureDefinitionsSettings } from "./scenes/settings/ProcedureDefinitionsSettings";
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
import { PatientPharmacy } from "./scenes/pharmacy/PatientPharmacy";
import { AccountsReceivableDashboard } from "./scenes/claims/AccountsReceivableDashboard";
import { SettingsIndex } from "./scenes/settings/SettingsIndex";
import { FloorConfigSettings } from "./scenes/settings/FloorConfigSettings";
import { VisionPlanTemplatesSettings } from "./scenes/settings/VisionPlanTemplatesSettings";
import { VisitTypeSettings } from "./scenes/settings/VisitTypeSettings";
import { DiagnosisSettings } from "./scenes/settings/DiagnosisSettings";
import { OpticalPricingSettings } from "./scenes/settings/OpticalPricingSettings";
import { FeeScheduleSettings } from "./scenes/settings/FeeScheduleSettings";
import { LensCatalogSettings } from "./scenes/settings/LensCatalogSettings";
import { PlanProfilesSettings } from "./scenes/settings/PlanProfilesSettings";
import { StaffSettings } from "./scenes/settings/StaffSettings";
import { PackageDefinitionsSettings } from "./components/commercial/PackageDefinitionsSettings";
import { ProtocolDefinitionsSettings } from "./components/series-tracker/ProtocolDefinitionsSettings";
import { StatementMessagesSettings } from "./scenes/settings/StatementMessagesSettings";
import { BillingIdentitySettings } from "./scenes/settings/BillingIdentitySettings";
import { AppearanceSettings } from "./scenes/settings/AppearanceSettings";
import { ProtocolLibrary } from "./scenes/ProtocolLibrary";
import { DeskHome, CLINIC_PATH, DESK_HOME_PATH } from "./scenes/DeskHome";
import { DayLedger } from "./scenes/DayLedger";
import { MarginLedger } from "./scenes/MarginLedger";
import { CloseDay, DaySealArchive } from "./scenes/CloseDay";
import { ClinicHome, CLINIC_PATIENTS_PATH } from "./scenes/ClinicHome";
import { OfficeChannelShell } from "./components/OfficeChannel";
import { AppShell, type AppShellSide } from "./components/AppShell";
import { LoginScreen } from "./scenes/LoginScreen";
import { SetPasswordScreen } from "./scenes/SetPasswordScreen";
import { resolveSessionRoles, type PracticeRoleId, type WhoAmIResponse } from "./lib/practice-roles";
import { interceptAppNavigation } from "./lib/navigation";
import type { Patient } from "@medplum/fhirtypes";
import { loadAndApplyAppearance } from "./lib/appearance";

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
  const [accountEmail, setAccountEmail] = useState<string>();
  const [roleError, setRoleError] = useState<string>();
  const [path, setPath] = useState(window.location.pathname);
  const view = useViewState((state) => state.view);
  const setView = useViewState((state) => state.setView);
  const previousPath = useRef(path);
  const initialPath = useRef(window.location.pathname);
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
      initialPath.current = window.location.pathname;
      initialSearch.current = window.location.search;
      initialClinicView.current = clinicViewFromSearch(initialSearch.current, { kind: "picker" });
      previousPath.current = initialPath.current;
      setPath(initialPath.current);
      setAuthed(false);
      setRoles(undefined);
      setAccountEmail(undefined);
      setRoleError(undefined);
    });
    return () => {
      stopListening();
      stopIntercepting();
    };
  }, []);

  useEffect(() => {
    if (authed) return;
    initialPath.current = window.location.pathname;
    initialSearch.current = window.location.search;
    initialClinicView.current = clinicViewFromSearch(initialSearch.current, { kind: "picker" });
    previousPath.current = initialPath.current;
    setPath(initialPath.current);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    let active = true;
    resolveRoles()
      .then((whoami) => {
        if (!active) return;
        const destination = defaultHomePath(whoami.roles);
        const requestedPath = initialPath.current;
        const rootRequest = requestedPath === "/";
        const clinicDeepLink = requestedPath === CLINIC_PATH && initialClinicView.current.kind !== "picker";
        const renderedPath = rootRequest ? destination : requestedPath;
        const destinationUrl = rootRequest ? destination : `${requestedPath}${initialSearch.current}`;
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

  useEffect(() => {
    if (!authed || typeof document === "undefined") return;
    let active = true;
    loadAndApplyAppearance().catch((error: unknown) => {
      if (active) console.error("Appearance config could not be loaded; using Midnight and Gold.", error);
    });
    return () => { active = false; };
  }, [authed]);

  if (!authed) {
    const returnTo = initialClinicView.current.kind === "picker" ? "/" : `${CLINIC_PATH}${initialSearch.current}`;
    return <LoginScreen returnTo={returnTo} onAuthenticated={() => setAuthed(true)} login={async (email, password) => {
      await login(email, password);
      setAccountEmail(email.trim());
    }} />;
  }

  const resolvedRoles = roles ?? [];
  const side = appShellSide(path);
  const target = side === "clinic" ? DESK_HOME_PATH : CLINIC_PATH;
  const content = roleError
    ? <main role="alert">Unable to open your practice home: {roleError}</main>
    : roles
      ? <RouteComponent view={view} path={path} roles={roles} />
      : <main>Opening your practice home…</main>;
  const shell = (
    <AppShell
      path={path}
      roles={resolvedRoles}
      homePath={defaultHomePath(resolvedRoles)}
      side={side}
      viewKind={view.kind}
      email={accountEmail}
      switchPill={roles && hasCrossSideAccess(roles) ? <RoleSwitchPill target={target} /> : undefined}
    >
      {content}
    </AppShell>
  );

  return (
    <RoleProvider>
      <OfficeChannelShell key={side} side={side}>{shell}</OfficeChannelShell>
    </RoleProvider>
  );
}

export function appShellSide(path: string): AppShellSide {
  return path === CLINIC_PATH || path.startsWith(`${CLINIC_PATH}/`) || path === "/dispensary/lab-orders" ? "clinic" : "desk";
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
      return <SchedulerDayGrid roles={roles} />;
    case "/frontdesk":
      return <FrontDeskCockpit roles={roles} />;
    case DESK_HOME_PATH:
      return <DeskHome />;
    case "/desk/ledger":
      return <DayLedger date={new URLSearchParams(search).get("date") ?? undefined} />;
    case "/desk/ledger/close":
      return <CloseDay roles={roles} date={new URLSearchParams(search).get("date") ?? undefined} />;
    case "/desk/ledger/archive":
      return <DaySealArchive />;
    case "/financials/practice/margins":
      return <MarginLedger initialPeriod={new URLSearchParams(search).get("period") ?? undefined} />;
    case CLINIC_PATH: {
      const clinicView = clinicRouteView(search, view);
      return clinicView.kind === "picker" ? <ClinicHome roles={roles} /> : <ViewRouter view={clinicView} />;
    }
    case "/clinic/protocols":
      return <ProtocolLibrary />;
    case CLINIC_PATIENTS_PATH:
      return <ViewRouter view={view.kind === "picker" ? view : { kind: "picker" }} />;
    case "/billing/claims/worklist":
      return <ClaimsWorklist />;
    case "/billing/claims/search":
      return <ClaimSearch />;
    case "/billing/claims/remittances":
      return <RemittanceQueue />;
    case "/billing/claims/submit":
      return <SubmitClaims initialEncounterId={new URLSearchParams(search).get("encounterId") ?? undefined} initialSearch={search} />;
    case "/billing/claims/carrier-payments":
      return <CarrierPayments />;
    case "/billing/claims/patient-payments":
      return <PatientPayments />;
    case "/billing/statements":
      return <Statements />;
    case "/patient/insurance":
      return <PatientInsurance initialPatientId={new URLSearchParams(window.location.search).get("patientId") ?? undefined} />;
    case "/patient/pharmacy":
      return <PatientPharmacy initialPatientId={new URLSearchParams(search).get("patientId") ?? undefined} />;
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
      return <FloorConfigSettings canWrite={roles.includes("practice-admin") || roles.includes("front-desk")} />;
    case "/settings/vision-plan-templates":
      return <VisionPlanTemplatesSettings canWrite={roles.includes("practice-admin") || roles.includes("front-desk")} />;
    case "/settings/visit-types":
      return <VisitTypeSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/suggested-diagnoses":
      return <DiagnosisSettings />;
    case "/settings/optical-pricing":
      return <OpticalPricingSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/fee-schedule":
      return <FeeScheduleSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/lens-catalog":
      return <LensCatalogSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/plan-profiles":
      return <PlanProfilesSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/packages":
      return <PackageDefinitionsSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/treatment-protocols":
      return <ProtocolDefinitionsSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/procedure-definitions":
      return <ProcedureDefinitionsSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/statement-messages":
      return <StatementMessagesSettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/billing-identity":
      return <BillingIdentitySettings canWrite={roles.includes("practice-admin")} />;
    case "/settings/appearance":
      return <AppearanceSettings canWrite={roles.includes("practice-admin")} />;
    default:
      return <ViewRouter view={view} />;
  }
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

export function PatientRoute({
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
    return <EncounterCharting key={encounterId} patient={patient} encounterId={encounterId ?? ""} />;
  }

  if (mode === "overview") {
    return <PatientOverview patient={patient} />;
  }

  return <PatientDirector patient={patient} />;
}
