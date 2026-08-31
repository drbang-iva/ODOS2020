import type { Resource, Task } from "@medplum/fhirtypes";
import { collectAllPages, type PaginatedFhir } from "./fhir-pagination.js";
import type { WatcherDefinition, WatcherMatch, WatcherSeverity } from "./watcher-types.js";

export const WATCHER_CONDITION_SYSTEM = "https://odos2020.com/fhir/NamingSystem/watcher-condition";
export const WATCHER_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/watcher";
export const WATCHER_INPUT_SYSTEM = "https://odos2020.com/fhir/CodeSystem/watcher-input";
export const WATCHER_STATUS_SYSTEM = "https://odos2020.com/fhir/CodeSystem/watcher-status";

export interface WatcherTaskFhir extends PaginatedFhir {
  create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T>;
}

export async function reconcileWatcherTasks(
  fhir: WatcherTaskFhir,
  definition: WatcherDefinition,
  matches: WatcherMatch[],
  severity: WatcherSeverity,
  now: string,
): Promise<Task[]> {
  const existing = await collectAllPages<Task>(
    fhir,
    "Task",
    { code: `${WATCHER_CODE_SYSTEM}|${definition.id}`, _count: "1000" },
    `${definition.id} Tasks`,
  );
  const byCondition = new Map(existing.flatMap((task) => {
    const key = conditionKey(task);
    return key ? [[key, task] as const] : [];
  }));
  const activeConditions = new Set(matches.map((match) => match.conditionKey));
  const persisted: Task[] = [];

  for (const match of matches) {
    const prior = byCondition.get(match.conditionKey);
    if (prior?.status === "cancelled") {
      persisted.push(prior);
      continue;
    }
    const candidate = buildWatcherTask(definition, match, severity, now, prior);
    if (prior?.id) {
      persisted.push(await fhir.update("Task", prior.id, candidate));
      continue;
    }
    const created = await fhir.create(candidate, {
      "If-None-Exist": `identifier=${WATCHER_CONDITION_SYSTEM}|${match.conditionKey}`,
    });
    if (conditionKey(created) !== match.conditionKey) {
      throw new Error(`Conditional create returned the wrong Task for ${match.conditionKey}.`);
    }
    persisted.push(created);
  }

  for (const prior of existing) {
    const key = conditionKey(prior);
    if (
      prior.id
      && key
      && !activeConditions.has(key)
      && (prior.status === "requested" || prior.status === "on-hold" || prior.status === "in-progress")
    ) {
      persisted.push(await fhir.update("Task", prior.id, {
        ...prior,
        status: "completed",
        lastModified: now,
      }));
    }
  }
  return persisted;
}

export function buildWatcherTask(
  definition: WatcherDefinition,
  match: WatcherMatch,
  severity: WatcherSeverity,
  now: string,
  existing?: Task,
): Task {
  return {
    resourceType: "Task",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: WATCHER_CONDITION_SYSTEM, value: match.conditionKey }],
    status: "requested",
    intent: "order",
    code: { coding: [{ system: WATCHER_CODE_SYSTEM, code: definition.id }], text: definition.question },
    for: { reference: match.patientReference, display: match.patientDisplay },
    focus: { reference: match.appointmentReference },
    owner: { display: definition.owner },
    businessStatus: { coding: [{ system: WATCHER_STATUS_SYSTEM, code: severity }] },
    description: match.ownerMessage,
    authoredOn: existing?.authoredOn ?? now,
    lastModified: now,
    restriction: { period: { start: match.appointmentAt } },
    input: [
      input("front-desk-message", { valueString: match.frontDeskMessage }),
      input("consequence", { valueString: definition.consequence }),
      input("primary-action-label", { valueString: definition.nextAction.label }),
      input("primary-action-href", { valueString: definition.nextAction.href(match) }),
      input("balance-cents", { valueInteger: match.balanceCents }),
      input("balance-age-days", { valueInteger: match.ageDays }),
      input("source-invoice-count", { valueInteger: match.sourceInvoiceCount }),
      input("source-occurred-at", { valueDateTime: match.sourceOccurredAt }),
      ...(match.reasonCode ? [input("reason-code", { valueString: match.reasonCode })] : []),
      ...(match.coverageReference ? [input("coverage-reference", { valueString: match.coverageReference })] : []),
      ...(match.payerDisplay ? [input("payer-display", { valueString: match.payerDisplay })] : []),
      ...(match.eligibilityCheckResult ? [input("eligibility-result", { valueString: match.eligibilityCheckResult })] : []),
      ...(match.cobStatus ? [input("cob-status", { valueString: match.cobStatus })] : []),
      ...(match.cobReason ? [input("cob-reason", { valueString: match.cobReason })] : []),
      ...(match.memberIdProposal ? [input("member-id-proposal", { valueString: JSON.stringify(match.memberIdProposal) })] : []),
    ],
  };
}

export function conditionKey(task: Task): string | undefined {
  return task.identifier?.find((identifier) => identifier.system === WATCHER_CONDITION_SYSTEM)?.value;
}

function input(code: string, value: Omit<NonNullable<Task["input"]>[number], "type">) {
  return {
    type: { coding: [{ system: WATCHER_INPUT_SYSTEM, code }] },
    ...value,
  };
}
