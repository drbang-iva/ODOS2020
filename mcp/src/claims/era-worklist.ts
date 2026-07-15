import type { Basic, Bundle, CodeableConcept, Extension, Task, TaskInput } from "@medplum/fhirtypes";
import { CLAIMMD_ERA_PAYMENT_SYSTEM, STEDI_ERA_PAYMENT_SYSTEM } from "../payments/payment-reconciliation.js";
import type { ClaimMdEraClaim, ClaimMdEraData } from "./claimmd-fhir.js";

export const ERA_WORKLIST_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/osod-era-worklist";
export const CLAIM_REJECTED_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/osod-claim-rejected-worklist";
export const ERA_WORKLIST_STATUS_SYSTEM = "https://osod.dev/fhir/CodeSystem/era-worklist-status";
export const ERA_WORKLIST_INPUT_SYSTEM = "https://osod.dev/fhir/CodeSystem/era-worklist-input";
export const ERA_WORKLIST_OUTPUT_SYSTEM = "https://osod.dev/fhir/CodeSystem/era-worklist-output";
export const ERA_IMPORT_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/osod-era-import";
export const ERA_IMPORT_CODE = "osod-era-import";
export const ERA_IMPORT_SUMMARY_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-era-import-summary";

export const ERA_WORKLIST_CODES = ["era-denial", "era-line-linkage", "era-unmatched", "era-underpayment"] as const;
export const CLAIM_REJECTED_CODES = ["claim-rejected"] as const;
export const WORKLIST_CODE_REGISTRY = [
  { system: ERA_WORKLIST_CODE_SYSTEM, codes: ERA_WORKLIST_CODES },
  { system: CLAIM_REJECTED_CODE_SYSTEM, codes: CLAIM_REJECTED_CODES },
] as const;
export const WORKLIST_CODES = [...ERA_WORKLIST_CODES, ...CLAIM_REJECTED_CODES] as const;
export const ERA_WORKLIST_STATUSES = ["new", "in-review", "resolved"] as const;
export const ERA_WORKLIST_DISPOSITIONS = ["rebilled", "appealed", "written-off", "matched", "posted-ok"] as const;

export type EraWorklistCode = (typeof ERA_WORKLIST_CODES)[number];
export type WorklistCode = (typeof WORKLIST_CODES)[number];
export type EraWorklistStatus = (typeof ERA_WORKLIST_STATUSES)[number];
export type EraWorklistDisposition = (typeof ERA_WORKLIST_DISPOSITIONS)[number];
export type EraBatchLane = "new" | "imported" | "fully-worked";

export interface EraImportSummary {
  importedAt: string;
  posted: number;
  denied: number;
  underpaid: number;
  flagged: number;
  payerName?: string;
  paidDate?: string;
  paidTotalCents: number;
}

export interface EraBatchItem {
  eraId: string;
  lane: EraBatchLane;
  importedAt?: string;
  posted: number;
  denied: number;
  underpaid: number;
  flagged: number;
  payerName?: string;
  paidDate?: string;
  paidTotalCents: number;
  claimCount?: number;
  openTaskCount: number;
}

export interface EraWorklistEvidence {
  pcn: string;
  payerIcn?: string;
  eraId: string;
  chargedCents: number;
  allowedCents: number;
  paidCents: number;
  patientResponsibilityCents: number;
  shortfallCents: number;
  adjustments: Array<{ group?: string; code?: string }>;
}

export interface EraWorklistAttentionItem {
  id: string;
  taskReference: string;
  title: string;
  code: WorklistCode;
  patientReference?: string;
  focusReference?: string;
  severity: "high" | "medium";
  ageTimer: { startedAt: string; elapsedMinutes: number };
  action: "claim" | "resolve" | "none";
  owner?: string;
  status: EraWorklistStatus;
  evidence: EraWorklistProjectedEvidence | ClaimRejectedProjectedEvidence;
}

export interface EraWorklistProjectedEvidence extends EraWorklistEvidence {
  kind: "era";
}

export interface ClaimRejectedProjectedEvidence {
  kind: "claim-rejected";
  claimMdMessage: string;
}

