import { z } from "zod";
import type {
  AdjudicationDecision,
  ImportAmbiguity,
  ImportLedger,
} from "./import-ledger.js";

const allocationDecisionSchema = z.object({
  visitDaySourceKey: z.string().trim().min(1),
  exSrNo: z.string().trim().min(1),
  appointmentSourceKey: z.string().trim().min(1),
  note: z.string().trim().min(1).optional(),
}).strict();

const adjudicationDecisionSchema = z.object({
  sourceKind: z.string().trim().min(1),
  sourceKey: z.string().trim().min(1),
  decision: z.enum(["keep", "exclude", "mark-as-test"]),
  note: z.string().trim().min(1).optional(),
}).strict();

export const legacyImportDecisionFileSchema = z.object({
  decidedBy: z.string().trim().min(1),
  allocations: z.array(allocationDecisionSchema).default([]),
  adjudications: z.array(adjudicationDecisionSchema).default([]),
}).strict();

export type LegacyImportDecisionFile = z.infer<typeof legacyImportDecisionFileSchema>;

export type PendingDecision =
  | {
      readonly kind: "allocation";
      readonly visitDaySourceKey: string;
      readonly exSrNo: string;
      readonly appointmentSourceKeys: readonly string[];
    }
  | {
      readonly kind: "adjudication";
      readonly sourceKind: string;
      readonly sourceKey: string;
      readonly ambiguityType: string;
      readonly decisions: readonly AdjudicationDecision[];
    };

export function applyDecisionFile(
  ledger: ImportLedger,
  value: unknown,
): { recorded: number; previouslyDecided: number } {
  const decisions = legacyImportDecisionFileSchema.parse(value);
  let recorded = 0;
  let previouslyDecided = 0;

  for (const allocation of decisions.allocations) {
    const ambiguity = findAllocationAmbiguity(ledger, allocation.visitDaySourceKey);
    assertAllocationCandidate(
      ambiguity,
      allocation.exSrNo,
      allocation.appointmentSourceKey,
    );
    const existing = ledger.readCaptureAllocation(
      allocation.visitDaySourceKey,
      allocation.exSrNo,
    );
    if (existing) {
      if (
        existing.appointmentSourceKey !== allocation.appointmentSourceKey
        || (existing.note ?? undefined) !== allocation.note
      ) {
        throw new Error(
          `Capture ${allocation.exSrNo} for ${allocation.visitDaySourceKey} is already allocated to ${existing.appointmentSourceKey}.`,
        );
      }
      refreshAllocationAmbiguity(ledger, ambiguity);
      previouslyDecided += 1;
      continue;
    }
    ledger.recordCaptureAllocation({
      ...allocation,
      decidedBy: decisions.decidedBy,
    });
    recorded += 1;
    refreshAllocationAmbiguity(ledger, ambiguity);
  }

  for (const adjudication of decisions.adjudications) {
    const ambiguities = ledger.listAmbiguities({
      sourceKind: adjudication.sourceKind,
      sourceKey: adjudication.sourceKey,
    });
    if (ambiguities.length === 0) {
      throw new Error(
        `No ambiguity is queued for ${adjudication.sourceKind}/${adjudication.sourceKey}.`,
      );
    }
    const allowedDecisions = new Set(
      ambiguities.flatMap((ambiguity) => allowedAdjudicationDecisions(ambiguity)),
    );
    if (!allowedDecisions.has(adjudication.decision)) {
      throw new Error(
        `Adjudication decision ${adjudication.decision} is not allowed for ${adjudication.sourceKind}/${adjudication.sourceKey}.`,
      );
    }
    const existing = ledger.readAdjudication(
      adjudication.sourceKind,
      adjudication.sourceKey,
    );
    if (existing) {
      if (
        existing.decision !== adjudication.decision
        || (existing.note ?? undefined) !== adjudication.note
      ) {
        throw new Error(
          `${adjudication.sourceKind}/${adjudication.sourceKey} is already adjudicated as ${existing.decision}.`,
        );
      }
      previouslyDecided += 1;
      continue;
    }
    ledger.recordAdjudication({
      ...adjudication,
      decidedBy: decisions.decidedBy,
    });
    for (const ambiguity of ambiguities) {
      ledger.resolveAmbiguity(
        ambiguity.sourceKind,
        ambiguity.sourceKey,
        ambiguity.ambiguityType,
      );
    }
    recorded += 1;
  }

  return { recorded, previouslyDecided };
}

