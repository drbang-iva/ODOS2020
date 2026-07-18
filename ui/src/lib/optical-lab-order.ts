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
  prisms?: Array<{ amount: number; base: "up" | "down" | "in" | "out" }>;
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

export const LAB_ORDER_FRAME_SOURCES = [0, 1, 3, 4] as const;
export type LabOrderFrameSource = (typeof LAB_ORDER_FRAME_SOURCES)[number];
export type LabOrderFrameOwnership = "in-house" | "patients-own";

export const LAB_ORDER_FRAME_SOURCE_LABELS: Record<LabOrderFrameSource, string> = {
  0: "Lenses Only",
  1: "Lab supply",
  3: "Frame-to-come",
  4: "Frame enclosed",
};

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
  frameSource: LabOrderFrameSource;
  frameOwnership?: LabOrderFrameOwnership;
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
  frameSource: LabOrderFrameSource;
  frameOwnership?: LabOrderFrameOwnership;
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
  assertLabOrderFrameSource(input.frameSource, input.frameOwnership);

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
    frameSource: input.frameSource,
    ...(input.frameOwnership ? { frameOwnership: input.frameOwnership } : {}),
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
  format: "odos-lab-order";
  version: "0";
  order: LabOrder;
}

export function labOrderToExport(order: LabOrder): LabOrderExport {
  assertLabOrderFrameSource(order.frameSource, order.frameOwnership);
  return { format: "odos-lab-order", version: "0", order };
}

export function assertLabOrderFrameSource(
  frameSource: number,
  frameOwnership: string | undefined,
): asserts frameSource is LabOrderFrameSource {
  if (!(LAB_ORDER_FRAME_SOURCES as readonly number[]).includes(frameSource)) {
    throw new Error("Lab order FSRC must be one of 0, 1, 3, or 4.");
  }
  if (frameSource === 3 || frameSource === 4) {
    if (frameOwnership !== "in-house" && frameOwnership !== "patients-own") {
      throw new Error(`Lab order frameOwnership is required when FSRC is ${frameSource}.`);
    }
    return;
  }
  if (frameOwnership !== undefined) {
    throw new Error(`Lab order frameOwnership must be absent when FSRC is ${frameSource}.`);
  }
}

const DASH = "—";