export function buildEraImportRecord(
  eraId: string,
  summary: EraImportSummary,
  existing?: Basic,
  identifierSystem = CLAIMMD_ERA_PAYMENT_SYSTEM,
): Basic {
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: identifierSystem, value: eraId }],
    code: codedConcept(ERA_IMPORT_CODE_SYSTEM, ERA_IMPORT_CODE, "OSOD ERA import"),
    extension: [{
      url: ERA_IMPORT_SUMMARY_EXTENSION_URL,
      extension: [
        { url: "importedAt", valueDateTime: summary.importedAt },
        { url: "posted", valueInteger: summary.posted },
        { url: "denied", valueInteger: summary.denied },
        { url: "underpaid", valueInteger: summary.underpaid },
        { url: "flagged", valueInteger: summary.flagged },
        ...(summary.payerName ? [{ url: "payerName", valueString: summary.payerName }] : []),
        ...(summary.paidDate ? [{ url: "paidDate", valueDate: summary.paidDate }] : []),
        { url: "paidTotalCents", valueInteger: summary.paidTotalCents },
      ],
    }],
  };
}

export function parseEraImportRecord(basic: Basic): { eraId: string; summary: EraImportSummary } {
  const code = basic.code?.coding?.find((coding) =>
    coding.system === ERA_IMPORT_CODE_SYSTEM && coding.code === ERA_IMPORT_CODE,
  );
  if (!code) throw new Error("Basic resource is not an OSOD ERA import record.");
  const eraId = basic.identifier?.find((identifier) =>
    identifier.system === CLAIMMD_ERA_PAYMENT_SYSTEM || identifier.system === STEDI_ERA_PAYMENT_SYSTEM,
  )?.value;
  if (!eraId) throw new Error("ERA import record is missing its clearinghouse ERA identifier.");
  const summary = basic.extension?.find((extension) => extension.url === ERA_IMPORT_SUMMARY_EXTENSION_URL)?.extension;
  if (!summary) throw new Error("ERA import record is missing its summary extension.");
  const payerName = extensionString(summary, "payerName", "valueString");
  const paidDate = extensionString(summary, "paidDate", "valueDate");
  return {
    eraId,
    summary: {
      importedAt: requiredExtensionString(summary, "importedAt", "valueDateTime"),
      posted: requiredExtensionInteger(summary, "posted"),
      denied: requiredExtensionInteger(summary, "denied"),
      underpaid: requiredExtensionInteger(summary, "underpaid"),
      flagged: requiredExtensionInteger(summary, "flagged"),
      ...(payerName ? { payerName } : {}),
      ...(paidDate ? { paidDate } : {}),
      paidTotalCents: requiredExtensionInteger(summary, "paidTotalCents"),
    },
  };
}

export function projectEraBatchReadModel(
  rawEraList: unknown,
  importBundle: Bundle<Basic>,
  openTaskBundle: Bundle<Task>,
): EraBatchItem[] {
  return projectEraRows(claimMdEraListRows(rawEraList), importBundle, openTaskBundle);
}

export function projectStediEraBatchReadModel(
  rawEraList: unknown,
  importBundle: Bundle<Basic>,
  openTaskBundle: Bundle<Task>,
): EraBatchItem[] {
  const rows = ((rawEraList as { items?: unknown[] }).items ?? [])
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .filter((item) => item.direction === "INBOUND"
      && (item.x12 as any)?.metadata?.transaction?.transactionSetIdentifier === "835")
    .flatMap((item) => typeof item.transactionId === "string" ? [{ eraId: item.transactionId }] : []);
  return projectEraRows(rows, importBundle, openTaskBundle);
}

