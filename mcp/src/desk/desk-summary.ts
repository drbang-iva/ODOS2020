import type {
  Appointment,
  Claim,
  ClaimResponse,
  Invoice,
  Patient,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { confirmationStatusOf } from "../fhir/appointmentConfirmation.js";
import { OSOD_OPTICAL_ORDER_STATUS_SYSTEM } from "../fhir/opticalOrderStatus.js";
import { OSOD_OPTICAL_ORDER_TYPE_SYSTEM } from "../fhir/opticalOrderType.js";
import { projectClaimSearchResults } from "../claims/claim-search.js";
import {
  CLAIM_REJECTED_CODE_SYSTEM,
  ERA_WORKLIST_CODE_SYSTEM,
  ERA_WORKLIST_INPUT_SYSTEM,
  ERA_WORKLIST_STATUS_SYSTEM,
} from "../claims/era-worklist.js";
import {
  filterUnappliedCredits,
  paymentSubjectReference,
  unappliedPaymentCents,
} from "../payments/payment-credit-service.js";
import {
  latestStatementRun,
  StatementValidationError,
  STATEMENT_RUN_CODE,
  STATEMENT_TASK_CODE_SYSTEM,
} from "../statements/statements.js";

const OPTICAL_TASKS_UNAVAILABLE = "Open optical Tasks exceed the Desk card read limit.";
const CLAIM_TASKS_UNAVAILABLE = "Claim worklist Tasks exceed the Desk card read limit.";
const ERA_TASKS_UNAVAILABLE = "Open ERA Tasks exceed the Desk card read limit.";
const CLAIM_RESOURCES_UNAVAILABLE = "Claim records exceed the Desk card read limit.";
const PAYMENT_RESOURCES_UNAVAILABLE = "Payment records exceed the Desk card read limit.";
const INVOICE_RESOURCES_UNAVAILABLE = "Invoice records exceed the Desk card read limit.";

export type DeskTone = "ok" | "warn" | "alert" | "info" | "off";

export interface DeskStat<T = number | string | null> {
  value: T;
  tone: DeskTone;
  unavailableReason?: string;
}

export interface DeskAgendaRow {
  time: string;
  patient: string;
  visitType: string;
}

export interface DeskAttentionRow {
  tone: Exclude<DeskTone, "ok" | "off">;
  label: string;
  detail: string;
  href?: string;
}

export interface DeskSummary {
  cards: {
    schedule: {
      today: DeskStat<number>;
      confirmed: DeskStat<number>;
      checkedIn: DeskStat<number>;
      webRequests: DeskStat<number>;
      agenda: DeskAgendaRow[];
    };
    attention: { items: DeskAttentionRow[] };
    frontLine: {
      available: false;
      message: string;
      needsReply: DeskStat<null>;
      missedCalls: DeskStat<null>;
      voicemails: DeskStat<null>;
      urgent: DeskStat<null>;
      messages: [];
    };
    pendingRx: {
      spectacle: DeskStat<number | null>;
      contactLens: DeskStat<null>;
      labOrdersUnsent: DeskStat<null>;
      oldestWaiting: DeskStat<number | null>;
    };
    productPickup: {
      openOrders: DeskStat<number | null>;
      atLab: DeskStat<number | null>;
      readyNotNotified: DeskStat<null>;
      awaitingPickup: DeskStat<number | null>;
    };
    claims: {
      failed: DeskStat<number | null>;
      inProcess: DeskStat<number | null>;
      paperQueue: DeskStat<null>;
      heldCents: DeskStat<number | null>;
      lastTransmission: DeskStat<string | null>;
    };
    payments: {
      unappliedCount: DeskStat<number | null>;
      unappliedCents: DeskStat<number | null>;
      patientCreditsOpen: DeskStat<number | null>;
      patientOpenBalanceCents: DeskStat<number | null>;
      terminalMode: DeskStat<string>;
    };
    remits: {
      waitingToPost: DeskStat<number | null>;
      unpostedCents: DeskStat<number | null>;
    };
    statements: {
      available: true;
      cadence: DeskStat<string>;
      invalidRejects: DeskStat<number>;
      lastStatement: DeskStat<string | null>;
    };
  };
  pulse: {
    itemsNeedingYou: number;
    everythingElseAtTarget: boolean;
    lastClaimTransmission: string | null;
    lastClaimTransmissionTone: DeskTone;
  };
}

export interface DeskSummaryInput {
  appointments: Appointment[];
  patients: Patient[];
  tasks: Task[];
  claims: Claim[];
  claimResponses: ClaimResponse[];
  paymentReconciliations: PaymentReconciliation[];
  invoices: Invoice[];
  now: string;
  timeZone?: string;
  terminalMode: string;
  taskAvailability?: {
    optical?: boolean;
    claimRejected?: boolean;
    era?: boolean;
  };
  resourceAvailability?: {
    claims?: boolean;
    claimResponses?: boolean;
    paymentReconciliations?: boolean;
    invoices?: boolean;
  };
}

export function projectDeskSummary(input: DeskSummaryInput): DeskSummary {
  const nowMs = Date.parse(input.now);
  const patients = new Map(input.patients.flatMap((patient) => patient.id ? [[`Patient/${patient.id}`, patient] as const] : []));
  const currentAppointments = input.appointments.filter((appointment) =>
    appointment.status !== "cancelled" && appointment.status !== "noshow" && appointment.status !== "entered-in-error",
  );
  const webAppointments = currentAppointments.filter((appointment) => appointment.status === "proposed" || appointment.status === "pending");
  const confirmed = currentAppointments.filter((appointment) => confirmationStatusOf(appointment) === "confirmed").length;
  const schedule = {
    today: stat(currentAppointments.length, "ok"),
    confirmed: stat(confirmed, confirmed >= currentAppointments.length ? "ok" : "warn"),
    checkedIn: stat(currentAppointments.filter((appointment) => appointment.status === "arrived").length, "info"),
    webRequests: stat(webAppointments.length, webAppointments.length > 0 ? "warn" : "ok"),
    agenda: currentAppointments
      .filter((appointment) => Date.parse(appointment.start ?? "") >= nowMs)
      .sort((a, b) => Date.parse(a.start ?? "") - Date.parse(b.start ?? ""))
      .slice(0, 4)
      .map((appointment) => ({
        time: timeLabel(appointment.start, input.timeZone),
        patient: appointmentPatientName(appointment, patients),
        visitType: appointment.serviceType?.[0]?.text
          ?? appointment.serviceType?.[0]?.coding?.[0]?.display
          ?? appointment.serviceType?.[0]?.coding?.[0]?.code
          ?? "Visit",
      })),
  };

  const opticalTasks = input.tasks.filter((task) =>
    task.status === "in-progress" && coding(task.code, OSOD_OPTICAL_ORDER_TYPE_SYSTEM) !== undefined,
  );
  const atLab = opticalTasks.filter((task) => opticalStatus(task) === "at-lab").length;
  const awaitingPickup = opticalTasks.filter((task) =>
    ["notified", "notified-left-message", "complete-unable-to-notify"].includes(opticalStatus(task) ?? ""),
  ).length;
  const oldestOpticalDays = oldestAgeDays(opticalTasks, nowMs);
  const opticalTasksAvailable = input.taskAvailability?.optical !== false;
  const pendingRx = {
    spectacle: opticalTasksAvailable ? stat(opticalTasks.length, "info") : unavailable(OPTICAL_TASKS_UNAVAILABLE),
    contactLens: unavailable("Contact-lens orders do not have a shipped order contract yet."),
    labOrdersUnsent: unavailable("Optical orders do not persist a lab-transmission state yet."),
    oldestWaiting: opticalTasksAvailable
      ? stat(oldestOpticalDays, oldestOpticalDays !== null && oldestOpticalDays > 1 ? "warn" : oldestOpticalDays === null ? "off" : "ok",
        oldestOpticalDays === null && opticalTasks.length > 0 ? "Open optical orders do not carry a created timestamp." : undefined)
      : unavailable(OPTICAL_TASKS_UNAVAILABLE),
  };
  const productPickup = {
    openOrders: opticalTasksAvailable ? stat(opticalTasks.length, "info") : unavailable(OPTICAL_TASKS_UNAVAILABLE),
    atLab: opticalTasksAvailable ? stat(atLab, "info") : unavailable(OPTICAL_TASKS_UNAVAILABLE),
    readyNotNotified: unavailable("The optical status vocabulary has no received-but-not-notified state."),
    awaitingPickup: opticalTasksAvailable ? stat(awaitingPickup, "info") : unavailable(OPTICAL_TASKS_UNAVAILABLE),
  };

  const claimRows = projectClaimSearchResults({
    claims: input.claims,
    responses: input.claimResponses,
    tasks: input.tasks,
    relatedResources: [] as Resource[],
    at: input.now,
  });
  const failedRows = claimRows.filter((row) => row.status === "rejected" || row.status === "denied");
  const inProcessRows = claimRows.filter((row) => ["submitted", "accepted", "queued"].includes(row.status));
  const heldCents = failedRows.reduce((total, row) => total + row.totalChargedCents, 0);
  const successfulClaims = input.claims.filter((claim) => !failedRows.some((row) => row.claimReference === `Claim/${claim.id}`));
  const lastTransmission = successfulClaims
    .map((claim) => claim.created)
    .filter((created): created is string => Boolean(created))
    .sort()
    .at(-1) ?? null;
  const claimResourcesAvailable = input.resourceAvailability?.claims !== false && input.resourceAvailability?.claimResponses !== false;
  const claimTasksAvailable = input.taskAvailability?.claimRejected !== false && input.taskAvailability?.era !== false;
  const claimsAvailable = claimResourcesAvailable && claimTasksAvailable;
  const lastTransmissionTone = claimsAvailable && lastTransmission ? previousBusinessDayTone(lastTransmission, input.now) : "off";
  const claims = {
    failed: claimsAvailable ? stat(failedRows.length, failedRows.length > 0 ? "alert" : "ok") : unavailable(claimResourcesAvailable ? CLAIM_TASKS_UNAVAILABLE : CLAIM_RESOURCES_UNAVAILABLE),
    inProcess: claimsAvailable ? stat(inProcessRows.length, "info") : unavailable(claimResourcesAvailable ? CLAIM_TASKS_UNAVAILABLE : CLAIM_RESOURCES_UNAVAILABLE),
    paperQueue: unavailable("Claims do not persist an electronic-versus-paper queue marker yet."),
    heldCents: claimsAvailable ? stat(heldCents, failedRows.length > 0 ? "alert" : "ok") : unavailable(claimResourcesAvailable ? CLAIM_TASKS_UNAVAILABLE : CLAIM_RESOURCES_UNAVAILABLE),
    lastTransmission: claimsAvailable
      ? stat(lastTransmission, lastTransmissionTone, lastTransmission ? undefined : "No successful claim transmission is persisted yet.")
      : unavailable(claimResourcesAvailable ? CLAIM_TASKS_UNAVAILABLE : CLAIM_RESOURCES_UNAVAILABLE),
  };

  const paymentReconciliationsAvailable = input.resourceAvailability?.paymentReconciliations !== false;
  const invoicesAvailable = input.resourceAvailability?.invoices !== false;
  const activePayments = input.paymentReconciliations.filter((payment) => payment.status === "active");
  const credits = filterUnappliedCredits(activePayments);
  const unappliedCents = credits.reduce((total, credit) => total + unappliedPaymentCents(credit.paymentReconciliation), 0);
  const creditPatients = new Set(credits.map((credit) => paymentSubjectReference(credit.paymentReconciliation)).filter(Boolean)).size;
  const openInvoices = input.invoices.filter((invoice) => invoice.status === "issued");
  const openBalanceCents = openInvoices.reduce((total, invoice) => total + moneyCents(invoice.totalNet?.value), 0);
  const terminalTone: DeskTone = input.terminalMode === "TEST MODE" ? "warn" : input.terminalMode === "NOT CONFIGURED" ? "off" : "ok";
  const payments = {
    unappliedCount: paymentReconciliationsAvailable ? stat(credits.length, credits.length > 0 ? "warn" : "ok") : unavailable(PAYMENT_RESOURCES_UNAVAILABLE),
    unappliedCents: paymentReconciliationsAvailable ? stat(unappliedCents, credits.length > 0 ? "warn" : "ok") : unavailable(PAYMENT_RESOURCES_UNAVAILABLE),
    patientCreditsOpen: paymentReconciliationsAvailable ? stat(creditPatients, creditPatients > 0 ? "warn" : "ok") : unavailable(PAYMENT_RESOURCES_UNAVAILABLE),
    patientOpenBalanceCents: invoicesAvailable ? stat(openBalanceCents, "info") : unavailable(INVOICE_RESOURCES_UNAVAILABLE),
    terminalMode: stat(input.terminalMode, terminalTone),
  };

  const openEraTasks = input.tasks.filter((task) => isOpenWorklistTask(task) && ["era-denial", "era-underpayment", "era-unmatched"].includes(worklistCode(task) ?? ""));
  const unpostedCents = openEraTasks.reduce((total, task) => total + taskInputInteger(task, "shortfall-cents"), 0);
  const eraTasksAvailable = input.taskAvailability?.era !== false;
  const remits = {
    waitingToPost: eraTasksAvailable ? stat(openEraTasks.length, openEraTasks.length > 0 ? "warn" : "ok") : unavailable(ERA_TASKS_UNAVAILABLE),
    unpostedCents: eraTasksAvailable ? stat(unpostedCents, openEraTasks.length > 0 ? "warn" : "ok") : unavailable(ERA_TASKS_UNAVAILABLE),
  };
  const statementRun = safeLatestStatementRun(input.tasks);

  const attention: DeskAttentionRow[] = [
    ...(claimsAvailable && failedRows.length > 0 ? [{ tone: "alert" as const, label: `${failedRows.length} failed claim${failedRows.length === 1 ? "" : "s"}`, detail: `${money(heldCents)} held`, href: "/billing/claims/worklist" }] : []),
    ...(webAppointments.length > 0 ? [{ tone: "warn" as const, label: `${webAppointments.length} web appointment${webAppointments.length === 1 ? "" : "s"} waiting`, detail: sinceLabel(oldestAppointmentTime(webAppointments), nowMs), href: "/frontdesk" }] : []),
    ...(eraTasksAvailable && openEraTasks.length > 0 ? [{ tone: "warn" as const, label: `${openEraTasks.length} remit item${openEraTasks.length === 1 ? "" : "s"} waiting`, detail: `${money(unpostedCents)} unposted`, href: "/billing/claims/remittances" }] : []),
  ];

  const cards: DeskSummary["cards"] = {
    schedule,
    attention: { items: attention },
    frontLine: {
      available: false,
      message: "Comms counts arrive with the GHL adapter — Phase 3b",
      needsReply: unavailable("Phase 3b CommsProvider is not installed."),
      missedCalls: unavailable("Phase 3b CommsProvider is not installed."),
      voicemails: unavailable("Phase 3b CommsProvider is not installed."),
      urgent: unavailable("Phase 3b CommsProvider is not installed."),
      messages: [],
    },
    pendingRx,
    productPickup,
    claims,
    payments,
    remits,
    statements: {
      available: true,
      cadence: stat("Weekly · Wednesdays recommended", "info"),
      invalidRejects: stat(statementRun.invalidRejects, statementRun.invalidRejects > 0 ? "alert" : "ok"),
      lastStatement: stat(
        statementRun.generatedAt,
        statementRun.generatedAt ? "info" : "off",
        statementRun.generatedAt ? undefined : "No statement run is persisted yet.",
      ),
    },
  };
  return {
    cards,
    pulse: {
      itemsNeedingYou: attention.length,
      everythingElseAtTarget: attention.length === 0,
      lastClaimTransmission: claimsAvailable ? lastTransmission : null,
      lastClaimTransmissionTone: lastTransmissionTone,
    },
  };
}

export async function loadDeskSummary(
  fhir: Pick<MedplumClient, "search">,
  options: { now?: string; date?: string; timeZone?: string; terminalMode: string },
): Promise<DeskSummary> {
  const now = options.now ?? new Date().toISOString();
  const date = options.date ?? practiceDate(now, options.timeZone);
  const [
    appointments,
    opticalTaskRead,
    claimRejectedTaskRead,
    eraTaskRead,
    statementTasks,
    claimRead,
    claimResponseRead,
    paymentReconciliationRead,
    invoiceRead,
  ] = await Promise.all([
    searchOnePage<Appointment>(fhir, "Appointment", { date, _count: "1000", _sort: "date" }),
    searchScopedTasks(fhir, {
      status: "in-progress",
      code: `${OSOD_OPTICAL_ORDER_TYPE_SYSTEM}|`,
      _count: "1000",
      _sort: "-authored-on",
    }),
    searchScopedTasks(fhir, {
      code: `${CLAIM_REJECTED_CODE_SYSTEM}|claim-rejected`,
      _count: "1000",
      _sort: "-authored-on",
    }),
    searchScopedTasks(fhir, {
      code: `${ERA_WORKLIST_CODE_SYSTEM}|`,
      "business-status": `${ERA_WORKLIST_STATUS_SYSTEM}|new,${ERA_WORKLIST_STATUS_SYSTEM}|in-review`,
      _count: "1000",
      _sort: "-authored-on",
    }),
    searchFirstPage<Task>(fhir, "Task", {
      status: "completed",
      code: `${STATEMENT_TASK_CODE_SYSTEM}|${STATEMENT_RUN_CODE}`,
      _count: "1",
      _sort: "-authored-on",
    }).then((page) => page.resources),
    searchAvailablePage<Claim>(fhir, "Claim", { _count: "1000", _sort: "-created" }),
    searchAvailablePage<ClaimResponse>(fhir, "ClaimResponse", { _count: "1000", _sort: "-created" }),
    searchAvailablePage<PaymentReconciliation>(fhir, "PaymentReconciliation", { _count: "1000", _sort: "-_lastUpdated" }),
    searchAvailablePage<Invoice>(fhir, "Invoice", { _count: "1000", _sort: "-_lastUpdated" }),
  ]);
  const patientIds = unique(appointments.flatMap((appointment) => appointment.participant ?? [])
    .flatMap((participant) => participant.actor?.reference?.match(/^Patient\/([^/]+)$/)?.[1] ?? []));
  const patients = patientIds.length === 0
    ? []
    : await searchOnePage<Patient>(fhir, "Patient", { _id: patientIds.join(","), _count: String(patientIds.length) });
  return projectDeskSummary({
    appointments,
    patients,
    tasks: [...opticalTaskRead.tasks, ...claimRejectedTaskRead.tasks, ...eraTaskRead.tasks, ...statementTasks],
    claims: claimRead.resources,
    claimResponses: claimResponseRead.resources,
    paymentReconciliations: paymentReconciliationRead.resources,
    invoices: invoiceRead.resources,
    now,
    timeZone: options.timeZone,
    terminalMode: options.terminalMode,
    taskAvailability: {
      optical: opticalTaskRead.complete,
      claimRejected: claimRejectedTaskRead.complete,
      era: eraTaskRead.complete,
    },
    resourceAvailability: {
      claims: claimRead.complete,
      claimResponses: claimResponseRead.complete,
      paymentReconciliations: paymentReconciliationRead.complete,
      invoices: invoiceRead.complete,
    },
  });
}

async function searchScopedTasks(
  fhir: Pick<MedplumClient, "search">,
  params: Record<string, string>,
): Promise<{ tasks: Task[]; complete: boolean }> {
  const result = await searchAvailablePage<Task>(fhir, "Task", params);
  return { tasks: result.resources, complete: result.complete };
}

async function searchAvailablePage<T extends Resource>(
  fhir: Pick<MedplumClient, "search">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<{ resources: T[]; complete: boolean }> {
  try {
    return { resources: await searchOnePage<T>(fhir, resourceType, params), complete: true };
  } catch (error) {
    if (error instanceof DeskSummaryPageError) return { resources: [], complete: false };
    throw error;
  }
}

async function searchOnePage<T extends Resource>(
  fhir: Pick<MedplumClient, "search">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  const page = await searchFirstPage<T>(fhir, resourceType, params);
  if (page.hasNext) {
    throw new DeskSummaryPageError(`${resourceType} desk-summary query exceeded one FHIR page; refusing partial counts.`);
  }
  return page.resources;
}

class DeskSummaryPageError extends Error {}

async function searchFirstPage<T extends Resource>(
  fhir: Pick<MedplumClient, "search">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<{ resources: T[]; hasNext: boolean }> {
  const bundle = await fhir.search<T>(resourceType, params);
  return {
    resources: (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []),
    hasNext: bundle.link?.some((link) => link.relation === "next") ?? false,
  };
}

export function safeLatestStatementRun(
  tasks: readonly Task[],
  readLatest: typeof latestStatementRun = latestStatementRun,
): { generatedAt: string | null; invalidRejects: number } {
  try {
    return readLatest(tasks);
  } catch (error) {
    if (!(error instanceof StatementValidationError)) throw error;
    return { generatedAt: null, invalidRejects: 0 };
  }
}

function stat<T>(value: T, tone: DeskTone, unavailableReason?: string): DeskStat<T> {
  return { value, tone, ...(unavailableReason ? { unavailableReason } : {}) };
}

function unavailable(reason: string): DeskStat<null> {
  return stat(null, "off", reason);
}

function coding(concept: Task["code"], system: string): string | undefined {
  return concept?.coding?.find((item) => item.system === system)?.code;
}

function opticalStatus(task: Task): string | undefined {
  return coding(task.businessStatus, OSOD_OPTICAL_ORDER_STATUS_SYSTEM);
}

function worklistCode(task: Task): string | undefined {
  return task.code?.coding?.find((item) => item.system === ERA_WORKLIST_CODE_SYSTEM || item.system === CLAIM_REJECTED_CODE_SYSTEM)?.code;
}

function isOpenWorklistTask(task: Task): boolean {
  const status = coding(task.businessStatus, ERA_WORKLIST_STATUS_SYSTEM);
  return status === "new" || status === "in-review";
}

function taskInputInteger(task: Task, code: string): number {
  return task.input?.find((input) => input.type?.coding?.some((item) => item.system === ERA_WORKLIST_INPUT_SYSTEM && item.code === code))?.valueInteger ?? 0;
}

function appointmentPatientName(appointment: Appointment, patients: ReadonlyMap<string, Patient>): string {
  const participant = appointment.participant?.find((item) => item.actor?.reference?.startsWith("Patient/"));
  const patient = participant?.actor?.reference ? patients.get(participant.actor.reference) : undefined;
  const name = patient?.name?.find((item) => item.use === "usual") ?? patient?.name?.[0];
  const resolvedName = [name?.given?.join(" "), name?.family].filter(Boolean).join(" ");
  return participant?.actor?.display ?? (resolvedName || "Patient");
}

function timeLabel(value: string | undefined, timeZone: string | undefined): string {
  if (!value) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function oldestAgeDays(tasks: Task[], nowMs: number): number | null {
  const timestamps = tasks.map((task) => Date.parse(task.authoredOn ?? task.meta?.lastUpdated ?? "")).filter(Number.isFinite);
  return timestamps.length === 0 ? null : Math.floor((nowMs - Math.min(...timestamps)) / 86_400_000);
}

function oldestAppointmentTime(appointments: Appointment[]): number | null {
  const values = appointments.map((appointment) => Date.parse(appointment.created ?? appointment.meta?.lastUpdated ?? appointment.start ?? "")).filter(Number.isFinite);
  return values.length === 0 ? null : Math.min(...values);
}

function sinceLabel(since: number | null, nowMs: number): string {
  if (since === null) return "waiting time unavailable";
  const minutes = Math.max(0, Math.floor((nowMs - since) / 60_000));
  if (minutes < 60) return `since ${minutes}m ago`;
  return `since ${Math.floor(minutes / 60)}h ago`;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function moneyCents(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function previousBusinessDayTone(last: string, now: string): DeskTone {
  const nowDate = new Date(now);
  const previous = new Date(nowDate);
  do previous.setUTCDate(previous.getUTCDate() - 1); while (previous.getUTCDay() === 0 || previous.getUTCDay() === 6);
  return last.slice(0, 10) >= previous.toISOString().slice(0, 10) ? "ok" : "warn";
}

function practiceDate(now: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
