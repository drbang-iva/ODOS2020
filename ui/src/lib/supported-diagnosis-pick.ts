import { updateConditionBodySite } from "./clinical-actions";
import { submitDiagnosisPickResult, type SupportingFindingFact } from "./clinical-graph-client";
import { buildFindingCommand, type DiagnosisFindingsPayload } from "./diagnosis-findings";
import type { Condition } from "@medplum/fhirtypes";

export function supportedFindingLink(commandId: string, supports: SupportingFindingFact[], current: DiagnosisFindingsPayload, patientReference: string, conditionReference: string) {
  const rows = supports.map(support => current.searchIndex.find(row => row.rowKey === support.rowKey));
  if (rows.some(row => !row || !row.editable)) return undefined;
  const command = buildFindingCommand(rows.filter((row): row is NonNullable<typeof row> => Boolean(row)), patientReference, "link", { selectedConditionReference: conditionReference, liveConditionReferences: [...current.visitDiagnoses.map(diagnosis => diagnosis.conditionReference), conditionReference] });
  command.commandId = commandId;
  command.targets = command.targets.map((target, index) => ({ ...target, baseline: supports[index]!.baseline }));
  return command;
}

export async function supportedDiagnosisPick(options: {
  request: Parameters<typeof submitDiagnosisPickResult>[0];
  scope?: Omit<Parameters<typeof updateConditionBodySite>[0], "condition">;
  onPicked(condition: Condition): void | boolean | Promise<void | boolean>;
  onScoped(condition: Condition): void;
  link?(conditionReference: string): Promise<void>;
  message(value: string): void;
}) {
  let diagnosisSaved = false;
  try {
    const result = await submitDiagnosisPickResult(options.request);
    if (result.result !== "pick" || result.conditionStep !== "applied") {
      options.message(result.result === "pick" && result.conditionStep === "unconfirmed" ? "Diagnosis not confirmed — reload" : result.error);
      return;
    }
    diagnosisSaved = true;
    if (await options.onPicked(result.condition) === false) return;
    let condition = result.condition;
    options.message(`Diagnosis saved${result.error ? `: ${result.error}` : ""}`);
    if (options.scope) {
      try { condition = await updateConditionBodySite({ condition, ...options.scope }); }
      catch (caught) { options.message(`Diagnosis saved · Scope not saved: ${caught instanceof Error ? caught.message : String(caught)}`); return; }
    }
    options.onScoped(condition);
    if (options.link) {
      try { await options.link(`Condition/${condition.id}`); }
      catch (caught) { options.message(`Diagnosis saved · Linking incomplete: ${caught instanceof Error ? caught.message : String(caught)}`); }
    }
    else options.message("Diagnosis saved · Scope saved");
  } catch (caught) {
    options.message(`${diagnosisSaved ? "Diagnosis saved · Follow-up incomplete:" : "Diagnosis not confirmed — reload."} ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}
