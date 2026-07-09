import type { Bundle, CodeableConcept, Task, TaskInput } from "@medplum/fhirtypes";
import type { ClaimMdEraClaim, ClaimMdEraData } from "./claimmd-fhir.js";

export const ERA_WORKLIST_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/osod-era-worklist";
export const CLAIM_REJECTED_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/osod-claim-rejected-worklist";
export const ERA_WORKLIST_STATUS_SYSTEM = "https://osod.dev/fhir/CodeSystem/era-worklist-status";
export const ERA_WORKLIST_INPUT_SYSTEM = "https://osod.dev/fhir/CodeSystem/era-worklist-input";
export const ERA_WORKLIST_OUTPUT_SYSTEM = "https://osod.dev/fhir/CodeSystem/era-worklist-output";

export const ERA_WORKLIST_CODES = ["era-denial", "era-unmatched", "era-underpayment"] as const;
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
