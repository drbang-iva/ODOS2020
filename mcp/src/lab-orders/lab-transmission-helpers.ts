import type { Task } from "@medplum/fhirtypes";
import { isTerminalLabTransportState } from "../fhir/labTransportState.js";
import { isLabOrderTransmissionTask, transportStateFromTask, ODOS_LAB_ORDER_TASK_CODE_SYSTEM, LAB_ORDER_TRANSMISSION_TASK_CODE, type LabOrderFhirClient } from "./adapters/manual-lab-order-adapter.js";
export function taskIdFromReference(reference: string, field: string): string {
  const match = reference?.match(/^Task\/([A-Za-z0-9.-]+)$/);
  if (!match) throw new Error(`${field} must be a local "Task/<id>" reference.`);
  return match[1];
}
export function assertStaffReference(reference: string): void {
  if (!/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]+$/.test(reference ?? "")) throw new Error('staffReference must be a local "Practitioner/<id>" or "PractitionerRole/<id>" reference.');
}
export async function findActiveTransmissions(fhir: Pick<LabOrderFhirClient,"search">, orderTaskReference: string): Promise<Task[]> {
  const existing=await fhir.search<Task>("Task",{"based-on":orderTaskReference,code:`${ODOS_LAB_ORDER_TASK_CODE_SYSTEM}|${LAB_ORDER_TRANSMISSION_TASK_CODE}`,_count:"1000"});
  if (existing.link?.some(link=>link.relation==="next")) throw new Error("Lab transmission search exceeded one FHIR page; cannot safely enforce the double-submit guard.");
  return (existing.entry??[]).flatMap(entry=>entry.resource?[entry.resource]:[]).filter(task=>isLabOrderTransmissionTask(task)
    && task.basedOn?.some(ref=>ref.reference===orderTaskReference) && !isTerminalLabTransportState(transportStateFromTask(task)));
}
