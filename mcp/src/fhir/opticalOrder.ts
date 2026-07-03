import type { DeviceRequest, Task } from "@medplum/fhirtypes";
import { HCPCS_SYSTEM } from "../catalog/frame-types.js";
import { opticalOrderStatusConcept } from "./opticalOrderStatus.js";

export interface SpectacleOrderInput {
  patientReference: string;
  /** The signed spectacle Rx this order fulfills. Linked via DeviceRequest.basedOn (R4 targets = Any). */
  visionPrescriptionReference: string;
  /** Caller-supplied HCPCS/CPT code (ODOS never hardcodes billing codes). */
  hcpcsCode: string;
  hcpcsDisplay?: string;
  status?: DeviceRequest["status"];
}

/**
 * Build the R4 DeviceRequest that is the "glasses order" in the optical cash-order composite.
 * Owns the product identity (HCPCS) and the Rx link; the 17-value order-status lifecycle lives on
 * a sibling Task.businessStatus, not here. See performance-od Slice-3 spec §7 (dual-source verified).
 *
 * R4 element notes (would 400 if mis-versioned): codeCodeableConcept (NOT R5 product[x]); basedOn
 * targets are unconstrained so VisionPrescription is a legal reference.
 */
export function buildSpectacleOrderDeviceRequest(input: SpectacleOrderInput): DeviceRequest {
  if (!input.visionPrescriptionReference) {
    throw new Error("Spectacle order requires a VisionPrescription reference (the spectacle Rx).");
  }
  if (!input.patientReference) {
    throw new Error("Spectacle order requires a patient reference.");
  }
  if (!input.hcpcsCode) {
    throw new Error("Spectacle order requires an HCPCS frame/lens code.");
  }

  return {
    resourceType: "DeviceRequest",
    status: input.status ?? "active",
    intent: "order",
    codeCodeableConcept: {
      coding: [
        {
          system: HCPCS_SYSTEM,
          code: input.hcpcsCode,
          ...(input.hcpcsDisplay ? { display: input.hcpcsDisplay } : {}),
        },
      ],
    },
    subject: { reference: input.patientReference },
    basedOn: [{ reference: input.visionPrescriptionReference }],
  };
}

export interface OpticalOrderTaskInput {
  patientReference: string;
  deviceRequestReference: string;
  /** One of the 17 optical order statuses (defaults to "quote"). Bound to Task.businessStatus. */
  businessStatus?: string;
  /** FHIR R4 Task.status (required workflow vocabulary). Defaults to "in-progress". */
  status?: Task["status"];
}

/**
 * Build the R4 Task that owns the optical order's 17-value lifecycle.
 *
 * Task.businessStatus carries the ODOS optical-order status (local CodeSystem); Task.status stays on
 * the FHIR required workflow vocabulary. Task.focus → the DeviceRequest (glasses order); Task.for →
 * the Patient. See Slice-3 spec §7 (dual-source verified: Task.focus/for are Reference(Any) in R4).
 */
export function buildOpticalOrderTask(input: OpticalOrderTaskInput): Task {
  if (!input.patientReference) {
    throw new Error("Optical order Task requires a patient reference.");
  }
  if (!input.deviceRequestReference) {
    throw new Error("Optical order Task requires the DeviceRequest (glasses order) reference.");
  }

  return {
    resourceType: "Task",
    status: input.status ?? "in-progress",
    intent: "order",
    focus: { reference: input.deviceRequestReference },
    for: { reference: input.patientReference },
    businessStatus: opticalOrderStatusConcept(input.businessStatus ?? "quote"),
  };
}
