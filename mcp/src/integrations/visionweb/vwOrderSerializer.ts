import type { LabOrder, LabOrderRxEye } from "../../fhir/opticalLabOrder.js";
import type { VisionWebLabAccount } from "./config.js";

export const VISIONWEB_JOB_TYPES = { 0: "Uncut", 1: "Lab Supplied", 3: "Frame To Come", 4: "Frame To Come" } as const;
export function escapeVisionWebXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function multiple(value: number, increment: number): boolean {
  return Math.abs(value / increment - Math.round(value / increment)) < 1e-8;
}
export function labOrderToVwOrder(order: LabOrder, account: VisionWebLabAccount, credentials: { username: string; password: string }): string {
  const fields: Array<[string, string]> = [];
  const errors = new Set<string>();
  function text(name: string, value: string | undefined, required = false, limit = Infinity) {
    if (value === undefined || !value.trim()) { if (required) errors.add(name); return; }
    if (value.length > limit) errors.add(name);
    fields.push([name, value]);
  }
  function number(name: string, value: number | undefined, required: boolean, min: number, max: number, step?: number, precision = 1, signed = false) {
    if (value === undefined) { if (required) errors.add(name); return; }
    if (!Number.isFinite(value) || value < min || value > max || (step !== undefined && !multiple(value, step))) { errors.add(name); return; }
    let digits = precision;
    if (signed) {
      if (multiple(value, 0.01)) digits = 2;
      else if (multiple(value, 0.125)) digits = 3;
      else { errors.add(name); return; }
    }
    fields.push([name, `${signed && value >= 0 ? "+" : ""}${value.toFixed(digits)}`]);
  }
  const eyes: Array<[string, LabOrderRxEye]> = [["RE", order.rx.od], ["LE", order.rx.os]];
  const ordered = eyes.filter(([, eye]) => eye.sphere !== undefined);
  for (const [prefix, eye] of eyes) {
    if (eye.sphere === undefined && Object.values(eye).some(v => v !== undefined && (!Array.isArray(v) || v.length > 0))) errors.add(`${prefix}Sph`);
  }
  if (!ordered.length) errors.add("Eyes");
  const frame = order.frame;
  const frameNumber = (value: string | undefined): number | undefined => value === undefined || !value.trim() ? undefined : /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
  text("OrderId", order.header.orderId, true, 40);
  text("SupplierName", account.supplierId, true);
  if (!/^\d{4}$/.test(account.supplierId)) errors.add("SupplierName");
  text("BillAccount", account.billAccount, true); text("ShipAccount", account.shipAccount, true);
  text("JobType", VISIONWEB_JOB_TYPES[order.frameSource], true);
  text("Eyes", ordered.length === 2 ? "B" : ordered[0]?.[0] === "RE" ? "R" : "L", true);
  text("PatLastName", order.header.patientName, true);
  for (const [p,e] of ordered) number(`${p}Sph`, e.sphere, true, -99.75, 99.75, undefined, 2, true);
  for (const [p,e] of ordered) {
    if (e.cylinder !== undefined && e.cylinder !== 0) number(`${p}Cyl`, e.cylinder, false, -Infinity, Infinity, undefined, 2, true);
    number(`${p}Axis`, e.axis, e.cylinder !== undefined && e.cylinder !== 0, 0, 180, 1, 0);
  }
  for (const [p,e] of ordered) {
    number(`${p}DistPD`, e.distPd, true, 10, 40, 0.5);
    number(`${p}NearPD`, e.nearPd, false, 10, 40, 0.5);
  }
  for (const [p,e] of ordered) {
    if (e.add !== undefined && e.add !== 0) number(`${p}Add`, e.add, false, 0, 99.75, undefined, 2, true);
    number(`${p}SegHeight`, e.segHeight, (e.add ?? 0) > 0, 0, 40, 0.5);
    if (e.segHeight !== undefined && e.segHeight >= (frameNumber(frame?.b) ?? NaN)) errors.add(`${p}SegHeight`);
  }
  for (const [p,e] of ordered) {
    const seen = new Set<string>();
    for (const prism of e.prisms ?? []) {
      const direction = prism.base;
      const axis = direction === "in" || direction === "out" ? "Horiz" : "Vertical";
      const field = `${p}${axis}PrismValue`;
      if (seen.has(axis)) errors.add(field);
      seen.add(axis);
      number(field, prism.amount, true, 0.25, 10, 0.25, 2);
      if (!["up", "down", "in", "out"].includes(direction)) errors.add(`${p}${axis}PrismDirection`);
      text(`${p}${axis}PrismDirection`, direction.toUpperCase(), true);
    }
  }
  for (const [p] of ordered) text(`${p}LensDesign`, order.lensSpec.lensDesign, true);
  for (const [p] of ordered) text(`${p}LensMaterial`, order.lensSpec.lensMaterial, true);
  if (order.lensSpec.treatments.length > 3) errors.add("Treatments");
  for (const [p] of ordered) order.lensSpec.treatments.forEach((v,i) => text(`${p}Treatment${i+1}`, v, true));
  text("FrameType", frame?.frameType, true);
  for (const [name,key] of [["ABox","a"],["BBox","b"],["Dbl","dbl"],["ED","ed"],["Eye","eye"],["FrameTempleLength","temple"]] as const) {
    number(name, frameNumber(frame?.[key]), !["eye","temple"].includes(key), -Infinity, Infinity, 0.1);
  }
  if ((frameNumber(frame?.ed) ?? NaN) < (frameNumber(frame?.a) ?? NaN)) errors.add("ED");
  text("FrameManufacturer", frame?.brand, false, 20); text("FrameModel", frame?.model, false, 60); text("FrameColor", frame?.color);
  text("SpecialInstructions1", [order.lensSpec.specialInstructions, order.lensSpec.commentsToLab].filter(v => v?.trim()).join(" / "), false, 60);
  text("Username", credentials.username, true); text("Password", credentials.password, true);
  if (errors.size) throw new Error(`VisionWeb invalid or missing fields: ${[...errors].join(", ")}.`);
  return `<VWOrder>${fields.map(([name,value]) => `<Item><FieldName>${name}</FieldName><FieldValue>${escapeVisionWebXml(value)}</FieldValue></Item>`).join("")}</VWOrder>`;
}
