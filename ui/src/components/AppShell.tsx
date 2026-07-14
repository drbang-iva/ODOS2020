import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { Practitioner } from "@medplum/fhirtypes";
import { fhir } from "../lib/fhir";
import { PRACTICE_ROLE_LABELS, type PracticeRoleId } from "../lib/practice-roles";
import type { ViewState } from "../lib/view-state";
import { CLINIC_PATH, DESK_HOME_PATH } from "../scenes/DeskHome";
import { CockpitGuestPanel } from "../scenes/frontdesk/CockpitGuestPanel";
import {
  ClinicPatientSearch,
  OfficeInboxPanel,
  UrgentOfficeBanner,
  useOfficeChannel,
} from "./OfficeChannel";

export type AppShellSide = "desk" | "clinic";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

const BREADCRUMBS: Record<string, BreadcrumbItem[]> = {
  "/": [{ label: "Home" }],
  [DESK_HOME_PATH]: [{ label: "Desk" }],
  [CLINIC_PATH]: [{ label: "Clinic" }],
  "/clinic/patients": [{ label: "Clinic", href: CLINIC_PATH }, { label: "Patients" }],
  "/audit/log": [{ label: "Audit log" }],
  "/admin/optical/catalog/frames": [{ label: "Catalog & pricing" }, { label: "Frames" }],
  "/admin/optical/inventory/frames": [{ label: "Inventory" }, { label: "Frames" }],
  "/admin/practice/settings/frames-data": [{ label: "Integrations" }, { label: "Frames Data" }],
  "/dispensary/lookup": [{ label: "Dispensary" }, { label: "Frame lookup" }],
  "/dispensary/orders": [{ label: "Dispensary" }, { label: "Orders" }],
  "/dispensary/lab-orders": [{ label: "Dispensary" }, { label: "Lab orders" }],
  "/schedule/day": [{ label: "Schedule" }, { label: "Day" }],
  "/scheduler/day": [{ label: "Schedule" }, { label: "Day" }],
  "/frontdesk": [{ label: "Front desk" }],
  "/billing/claims/worklist": [{ label: "Billing" }, { label: "Claims" }, { label: "Worklist" }],
  "/billing/claims/search": [{ label: "Billing" }, { label: "Claims" }, { label: "Search" }],
  "/billing/claims/remittances": [{ label: "Billing" }, { label: "Claims" }, { label: "Remittances" }],
  "/billing/claims/submit": [{ label: "Billing" }, { label: "Claims" }, { label: "Submit" }],
  "/billing/claims/carrier-payments": [{ label: "Billing" }, { label: "Claims" }, { label: "Carrier payments" }],
  "/billing/claims/patient-payments": [{ label: "Billing" }, { label: "Claims" }, { label: "Patient payments" }],
  "/billing/claims/reports/accounts-receivable": [{ label: "Billing" }, { label: "Reports" }, { label: "Accounts receivable" }],
  "/billing/statements": [{ label: "Billing" }, { label: "Statements" }],
  "/patient/insurance": [{ label: "Patients", href: "/clinic/patients" }, { label: "Insurance" }],
  "/patient/new": [{ label: "Patients", href: "/clinic/patients" }, { label: "New patient" }],
  "/patient/vision-benefits": [{ label: "Patients", href: "/clinic/patients" }, { label: "Vision benefits" }],
  "/settings": [{ label: "Settings" }],
  "/settings/staff": [{ label: "Settings", href: "/settings" }, { label: "Staff" }],
  "/settings/floor-config": [{ label: "Settings", href: "/settings" }, { label: "Floor config" }],
  "/settings/vision-plan-templates": [{ label: "Settings", href: "/settings" }, { label: "Vision plan templates" }],
  "/settings/visit-types": [{ label: "Settings", href: "/settings" }, { label: "Visit types" }],
  "/settings/suggested-diagnoses": [{ label: "Settings", href: "/settings" }, { label: "Suggested diagnoses" }],
  "/settings/optical-pricing": [{ label: "Settings", href: "/settings" }, { label: "Optical pricing" }],
  "/settings/chart-fields-sections": [{ label: "Settings", href: "/settings" }, { label: "Chart fields & sections" }],
  "/admin/practice/settings/chart-fields": [{ label: "Settings", href: "/settings" }, { label: "Chart fields & sections" }],
};

