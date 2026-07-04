import type { VisionPrescription, VisionPrescriptionLensSpecification } from "@medplum/fhirtypes";

/**
 * Slice-3b lab-order emitter (transport T0). Assembles a DCS/OMA-shaped LabOrder from the ODOS
 * FHIR order + its VisionPrescription + caller-supplied order-level lens spec and frame. The model
 * is deliberately shaped toward the Vision Council Data Communication Standard so T1 (direct DCS
 * file to an independent lab) serializes it without rework. See performance-od
 * decisions/2026-07-04-odos-slice3b-lab-order-emitter-t0-spec.md.
 *
 * Field enumeration is corpus-sourced from the Foxfire "Print Rx / Lab Details" packing sheet +
 * Lab-Information cascade (orders-optical-cl.md:55,91) — not invented.
 */

/** One eye's lab-order Rx. Rx values come from VisionPrescription; PD/seg-height are fitting measurements (caller). */
export interface LabOrderRxEye {
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  /** Prism magnitude (VisionPrescription prism amount). */
  prism?: number;
  /** Prism base direction (up|down|in|out). */
  base?: "up" | "down" | "in" | "out";
  /** Distance PD (fitting measurement, caller-supplied). */
  distPd?: number;
  /** Near PD (fitting measurement, caller-supplied). */
  nearPd?: number;
  /** Segment height (fitting measurement, caller-supplied). */
  segHeight?: number;
}

export interface LabOrderLensSpec {
  jobType: string;
  lensDesign: string;
  lensMaterial: string;
  treatments: string[];
  specialInstructions?: string;
  commentsToLab?: string;
}

export interface LabOrderFrame {
  brand?: string;
  model?: string;
  color?: string;
  eye?: string;
  bridge?: string;
  temple?: string;
  a?: string;
  b?: string;
  ed?: string;
  dbl?: string;
  frameType?: string;
  /** How the frame is supplied to the lab. */
  source: "frame-to-come" | "patient-own" | "stock";
}

export interface LabOrder {
  header: {
    orderId: string;
    orderDate: string;
    lab: string;
    shipTo?: string;
    patientName: string;
    patientRef?: string;
    providerName?: string;
    trayNumber?: string;
  };
  rx: {
    od: LabOrderRxEye;
    os: LabOrderRxEye;
    /** Caller-supplied lens CPT (data, never asserted by ODOS). */
    lensCpt?: string;
  };
  lensSpec: LabOrderLensSpec;
  frame?: LabOrderFrame;
  /** Optional OMA trace reference from an in-office tracer (present for T1; absent for pure print). */
  frameTraceRef?: string;
}

/** Per-eye fitting measurements the Rx doesn't carry (distPd/nearPd/segHeight), keyed by eye. */
export interface LabOrderFitting {
  od?: Pick<LabOrderRxEye, "distPd" | "nearPd" | "segHeight">;
  os?: Pick<LabOrderRxEye, "distPd" | "nearPd" | "segHeight">;
}

export interface BuildLabOrderInput {
  orderId: string;
  orderDate: string;
  lab: string;
  shipTo?: string;
  patientName: string;
  patientRef?: string;
  providerName?: string;
  trayNumber?: string;
  /** The signed spectacle Rx; OD/OS Rx values are read from its lensSpecification (never re-captured). */
  visionPrescription: VisionPrescription;
  lensSpec: LabOrderLensSpec;
  fitting?: LabOrderFitting;
  frame?: LabOrderFrame;
  lensCpt?: string;
  frameTraceRef?: string;
}

export function buildLabOrder(input: BuildLabOrderInput): LabOrder {
  if (!input.orderId) {
    throw new Error("Lab order requires an orderId.");
  }
  if (!input.patientName) {
    throw new Error("Lab order requires a patientName.");
  }
  if (!input.lab) {
    throw new Error("Lab order requires a destination lab.");
  }

  const specs = input.visionPrescription.lensSpecification ?? [];
  const right = specs.find((s) => s.eye === "right");
  const left = specs.find((s) => s.eye === "left");
  if (!right && !left) {
    throw new Error("Lab order requires at least one eye's Rx in the VisionPrescription lensSpecification.");
  }

  return {
    header: {
      orderId: input.orderId,
      orderDate: input.orderDate,
      lab: input.lab,
      ...(input.shipTo ? { shipTo: input.shipTo } : {}),
      patientName: input.patientName,
      ...(input.patientRef ? { patientRef: input.patientRef } : {}),
      ...(input.providerName ? { providerName: input.providerName } : {}),
      ...(input.trayNumber ? { trayNumber: input.trayNumber } : {}),
    },
    rx: {
      od: rxEye(right, input.fitting?.od),
      os: rxEye(left, input.fitting?.os),
      ...(input.lensCpt ? { lensCpt: input.lensCpt } : {}),
    },
    lensSpec: input.lensSpec,
    ...(input.frame ? { frame: input.frame } : {}),
    ...(input.frameTraceRef ? { frameTraceRef: input.frameTraceRef } : {}),
  };
}

/**
 * Tagged, versioned envelope of the LabOrder — the T1 seam. T1 (direct DCS/OMA file) serializes
 * `order` to the Vision Council byte-format once the free v3.14 spec is read (spec §5.2). Kept a
 * plain JSON snapshot so it round-trips cleanly.
 */
export interface LabOrderExport {
  format: "osod-lab-order";
  version: "0";
  order: LabOrder;
}

export function labOrderToExport(order: LabOrder): LabOrderExport {
  return { format: "osod-lab-order", version: "0", order };
}

function rxEye(
  spec: VisionPrescriptionLensSpecification | undefined,
  fitting: Pick<LabOrderRxEye, "distPd" | "nearPd" | "segHeight"> | undefined,
): LabOrderRxEye {
  const prism = spec?.prism?.[0];
  return {
    ...(spec?.sphere !== undefined ? { sphere: spec.sphere } : {}),
    ...(spec?.cylinder !== undefined ? { cylinder: spec.cylinder } : {}),
    ...(spec?.axis !== undefined ? { axis: spec.axis } : {}),
    ...(spec?.add !== undefined ? { add: spec.add } : {}),
    ...(prism?.amount !== undefined ? { prism: prism.amount } : {}),
    ...(prism?.base !== undefined ? { base: prism.base } : {}),
    ...(fitting?.distPd !== undefined ? { distPd: fitting.distPd } : {}),
    ...(fitting?.nearPd !== undefined ? { nearPd: fitting.nearPd } : {}),
    ...(fitting?.segHeight !== undefined ? { segHeight: fitting.segHeight } : {}),
  };
}