function projectEraRows(
  rows: Array<{ eraId: string; payerName?: string; paidDate?: string; paidTotalCents?: number }>,
  importBundle: Bundle<Basic>,
  openTaskBundle: Bundle<Task>,
): EraBatchItem[] {
  const imports = new Map(
    resources(importBundle).map((basic) => {
      const parsed = parseEraImportRecord(basic);
      return [parsed.eraId, parsed.summary] as const;
    }),
  );
  const openTaskCounts = new Map<string, number>();
  for (const task of resources(openTaskBundle)) {
    if (!isOpenWorklistTask(task)) continue;
    const eraId = task.groupIdentifier?.system === CLAIMMD_ERA_PAYMENT_SYSTEM
      ? task.groupIdentifier.value
      : taskInputString(task, "era-id");
    if (eraId) openTaskCounts.set(eraId, (openTaskCounts.get(eraId) ?? 0) + 1);
  }

  return rows.map((row) => {
    const summary = imports.get(row.eraId);
    const openTaskCount = openTaskCounts.get(row.eraId) ?? 0;
    return {
      eraId: row.eraId,
      lane: !summary ? "new" : openTaskCount > 0 ? "imported" : "fully-worked",
      ...(summary ? { importedAt: summary.importedAt } : {}),
      posted: summary?.posted ?? 0,
      denied: summary?.denied ?? 0,
      underpaid: summary?.underpaid ?? 0,
      flagged: summary?.flagged ?? 0,
      ...(summary ? { claimCount: summary.posted + summary.denied + summary.flagged } : {}),
      ...(summary?.payerName ?? row.payerName ? { payerName: summary?.payerName ?? row.payerName } : {}),
      ...(summary?.paidDate ?? row.paidDate ? { paidDate: summary?.paidDate ?? row.paidDate } : {}),
      paidTotalCents: summary?.paidTotalCents ?? row.paidTotalCents ?? 0,
      openTaskCount,
    };
  });
}

export function eraWorklistEvidence(eraClaim: ClaimMdEraClaim, eraId: string): EraWorklistEvidence {
  const charges = arrayOf(eraClaim.charge);
  const chargedFromLines = sumCents(charges.map((charge) => charge.charge));
  const chargedCents = eraClaim.total_charge === undefined
    ? chargedFromLines
    : decimalStringToCents(eraClaim.total_charge);
  const allowedCents = sumCents(charges.map((charge) => charge.allowed));
  const paidFromLines = sumCents(charges.map((charge) => charge.paid));
  const paidCents = eraClaim.total_paid === undefined
    ? paidFromLines
    : decimalStringToCents(eraClaim.total_paid);
  const patientResponsibilityCents = charges.reduce(
    (claimTotal, charge) => claimTotal + arrayOf(charge.adjustment)
      .filter((adjustment) => adjustment.group === "PR")
      .reduce((chargeTotal, adjustment) => chargeTotal + decimalStringToCents(adjustment.amount), 0),
    0,
  );
  const shortfallCents = charges.reduce(
    (claimTotal, charge) => claimTotal
      + decimalStringToCents(charge.allowed)
      - decimalStringToCents(charge.paid)
      - arrayOf(charge.adjustment)
        .filter((adjustment) => adjustment.group === "PR")
        .reduce((chargeTotal, adjustment) => chargeTotal + decimalStringToCents(adjustment.amount), 0),
    0,
  );

  return {
    pcn: eraClaim.pcn ?? "",
    payerIcn: eraClaim.payer_icn,
    eraId,
    chargedCents,
    allowedCents,
    paidCents,
    patientResponsibilityCents,
    shortfallCents,
    adjustments: charges.flatMap((charge) => arrayOf(charge.adjustment).map(({ group, code }) => ({ group, code }))),
  };
}

export function buildEraWorklistTask(input: {
  code: EraWorklistCode;
  era: ClaimMdEraData;
  eraClaim: ClaimMdEraClaim;
  claimResponseReference?: string;
  patientReference?: string;
  authoredOn: string;
  appealDeadline?: string;
  identifierSystem?: string;
}): Task {
  if (input.code !== "era-unmatched" && (!input.claimResponseReference || !input.patientReference)) {
    throw new Error(`${input.code} Task requires ClaimResponse focus and Patient beneficiary references.`);
  }
  if (input.code === "era-unmatched" && (input.claimResponseReference || input.patientReference)) {
    throw new Error("era-unmatched Task cannot carry focus or patient references before matching.");
  }

  const eraId = input.era.eraid ?? "";
  const evidence = eraWorklistEvidence(input.eraClaim, eraId);
  const inputs: TaskInput[] = [
    stringInput("pcn", evidence.pcn),
    ...(evidence.payerIcn ? [stringInput("payer-icn", evidence.payerIcn)] : []),
    stringInput("era-id", evidence.eraId),
    integerInput("charged-cents", evidence.chargedCents),
    integerInput("allowed-cents", evidence.allowedCents),
    integerInput("paid-cents", evidence.paidCents),
    integerInput("patient-responsibility-cents", evidence.patientResponsibilityCents),
    integerInput("shortfall-cents", evidence.shortfallCents),
    ...evidence.adjustments.map((adjustment) => stringInput("adjustment-group-code", JSON.stringify(adjustment))),
    stringInput("era-claim-snapshot", JSON.stringify({
      eraid: input.era.eraid,
      paid_date: input.era.paid_date,
      payer_name: input.era.payer_name,
      payment_method: input.era.payment_method,
      claim: input.eraClaim,
    } satisfies ClaimMdEraData)),
  ];

  return {
    resourceType: "Task",
    groupIdentifier: { system: input.identifierSystem ?? CLAIMMD_ERA_PAYMENT_SYSTEM, value: eraId },
    status: "ready",
    intent: "order",
    priority: input.code === "era-underpayment" ? "routine" : "urgent",
    code: codedConcept(ERA_WORKLIST_CODE_SYSTEM, input.code, displayForWorklistCode(input.code)),
    businessStatus: eraWorklistStatusConcept("new"),
    description: displayForWorklistCode(input.code),
    authoredOn: input.authoredOn,
    lastModified: input.authoredOn,
    ...(input.claimResponseReference ? { focus: { reference: input.claimResponseReference } } : {}),
    ...(input.patientReference ? { for: { reference: input.patientReference } } : {}),
    input: inputs,
    ...(input.appealDeadline ? { restriction: { period: { end: input.appealDeadline } } } : {}),
  };
}