export function AppShell({
  children,
  path,
  roles,
  homePath,
  viewKind,
  email,
  switchPill,
}: {
  children: ReactNode;
  path: string;
  roles: readonly PracticeRoleId[];
  homePath: typeof CLINIC_PATH | typeof DESK_HOME_PATH;
  side: AppShellSide;
  viewKind?: ViewState["kind"];
  email?: string;
  switchPill?: ReactNode;
}) {
  const office = useOfficeChannel();
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const authorization = fhir.authHeader();
  const tokenEmail = sessionEmailFromAuthorization(authorization);
  const [profileEmail, setProfileEmail] = useState<string>();
  const accountEmail = email ?? tokenEmail ?? profileEmail ?? "Email unavailable in this session";

  useEffect(() => {
    if (email || tokenEmail) return;
    let active = true;
    void sessionEmailFromProfile(authorization).then((value) => active && setProfileEmail(value));
    return () => { active = false; };
  }, [authorization, email, tokenEmail]);

  useEffect(() => {
    if (!sectionsOpen || typeof document === "undefined") return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSectionsOpen(false);
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [sectionsOpen]);

  function openOffice() {
    office.setOpen(!office.open);
  }

  return (
    <div className="odos-clinic-shell" data-testid="app-shell">
      <header className="odos-desk-topbar flex-wrap">
        <a className="odos-mark flex-none" href={homePath}>ODOS <b>20/20</b></a>
        <Breadcrumb path={path} viewKind={viewKind} />
        <ClinicPatientSearch />
        <a className="odos-pill flex-none" href="/schedule/day"><span aria-hidden>▦</span> Schedule</a>
        <button className="odos-pill flex-none" type="button" aria-expanded={newOpen} onClick={() => setNewOpen(true)}>＋ New…</button>
        <button className="odos-pill flex-none" type="button" aria-expanded={sectionsOpen} onClick={() => setSectionsOpen(true)}>Sections</button>
        <button className="odos-pill odos-office-pill flex-none" type="button" aria-label="Office" aria-expanded={office.open} onClick={openOffice}>
          <span aria-hidden>🔔</span>
          {office.unread.length > 0 && <span className="odos-office-badge">{office.unread.length}</span>}
        </button>
        {switchPill}
        <AccountChip email={accountEmail} roles={roles} />
      </header>
      <UrgentOfficeBanner messages={office.unread.filter((message) => message.tier === "urgent")} canAcknowledge={office.canAcknowledge} onAcknowledge={office.acknowledge} acknowledging={office.acknowledging} />
      {office.open && <OfficeInboxPanel messages={office.messages} error={office.error} acknowledging={office.acknowledging} canAcknowledge={office.canAcknowledge} onAcknowledge={office.acknowledge} onClose={() => office.setOpen(false)} />}
      {children}
      <SectionsDrawer open={sectionsOpen} roles={roles} onClose={() => setSectionsOpen(false)} />
      {newOpen && <CockpitGuestPanel panel="launcher" onClose={() => setNewOpen(false)} />}
    </div>
  );
}

function Breadcrumb({ path, viewKind }: { path: string; viewKind?: ViewState["kind"] }) {
  const items = breadcrumbItems(path, viewKind);
  return (
    <nav className="flex min-w-0 flex-none items-center gap-1 whitespace-nowrap text-[11px] text-[#5e6880]" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span className="flex min-w-0 items-center gap-1" key={`${item.label}-${index}`}>
          {index > 0 && <span aria-hidden>›</span>}
          {item.href ? <a className="text-[#97a1b8] no-underline hover:text-[#e9edf6]" href={item.href}>{item.label}</a> : <span>{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function breadcrumbItems(path: string, viewKind?: ViewState["kind"]): BreadcrumbItem[] {
  const configured = BREADCRUMBS[path];
  const items: BreadcrumbItem[] = configured ? [...configured] : path.split("/").filter(Boolean).map((segment) => ({
    label: segment.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase()),
  }));
  if (path === CLINIC_PATH && viewKind && viewKind !== "picker") {
    items[0] = { label: "Clinic", href: CLINIC_PATH };
    items.push({ label: viewKind === "overview" ? "Patient overview" : viewKind === "director" ? "Patient director" : "Encounter" });
  }
  return items.length ? items : [{ label: "Home" }];
}

function SectionsDrawer({ open, roles, onClose }: { open: boolean; roles: readonly PracticeRoleId[]; onClose(): void }) {
  const route = (_event: MouseEvent<HTMLAnchorElement>) => onClose();
  return (
    <>
      <button className={`odos-clinic-scrim${open ? " is-open" : ""}`} type="button" aria-label="Close sections" tabIndex={open ? 0 : -1} onClick={onClose} />
      <aside ref={(node) => { node?.toggleAttribute("inert", !open); }} className={`odos-clinic-sections${open ? " is-open" : ""}`} role="dialog" aria-modal="true" aria-label="Sections" aria-hidden={!open}>
        <button className="odos-clinic-sections-close" type="button" aria-label="Close sections" onClick={onClose}>×</button>
        <h2>Sections</h2>
        <p>Every working surface, one slide away.</p>
        <DrawerGroup label="Every day">
          <DrawerLink icon="▦" title="Schedule" detail="day grid, all providers" href="/schedule/day" onClick={route} />
          <DrawerLink icon="⌂" title="Front desk" detail="schedule and floor" href="/frontdesk" onClick={route} />
          <DrawerLink icon="⇄" title="Claims worklist" detail="transmission and denial work" href="/billing/claims/worklist" onClick={route} />
          <DrawerLink icon="◫" title="Reports / A-R" detail="production and aging" href="/billing/claims/reports/accounts-receivable" onClick={route} />
          <DrawerLink icon="▤" title="Statements" detail="patient statement runs" href="/billing/statements" onClick={route} />
          <DrawerLink icon="◇" title="Lab orders" detail="optical orders in flight" href="/dispensary/lab-orders" onClick={route} />
        </DrawerGroup>
        <DrawerGroup label="Catalog & operations">
          <DrawerLink icon="⌗" title="Catalog & pricing" detail="frames catalog and pricing" href="/admin/optical/catalog/frames" onClick={route} />
          <DrawerLink icon="▥" title="Inventory" detail="frames inventory" href="/admin/optical/inventory/frames" onClick={route} />
          <DrawerLink icon="⚭" title="Integrations" detail="Frames Data" href="/admin/practice/settings/frames-data" onClick={route} />
        </DrawerGroup>
        <DrawerGroup label="Practice">
          <DrawerLink icon="≡" title="Audit log" detail="every access and change" href="/audit/log" onClick={route} />
          {roles.includes("practice-admin") && <DrawerLink icon="⚙" title="Administration / Settings" detail="practice configuration" href="/settings" onClick={route} />}
          <DrawerLink icon="◉" title="Clinic" detail="Clinic home and patients" href={CLINIC_PATH} onClick={route} />
        </DrawerGroup>
      </aside>
    </>
  );
}

function DrawerGroup({ label, children }: { label: string; children: ReactNode }) {
  return <section className="odos-clinic-section-group"><h3>{label}</h3>{children}</section>;
}

function DrawerLink({ icon, title, detail, href, onClick }: { icon: string; title: string; detail: string; href: string; onClick(event: MouseEvent<HTMLAnchorElement>): void }) {
  return <a className="odos-clinic-section-item" href={href} onClick={onClick}><span className="odos-clinic-section-icon">{icon}</span><span>{title}<small>{detail}</small></span></a>;
}

function AccountChip({ email, roles }: { email: string; roles: readonly PracticeRoleId[] }) {
  return (
    <details className="relative flex-none">
      <summary className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-full border border-[#e0bc7e]/40 bg-[#e0bc7e]/10 text-xs font-bold tracking-wider text-[#e0bc7e]" aria-label="Account menu">{initialsForEmail(email)}</summary>
      <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 rounded-xl border border-white/15 bg-[#11192c] p-4 shadow-2xl">
        <strong className="block break-all text-sm text-white">{email}</strong>
        <span className="mt-2 block text-[10px] uppercase tracking-[.16em] text-white/35">Roles</span>
        <span className="mt-1 block text-xs leading-relaxed text-white/60">{roles.length ? roles.map((role) => PRACTICE_ROLE_LABELS[role]).join(" · ") : "Roles loading…"}</span>
        <button className="mt-4 w-full rounded-lg border border-white/15 px-3 py-2 text-left text-xs font-semibold text-white/70 hover:bg-white/10 hover:text-white" type="button" onClick={() => fhir.logout()}>Logout</button>
      </div>
    </details>
  );
}

export function initialsForEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._\-\s]+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]).join("");
  return (initials || local.slice(0, 2) || "OS").toUpperCase();
}

export function sessionEmailFromAuthorization(authorization: string | undefined): string | undefined {
  const claims = sessionClaimsFromAuthorization(authorization);
  for (const key of ["email", "preferred_username", "username", "upn", "sub"]) {
    const value = claims?.[key];
    if (typeof value === "string" && value.includes("@")) return value;
  }
  return undefined;
}

export async function sessionEmailFromProfile(
  authorization: string | undefined,
  api: Pick<typeof fhir, "read"> = fhir,
): Promise<string | undefined> {
  const profile = sessionClaimsFromAuthorization(authorization)?.profile;
  if (typeof profile !== "string" || !profile.startsWith("Practitioner/")) return undefined;
  const id = profile.slice("Practitioner/".length);
  if (!id) return undefined;
  try {
    const practitioner = await api.read<Practitioner>("Practitioner", id);
    return practitioner.telecom?.find((contact) => contact.system === "email" && contact.value)?.value;
  } catch {
    return undefined;
  }
}

function sessionClaimsFromAuthorization(authorization: string | undefined): Record<string, unknown> | undefined {
  const payload = authorization?.replace(/^Bearer\s+/, "").split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