export function listPendingDecisions(
  ledger: ImportLedger,
  input: { readonly runId?: string; readonly patientSourceKey?: string } = {},
): PendingDecision[] {
  const sourceKeys = scopedSourceKeys(ledger, input);
  const ambiguities = ledger.listAmbiguities({ state: "open" }).filter(
    (ambiguity) => !sourceKeys || sourceKeys.has(ambiguity.sourceKey),
  );
  const pending: PendingDecision[] = [];

  for (const ambiguity of ambiguities) {
    if (ambiguity.ambiguityType === "multi-appointment-day") {
      const exSrNos = stringArray(ambiguity.details.exSrNos, "exSrNos", ambiguity);
      const appointmentSourceKeys = stringArray(
        ambiguity.details.appointmentSourceKeys,
        "appointmentSourceKeys",
        ambiguity,
      );
      for (const exSrNo of exSrNos) {
        const allocation = ledger.readCaptureAllocation(ambiguity.sourceKey, exSrNo);
        if (
          !allocation
          || !appointmentSourceKeys.includes(allocation.appointmentSourceKey)
        ) {
          pending.push({
            kind: "allocation",
            visitDaySourceKey: ambiguity.sourceKey,
            exSrNo,
            appointmentSourceKeys,
          });
        }
      }
      if (exSrNos.every((exSrNo) => {
        const allocation = ledger.readCaptureAllocation(ambiguity.sourceKey, exSrNo);
        return allocation
          && appointmentSourceKeys.includes(allocation.appointmentSourceKey);
      })) {
        ledger.resolveAmbiguity(
          ambiguity.sourceKind,
          ambiguity.sourceKey,
          ambiguity.ambiguityType,
        );
      }
      continue;
    }
    if (ledger.readAdjudication(ambiguity.sourceKind, ambiguity.sourceKey)) {
      ledger.resolveAmbiguity(
        ambiguity.sourceKind,
        ambiguity.sourceKey,
        ambiguity.ambiguityType,
      );
      continue;
    }
    const decisions = allowedAdjudicationDecisions(ambiguity);
    if (decisions.length === 0) continue;
    pending.push({
      kind: "adjudication",
      sourceKind: ambiguity.sourceKind,
      sourceKey: ambiguity.sourceKey,
      ambiguityType: ambiguity.ambiguityType,
      decisions,
    });
  }

  return pending;
}

export async function runInteractiveAdjudication(input: {
  readonly ledger: ImportLedger;
  readonly decidedBy: string;
  readonly runId?: string;
  readonly patientSourceKey?: string;
  readonly prompt: (question: string) => Promise<string>;
}): Promise<{ asked: number; recorded: number }> {
  let asked = 0;
  let recorded = 0;
  for (;;) {
    const pending = listPendingDecisions(input.ledger, input);
    const decision = pending[0];
    if (!decision) return { asked, recorded };
    if (decision.kind === "allocation") {
      const answer = (await input.prompt(
        `Allocate capture ${decision.exSrNo} for ${decision.visitDaySourceKey} to ${decision.appointmentSourceKeys.join(" | ")}: `,
      )).trim();
      asked += 1;
      if (!decision.appointmentSourceKeys.includes(answer)) {
        throw new Error(`Allocation target ${answer || "(blank)"} is not a candidate appointment.`);
      }
      input.ledger.recordCaptureAllocation({
        visitDaySourceKey: decision.visitDaySourceKey,
        exSrNo: decision.exSrNo,
        appointmentSourceKey: answer,
        decidedBy: input.decidedBy,
      });
      refreshAllocationAmbiguity(
        input.ledger,
        findAllocationAmbiguity(input.ledger, decision.visitDaySourceKey),
      );
      recorded += 1;
      continue;
    }
    const answer = (await input.prompt(
      `Decide ${decision.sourceKind}/${decision.sourceKey} (${decision.ambiguityType}) [${decision.decisions.join("|")}]: `,
    )).trim() as AdjudicationDecision;
    asked += 1;
    if (!decision.decisions.includes(answer)) {
      throw new Error(`Adjudication decision ${answer || "(blank)"} is not allowed.`);
    }
    input.ledger.recordAdjudication({
      sourceKind: decision.sourceKind,
      sourceKey: decision.sourceKey,
      decision: answer,
      decidedBy: input.decidedBy,
    });
    input.ledger.resolveAmbiguity(
      decision.sourceKind,
      decision.sourceKey,
      decision.ambiguityType,
    );
    recorded += 1;
  }
}

