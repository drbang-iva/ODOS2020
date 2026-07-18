import type { LabTransportState } from "../fhir/labTransportState.js";
import type { LabOrder } from "../fhir/opticalLabOrder.js";

export interface SubmitLabOrderRequest {
  order: LabOrder;
  orderTaskReference: string;
  staffReference: string;
  lab: string;
}

export interface LabOrderSubmissionResult {
  labOrderReference: string;
  transportState: LabTransportState;
  transmittedVia: "manual" | "api";
  artifact?: { kind: "html-sheet"; content: string };
  submittedAt: string;
}

export interface AdvanceLabTransportRequest {
  labOrderReference: string;
  toState: LabTransportState;
  staffReference: string;
  note?: string;
}

export interface LabOrderAdapter {
  submit(req: SubmitLabOrderRequest): Promise<LabOrderSubmissionResult>;
  getTransportState(labOrderReference: string): Promise<LabTransportState>;
  advanceTransportState(req: AdvanceLabTransportRequest): Promise<LabTransportState>;
  cancel(labOrderReference: string, staffReference: string): Promise<void>;
  readonly vendorId: string;
  readonly name: string;
  readonly vendorApiRequired: boolean;
}