export function buildClaimRejectedWorklistTask(input: {
  claimReference?: string;
  patientReference?: string;
  claimMdMessage: string;
  authoredOn: string;
}): Task {
  return {
    resourceType: "Task",
    status: "ready",
    intent: "order",
    priority: "urgent",
    code: codedConcept(CLAIM_REJECTED_CODE_SYSTEM, "claim-rejected", displayForWorklistCode("claim-rejected")),
    businessStatus: eraWorklistStatusConcept("new"),
    description: displayForWorklistCode("claim-rejected"),
    authoredOn: input.authoredOn,
    lastModified: input.authoredOn,
    ...(input.claimReference ? { focus: { reference: input.claimReference } } : {}),
    ...(input.patientReference ? { for: { reference: input.patientReference } } : {}),
    input: [stringInput("claimmd-message", input.claimMdMessage)],
  };
}

export function claimEraWorklistTask(task: Task, ownerReference: string, at: string): Task {
  assertEraWorklistTask(task);
  if (eraWorklistStatus(task) !== "new") {
    throw new EraWorklistConflictError("Only a new ERA worklist Task can be claimed.");
  }
  return {
    ...task,
    status: "in-progress",
    businessStatus: eraWorklistStatusConcept("in-review"),
    owner: { reference: ownerReference },
    executionPeriod: { ...task.executionPeriod, start: task.executionPeriod?.start ?? at },
    lastModified: at,
  };
}

export function resolveEraWorklistTask(
  task: Task,
  input: { disposition: EraWorklistDisposition; claimReference?: string },
  at: string,
): Task {
  assertEraWorklistTask(task);
  if (eraWorklistStatus(task) !== "in-review") {
    throw new EraWorklistConflictError("Only an in-review ERA worklist Task can be resolved.");
  }
  if (input.disposition === "matched" && eraWorklistCode(task) !== "era-unmatched") {
    throw new EraWorklistValidationError("matched is only valid for an era-unmatched Task.");
  }
  if ((input.disposition === "rebilled" || input.disposition === "matched") && !isClaimReference(input.claimReference)) {
    throw new EraWorklistValidationError(`${input.disposition} requires a Claim/<id> reference.`);
  }

  return {
    ...task,
    status: "completed",
    businessStatus: eraWorklistStatusConcept("resolved"),
    executionPeriod: { ...task.executionPeriod, end: at },
    lastModified: at,
    output: [
      {
        type: codedConcept(ERA_WORKLIST_OUTPUT_SYSTEM, "disposition", "Resolution disposition"),
        valueCode: input.disposition,
      },
      ...(input.claimReference ? [{
        type: codedConcept(ERA_WORKLIST_OUTPUT_SYSTEM, "claim-reference", "Claim reference"),
        valueReference: { reference: input.claimReference },
      }] : []),
    ],
  };
}