function allowedAdjudicationDecisions(
  ambiguity: ImportAmbiguity,
): readonly AdjudicationDecision[] {
  const values = ambiguity.details.decisions;
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value): value is AdjudicationDecision =>
      value === "keep" || value === "exclude" || value === "mark-as-test",
  );
}

function scopedSourceKeys(
  ledger: ImportLedger,
  input: { readonly runId?: string; readonly patientSourceKey?: string },
): Set<string> | undefined {
  if (input.runId && input.patientSourceKey) {
    throw new Error("Choose either runId or patientSourceKey, not both.");
  }
  if (input.runId) return new Set(ledger.listRunSourceKeys(input.runId));
  if (input.patientSourceKey) {
    const runIds = ledger.listPatientRunIds(input.patientSourceKey);
    if (runIds.length === 0) {
      throw new Error(`No import run is recorded for patient source ${input.patientSourceKey}.`);
    }
    return new Set(runIds.flatMap((runId) => ledger.listRunSourceKeys(runId)));
  }
  return undefined;
}

function findAllocationAmbiguity(
  ledger: ImportLedger,
  visitDaySourceKey: string,
): ImportAmbiguity {
  const ambiguity = ledger.listAmbiguities({
    sourceKind: "visit-day",
    sourceKey: visitDaySourceKey,
  }).find((row) => row.ambiguityType === "multi-appointment-day");
  if (!ambiguity) {
    throw new Error(`No multi-appointment day is queued for ${visitDaySourceKey}.`);
  }
  return ambiguity;
}

function assertAllocationCandidate(
  ambiguity: ImportAmbiguity,
  exSrNo: string,
  appointmentSourceKey: string,
): void {
  const exSrNos = stringArray(ambiguity.details.exSrNos, "exSrNos", ambiguity);
  const appointmentSourceKeys = stringArray(
    ambiguity.details.appointmentSourceKeys,
    "appointmentSourceKeys",
    ambiguity,
  );
  if (!exSrNos.includes(exSrNo)) {
    throw new Error(`Capture ${exSrNo} is not queued for ${ambiguity.sourceKey}.`);
  }
  if (!appointmentSourceKeys.includes(appointmentSourceKey)) {
    throw new Error(
      `Appointment ${appointmentSourceKey} is not a candidate for ${ambiguity.sourceKey}.`,
    );
  }
}

function refreshAllocationAmbiguity(
  ledger: ImportLedger,
  ambiguity: ImportAmbiguity,
): void {
  const exSrNos = stringArray(ambiguity.details.exSrNos, "exSrNos", ambiguity);
  const appointmentSourceKeys = stringArray(
    ambiguity.details.appointmentSourceKeys,
    "appointmentSourceKeys",
    ambiguity,
  );
  const missingExSrNos: string[] = [];
  const invalidExSrNos: string[] = [];
  for (const exSrNo of exSrNos) {
    const allocation = ledger.readCaptureAllocation(ambiguity.sourceKey, exSrNo);
    if (!allocation) missingExSrNos.push(exSrNo);
    else if (!appointmentSourceKeys.includes(allocation.appointmentSourceKey)) {
      invalidExSrNos.push(exSrNo);
    }
  }
  ledger.recordAmbiguity({
    sourceKind: ambiguity.sourceKind,
    sourceKey: ambiguity.sourceKey,
    ambiguityType: ambiguity.ambiguityType,
    details: {
      ...ambiguity.details,
      appointmentSourceKeys,
      exSrNos,
      missingExSrNos,
      invalidExSrNos,
    },
  });
  if (missingExSrNos.length === 0 && invalidExSrNos.length === 0) {
    ledger.resolveAmbiguity(
      ambiguity.sourceKind,
      ambiguity.sourceKey,
      ambiguity.ambiguityType,
    );
  }
}

function stringArray(
  value: unknown,
  field: string,
  ambiguity: ImportAmbiguity,
): string[] {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(
      `${ambiguity.ambiguityType} ${ambiguity.sourceKey} has invalid ${field} details.`,
    );
  }
  return value;
}
