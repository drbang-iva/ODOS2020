import {
  type LabOrder,
  type LabOrderRxEye,
} from "../../fhir/opticalLabOrder.js";

export interface OcucoHashrefContract {
  labNumReceiver: string;
  custNumReceiver: string;
}

const FRAME_MOUNTINGS = new Set(["STANDARD", "METAL", "RIMLESS", "HALFEYE", "DRILLED", "FACET"]);

export function labOrderToHashref(
  order: LabOrder,
  contract: OcucoHashrefContract,
): string {
  const lines = [
    "file_version:2.5",
    "start_order",
    field("agent_name", "odos"),
    field("agent_version", "0.1.0"),
    field("lab_num", required(contract.labNumReceiver, "labNumReceiver")),
    field("order_id", required(order.header.orderId, "order.header.orderId")),
    field("cust_num", required(contract.custNumReceiver, "custNumReceiver")),
    field("patient_name", required(order.header.patientName, "order.header.patientName")),
    field("customer_po_num", order.header.orderId),
    ...(order.header.trayNumber ? [field("customer_tray_num", order.header.trayNumber)] : []),
    field("date_ordered", hashrefDate(order.header.orderDate)),
    ...(order.header.providerName ? [field("x_dr_name", order.header.providerName)] : []),
    field("frame_status", frameStatus(order)),
    field("frame_tracing", "NO TRACE"),
    ...(order.frame?.eye ? [field("frame_eye", order.frame.eye)] : []),
    ...(order.frame?.bridge ? [field("frame_bridge", order.frame.bridge)] : []),
    ...(order.frame?.temple ? [field("frame_temple", order.frame.temple)] : []),
    ...(order.frame?.a ? [field("frame_a", order.frame.a)] : []),
    ...(order.frame?.b ? [field("frame_b", order.frame.b)] : []),
    ...(order.frame?.ed ? [field("frame_ed", order.frame.ed)] : []),
    ...(order.frame?.dbl ? [field("frame_dbl", order.frame.dbl)] : []),
    ...(order.frame?.brand ? [field("frame_vendor", order.frame.brand)] : []),
    ...(order.frame?.model ? [field("frame_model", order.frame.model)] : []),
    ...(order.frame?.color ? [field("frame_color", order.frame.color)] : []),
    field("frame_mounting", frameMounting(order.frame?.frameType)),
    field("frame_edge", /uncut/i.test(order.lensSpec.jobType) ? "UNCUT" : "EDGED"),
    field("rx_eye", rxEyeSelection(order)),
    ...lensFields("od", order),
    ...lensFields("os", order),
    ...rxFields("od", order.rx.od),
    ...rxFields("os", order.rx.os),
    ...(order.rx.od.segHeight !== undefined || order.rx.os.segHeight !== undefined
      ? [field("x_rx_seg_height_qual", "1")]
      : []),
    ...miscItemFields(order.lensSpec.treatments),
    field("instructions", order.lensSpec.commentsToLab ?? ""),
    "end_order",
  ];

  // TODO OCUCO-TRACE: frameTraceRef is only an identifier. Omit trace_file/trace_value
  // until ODOS captures the actual OMA trace bytes required by Gatekeeper.
  return lines.join("\r\n");
}

export function labOrderCancellationToHashref(
  order: LabOrder,
  contract: OcucoHashrefContract,
  originalOrderId: string,
): string {
  const orderId = required(originalOrderId, "original order_id");
  const serialized = labOrderToHashref({
    ...order,
    header: { ...order.header, orderId },
  }, contract);
  const lines = serialized.split("\r\n");
  const orderIdIndex = lines.findIndex((line) => line.startsWith("order_id:"));
  lines.splice(orderIdIndex + 1, 0, "cancel:1");
  return lines.join("\r\n");
}