export function projectEraWorklistBundle(bundle: Bundle<Task>, at: string): EraWorklistAttentionItem[] {
  return (bundle.entry ?? [])
    .flatMap((entry) => entry.resource ? [entry.resource] : [])
    .filter(isEraWorklistTask)
    .map((task) => projectEraWorklistTask(task, at))
    .sort((a, b) => b.ageTimer.elapsedMinutes - a.ageTimer.elapsedMinutes);
}

export function projectEraWorklistTask(task: Task, at: string): EraWorklistAttentionItem {
  assertEraWorklistTask(task);
  if (!task.id) throw new Error("ERA worklist Task is missing its FHIR id.");
  const code = eraWorklistCode(task);
  const status = eraWorklistStatus(task);
  const startedAt = task.authoredOn ?? task.meta?.lastUpdated ?? at;
  return {
    id: task.id,
    taskReference: `Task/${task.id}`,
    title: displayForWorklistCode(code),
    code,
    ...(task.for?.reference ? { patientReference: task.for.reference } : {}),
    ...(task.focus?.reference ? { focusReference: task.focus.reference } : {}),
    severity: code === "era-underpayment" ? "medium" : "high",
    ageTimer: {
      startedAt,
      elapsedMinutes: Math.max(0, Math.floor((Date.parse(at) - Date.parse(startedAt)) / 60_000)),
    },
    action: status === "new" ? "claim" : status === "in-review" ? "resolve" : "none",
    ...(task.owner?.reference ? { owner: task.owner.reference } : {}),
    status,
    evidence: projectedEvidence(task, code),
  };
}

export function eraSnapshotFromTask(task: Task): ClaimMdEraData & { claim: ClaimMdEraClaim } {
  assertEraWorklistTask(task);
  const snapshot = task.input?.find((entry) => inputType(entry) === "era-claim-snapshot")?.valueString;
  if (!snapshot) throw new Error("ERA worklist Task is missing its recoverable ERA claim snapshot.");
  const parsed = JSON.parse(snapshot) as ClaimMdEraData;
  if (!parsed.claim || Array.isArray(parsed.claim)) {
    throw new Error("ERA worklist Task has an invalid ERA claim snapshot.");
  }
  return parsed as ClaimMdEraData & { claim: ClaimMdEraClaim };
}

export function eraWorklistCode(task: Task): WorklistCode {
  for (const entry of WORKLIST_CODE_REGISTRY) {
    const code = task.code?.coding?.find((coding) => coding.system === entry.system)?.code;
    if ((entry.codes as readonly string[]).includes(code ?? "")) {
      return code as WorklistCode;
    }
  }
  throw new Error("Task is not coded as a known OSOD claims worklist item.");
}

export function eraWorklistStatus(task: Task): EraWorklistStatus {
  const code = task.businessStatus?.coding?.find((coding) => coding.system === ERA_WORKLIST_STATUS_SYSTEM)?.code;
  if (!ERA_WORKLIST_STATUSES.includes(code as EraWorklistStatus)) {
    throw new Error("ERA worklist Task has an invalid businessStatus.");
  }
  return code as EraWorklistStatus;
}

export function isEraWorklistDisposition(value: unknown): value is EraWorklistDisposition {
  return typeof value === "string" && ERA_WORKLIST_DISPOSITIONS.includes(value as EraWorklistDisposition);
}

export function isEraWorklistStatus(value: unknown): value is EraWorklistStatus {
  return typeof value === "string" && ERA_WORKLIST_STATUSES.includes(value as EraWorklistStatus);
}

export class EraWorklistValidationError extends Error {}
export class EraWorklistConflictError extends Error {}

function isEraWorklistTask(task: Task): boolean {
  try {
    eraWorklistCode(task);
    return true;
  } catch {
    return false;
  }
}

function assertEraWorklistTask(task: Task): void {
  eraWorklistCode(task);
  eraWorklistStatus(task);
}

function eraWorklistStatusConcept(status: EraWorklistStatus): CodeableConcept {
  const display = status === "new" ? "New" : status === "in-review" ? "In Review" : "Resolved";
  return codedConcept(ERA_WORKLIST_STATUS_SYSTEM, status, display);
}

function codedConcept(system: string, code: string, display: string): CodeableConcept {
  return { coding: [{ system, code, display }], text: display };
}

function stringInput(code: string, valueString: string): TaskInput {
  return { type: codedConcept(ERA_WORKLIST_INPUT_SYSTEM, code, code), valueString };
}