function cell(value: string | number | undefined): string {
  return value === undefined || value === "" ? DASH : escapeHtml(String(value));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function rxRow(label: string, eye: LabOrderRxEye): string {
  const prism = eye.prisms?.map((entry) => `${entry.amount} ${entry.base}`).join(" / ");
  return `<tr><th>${label}</th><td>${cell(eye.sphere)}</td><td>${cell(eye.cylinder)}</td><td>${cell(eye.axis)}</td><td>${cell(eye.add)}</td><td>${cell(prism)}</td><td>${cell(eye.distPd)}</td><td>${cell(eye.nearPd)}</td><td>${cell(eye.segHeight)}</td></tr>`;
}

/**
 * Render a LabOrder as a self-contained, printable HTML lab sheet — the T0 baseline transport
 * (spec §5.1). Zero dependency; browser print-to-PDF covers "print". Every field renders or shows an
 * em-dash — never blank/undefined (gate §4.3). Mirrors the Foxfire "Print Rx / Lab Details" layout.
 */
export function renderLabOrderSheet(order: LabOrder): string {
  const h = order.header;
  const l = order.lensSpec;
  const f = order.frame;
  const treatments = l.treatments.length ? l.treatments.map(escapeHtml).join(", ") : DASH;

  return `<section class="odos-lab-sheet">
<style>
  .odos-lab-sheet { font-family: system-ui, sans-serif; color: #111; max-width: 8.5in; }
  .odos-lab-sheet h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  .odos-lab-sheet h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1px solid #ccc; margin: 1rem 0 .4rem; padding-bottom: .15rem; }
  .odos-lab-sheet table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  .odos-lab-sheet th, .odos-lab-sheet td { border: 1px solid #ddd; padding: .25rem .4rem; text-align: left; }
  .odos-lab-sheet .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: .25rem .75rem; font-size: .85rem; }
  .odos-lab-sheet .kv div { padding: .1rem 0; }
  .odos-lab-sheet .kv b { color: #555; font-weight: 600; }
  @media print { .odos-lab-sheet { max-width: none; } }
</style>
<h1>Lab Order — ${cell(h.orderId)}</h1>
<div class="kv">
  <div><b>Lab:</b> ${cell(h.lab)}</div>
  <div><b>Order Date:</b> ${cell(h.orderDate)}</div>
  <div><b>Ship To:</b> ${cell(h.shipTo)}</div>
  <div><b>Patient:</b> ${cell(h.patientName)}</div>
  <div><b>Provider:</b> ${cell(h.providerName)}</div>
  <div><b>Tray #:</b> ${cell(h.trayNumber)}</div>
</div>
<h2>Prescription</h2>
<table>
  <thead><tr><th>Eye</th><th>Sphere</th><th>Cyl</th><th>Axis</th><th>Add</th><th>Prism</th><th>Dist PD</th><th>Near PD</th><th>Seg Ht</th></tr></thead>
  <tbody>
    ${rxRow("OD", order.rx.od)}
    ${rxRow("OS", order.rx.os)}
  </tbody>
</table>
${order.rx.lensCpt ? `<div class="kv"><div><b>Lens CPT:</b> ${cell(order.rx.lensCpt)}</div></div>` : ""}
<h2>Lens Specification</h2>
<div class="kv">
  <div><b>Job Type:</b> ${cell(l.jobType)}</div>
  <div><b>Design:</b> ${cell(l.lensDesign)}</div>
  <div><b>Material:</b> ${cell(l.lensMaterial)}</div>
  <div style="grid-column: 1 / -1"><b>Treatments:</b> ${treatments}</div>
  <div style="grid-column: 1 / -1"><b>Special Instructions:</b> ${cell(l.specialInstructions)}</div>
  <div style="grid-column: 1 / -1"><b>Comments to Lab:</b> ${cell(l.commentsToLab)}</div>
</div>
<h2>Frame</h2>
<div class="kv">
  <div><b>FSRC:</b> ${cell(`${order.frameSource} — ${LAB_ORDER_FRAME_SOURCE_LABELS[order.frameSource]}`)}</div>
  <div><b>Ownership:</b> ${cell(order.frameOwnership)}</div>
  <div><b>Source:</b> ${cell(f?.source)}</div>
  <div><b>Brand:</b> ${cell(f?.brand)}</div>
  <div><b>Model:</b> ${cell(f?.model)}</div>
  <div><b>Color:</b> ${cell(f?.color)}</div>
  <div><b>Type:</b> ${cell(f?.frameType)}</div>
  <div><b>Eye/Bridge:</b> ${cell(f?.eye)} / ${cell(f?.bridge)}</div>
  <div><b>A / B / ED:</b> ${cell(f?.a)} / ${cell(f?.b)} / ${cell(f?.ed)}</div>
  <div><b>DBL / Temple:</b> ${cell(f?.dbl)} / ${cell(f?.temple)}</div>
  <div><b>Trace:</b> ${cell(order.frameTraceRef)}</div>
</div>
</section>`;
}

function rxEye(
  spec: VisionPrescriptionLensSpecification | undefined,
  fitting: Pick<LabOrderRxEye, "distPd" | "nearPd" | "segHeight"> | undefined,
): LabOrderRxEye {
  return {
    ...(spec?.sphere !== undefined ? { sphere: spec.sphere } : {}),
    ...(spec?.cylinder !== undefined ? { cylinder: spec.cylinder } : {}),
    ...(spec?.axis !== undefined ? { axis: spec.axis } : {}),
    ...(spec?.add !== undefined ? { add: spec.add } : {}),
    ...(spec?.prism?.length ? { prisms: spec.prism.map(({ amount, base }) => ({ amount, base })) } : {}),
    ...(fitting?.distPd !== undefined ? { distPd: fitting.distPd } : {}),
    ...(fitting?.nearPd !== undefined ? { nearPd: fitting.nearPd } : {}),
    ...(fitting?.segHeight !== undefined ? { segHeight: fitting.segHeight } : {}),
  };
}