function lensFields(eye: "od" | "os", order: LabOrder): string[] {
  if (!hasRx(order.rx[eye])) return [];
  const prefix = `x_lens_${eye}`;
  return [
    field(`${prefix}_style_desc`, order.lensSpec.lensDesign),
    field(`${prefix}_material_desc`, order.lensSpec.lensMaterial),
    ...(order.lensSpec.treatments.length
      ? [field(`${prefix}_color_desc`, order.lensSpec.treatments.join(", "))]
      : []),
  ];
}

function rxFields(eye: "od" | "os", rx: LabOrderRxEye): string[] {
  if (!hasRx(rx)) return [];
  const prefix = `rx_${eye}`;
  const firstPrism = rx.prisms?.[0];
  const secondPrism = rx.prisms?.[1];
  return [
    ...(rx.sphere !== undefined ? [field(`${prefix}_sphere`, signed(rx.sphere))] : []),
    ...(rx.cylinder !== undefined ? [field(`${prefix}_cylinder`, signed(rx.cylinder))] : []),
    ...(rx.axis !== undefined ? [field(`${prefix}_axis`, String(rx.axis))] : []),
    ...(rx.add !== undefined ? [field(`${prefix}_add`, signed(rx.add))] : []),
    ...(rx.distPd !== undefined ? [field(`${prefix}_far`, decimal(rx.distPd))] : []),
    ...(rx.nearPd !== undefined ? [field(`${prefix}_near`, decimal(rx.nearPd))] : []),
    ...(rx.segHeight !== undefined ? [field(`${prefix}_seg_height`, decimal(rx.segHeight))] : []),
    field(`${prefix}_prism`, decimal(firstPrism?.amount ?? 0)),
    field(`${prefix}_prism_dir`, firstPrism ? firstPrism.base.toUpperCase() : "IN"),
    field(`${prefix}_prism2`, decimal(secondPrism?.amount ?? 0)),
    field(`${prefix}_prism2_dir`, secondPrism ? secondPrism.base.toUpperCase() : "UP"),
  ];
}

function miscItemFields(treatments: string[]): string[] {
  return treatments.flatMap((treatment) => [
    "item_start",
    field("sku", treatment),
    field("item_source", "MISC"),
    field("item_description", treatment),
    field("item_quantity", "1"),
    field("item_side", "NONE"),
    field("item_part_rx", "Y"),
    "item_end",
  ]);
}

function frameStatus(order: LabOrder): string {
  switch (order.frameSource) {
    case 0: return "LENSES ONLY";
    case 1: return "SUPPLIED";
    case 3: return "TO COME";
    case 4: return "ENCLOSED";
  }
}

function frameMounting(frameType: string | undefined): string {
  const normalized = frameType?.trim().toUpperCase().replace(/[ -]/g, "") ?? "STANDARD";
  if (normalized === "HALFEYE") return "HALFEYE";
  return FRAME_MOUNTINGS.has(normalized) ? normalized : "STANDARD";
}

function rxEyeSelection(order: LabOrder): string {
  const od = hasRx(order.rx.od);
  const os = hasRx(order.rx.os);
  if (od && os) return "3";
  if (od) return "1";
  if (os) return "2";
  throw new Error("Ocuco Hashref requires at least one eye's prescription.");
}

function hasRx(rx: LabOrderRxEye): boolean {
  return [rx.sphere, rx.cylinder, rx.axis, rx.add, rx.distPd, rx.nearPd, rx.segHeight]
    .some((value) => value !== undefined)
    || (rx.prisms?.length ?? 0) > 0;
}

function hashrefDate(value: string): string {
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}-12-00-00`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Ocuco Hashref orderDate must be a valid date.");
  return parsed.toISOString().replace(/T/, "-").replace(/:/g, "-").slice(0, 19);
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function decimal(value: number): string {
  return value.toFixed(2);
}

function field(name: string, value: string | number): string {
  return `${name}:${String(value).replace(/[\r\n]+/g, " ").trim()}`;
}

function required(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`Ocuco Hashref requires ${name}.`);
  return value;
}