function integerInput(code: string, valueInteger: number): TaskInput {
  return { type: codedConcept(ERA_WORKLIST_INPUT_SYSTEM, code, code), valueInteger };
}

function inputType(input: TaskInput): string | undefined {
  return input.type.coding?.find((coding) => coding.system === ERA_WORKLIST_INPUT_SYSTEM)?.code;
}

function displayForWorklistCode(code: WorklistCode): string {
  if (code === "era-denial") return "ERA denial requires review";
  if (code === "era-line-linkage") return "ERA line linkage requires review";
  if (code === "era-underpayment") return "ERA underpayment requires review";
  if (code === "claim-rejected") return "Rejected claim requires correction";
  return "Unmatched ERA claim requires mapping";
}

function projectedEvidence(task: Task, code: WorklistCode): EraWorklistProjectedEvidence | ClaimRejectedProjectedEvidence {
  if (code === "claim-rejected") {
    return {
      kind: "claim-rejected",
      claimMdMessage: taskInputString(task, "claimmd-message") ?? "",
    };
  }
  return {
    kind: "era",
    pcn: taskInputString(task, "pcn") ?? "",
    ...(taskInputString(task, "payer-icn") ? { payerIcn: taskInputString(task, "payer-icn") } : {}),
    eraId: taskInputString(task, "era-id") ?? "",
    chargedCents: taskInputInteger(task, "charged-cents"),
    allowedCents: taskInputInteger(task, "allowed-cents"),
    paidCents: taskInputInteger(task, "paid-cents"),
    patientResponsibilityCents: taskInputInteger(task, "patient-responsibility-cents"),
    shortfallCents: taskInputInteger(task, "shortfall-cents"),
    adjustments: (task.input ?? [])
      .filter((entry) => inputType(entry) === "adjustment-group-code")
      .map((entry) => JSON.parse(entry.valueString ?? "") as { group?: string; code?: string }),
  };
}

function taskInputString(task: Task, code: string): string | undefined {
  return task.input?.find((entry) => inputType(entry) === code)?.valueString;
}

function taskInputInteger(task: Task, code: string): number {
  return task.input?.find((entry) => inputType(entry) === code)?.valueInteger ?? 0;
}

function isOpenWorklistTask(task: Task): boolean {
  const status = task.businessStatus?.coding?.find((coding) => coding.system === ERA_WORKLIST_STATUS_SYSTEM)?.code;
  return status === "new" || status === "in-review";
}

function claimMdEraListRows(raw: unknown): Array<{
  eraId: string;
  payerName?: string;
  paidDate?: string;
  paidTotalCents?: number;
}> {
  const era = (raw as { result?: { era?: unknown } }).result?.era;
  return arrayOf(era)
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .flatMap((row) => {
      const eraId = scalarString(row.eraid);
      if (!eraId) return [];
      const payerName = scalarString(row.payer_name);
      const paidDate = scalarString(row.paid_date);
      const paidAmount = scalarString(row.paid_amount);
      return [{
        eraId,
        ...(payerName ? { payerName } : {}),
        ...(paidDate ? { paidDate } : {}),
        ...(paidAmount ? { paidTotalCents: decimalStringToCents(paidAmount) } : {}),
      }];
    });
}

function resources<T extends Basic | Task>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function requiredExtensionInteger(extensions: Extension[], url: string): number {
  const value = extensions.find((extension) => extension.url === url)?.valueInteger;
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error(`ERA import record ${url} must be a nonnegative integer.`);
  }
  return value;
}

function requiredExtensionString(
  extensions: Extension[],
  url: string,
  field: "valueDateTime" | "valueDate" | "valueString",
): string {
  const value = extensionString(extensions, url, field);
  if (!value) throw new Error(`ERA import record is missing ${url}.`);
  return value;
}

function extensionString(
  extensions: Extension[],
  url: string,
  field: "valueDateTime" | "valueDate" | "valueString",
): string | undefined {
  return extensions.find((extension) => extension.url === url)?.[field];
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isClaimReference(value: string | undefined): boolean {
  return typeof value === "string" && /^Claim\/[A-Za-z0-9.-]+$/.test(value);
}

function sumCents(values: Array<string | undefined>): number {
  return values.reduce((sum, value) => sum + decimalStringToCents(value), 0);
}

function decimalStringToCents(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
