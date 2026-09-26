import assert from "node:assert/strict";
import { test } from "node:test";
import { XMLParser } from "fast-xml-parser";
import type { LabOrder } from "../src/fhir/opticalLabOrder.js";
import { labOrderToVwOrder } from "../src/integrations/visionweb/vwOrderSerializer.js";

import { order } from "./fixtures/visionweb/support.js";
const account = { supplierId: "9992", billAccount: "bill", shipAccount: "ship" };
const credentials = { username: "fake-user", password: "fake-password" };
export function serialize(input: LabOrder) { return labOrderToVwOrder(input, account, credentials); }
const expectedFields = [
  ["OrderId", "TEST-ORDER"], ["SupplierName", "9992"], ["BillAccount", "bill"], ["ShipAccount", "ship"], ["JobType", "Uncut"], ["Eyes", "B"], ["PatLastName", "ALEX"],
  ["RESph", "+1.125"], ["LESph", "+0.00"], ["RECyl", "-0.50"], ["REAxis", "80"],
  ["REDistPD", "30.0"], ["RENearPD", "29.0"], ["LEDistPD", "31.0"], ["REAdd", "+1.25"], ["RESegHeight", "20.0"],
  ["REHorizPrismValue", "1.50"], ["REHorizPrismDirection", "IN"], ["REVerticalPrismValue", "0.50"], ["REVerticalPrismDirection", "UP"],
  ["RELensDesign", "SV"], ["LELensDesign", "SV"], ["RELensMaterial", "TEST-MATERIAL"], ["LELensMaterial", "TEST-MATERIAL"],
  ["RETreatment1", "T1"], ["RETreatment2", "T2"], ["RETreatment3", "T3"], ["LETreatment1", "T1"], ["LETreatment2", "T2"], ["LETreatment3", "T3"],
  ["FrameType", "METAL"], ["ABox", "50.0"], ["BBox", "35.0"], ["Dbl", "21.0"], ["ED", "52.0"], ["Eye", "50.0"], ["FrameTempleLength", "135.0"],
  ["FrameManufacturer", "Test"], ["FrameModel", "Model"], ["FrameColor", "Black"], ["SpecialInstructions1", "Test / Only"], ["Username", "fake-user"], ["Password", "fake-password"],
];
test("V4 golden field order, exact precision and one-eye serialization", () => {
  assert.equal(serialize(order()), `<VWOrder>${expectedFields.map(([k,v]) => `<Item><FieldName>${k}</FieldName><FieldValue>${v}</FieldValue></Item>`).join("")}</VWOrder>`);
  const one = order(); one.rx.od = {};
  const xml = serialize(one);
  assert.match(xml, /<FieldName>Eyes<\/FieldName><FieldValue>L<\/FieldValue>/);
  assert.doesNotMatch(xml, /<FieldName>RE/);
});
test("V5 required fields are aggregated", () => {
  const input = order(); delete input.rx.od.distPd; delete input.rx.od.segHeight; delete input.frame!.a;
  assert.throws(() => serialize(input), e => e instanceof Error && ["REDistPD", "ABox", "RESegHeight"].every(f => e.message.includes(f)));
});
const invalid: Array<[string, (o: LabOrder) => void]> = [
  ["Treatments", o => o.lensSpec.treatments.push("T4")], ["REHorizPrismValue", o => o.rx.od.prisms!.push({amount:1,base:"out"})],
  ["SpecialInstructions1", o => o.lensSpec.specialInstructions = "x".repeat(61)], ["OrderId", o => o.header.orderId = "x".repeat(41)],
  ["ABox", o => o.frame!.a = "bad"], ["FrameManufacturer", o => o.frame!.brand = "x".repeat(21)],
  ["RESph", o => o.rx.od.sphere = 100], ["RESph", o => o.rx.od.sphere = 1.1255], ["REAxis", o => o.rx.od.axis = 181],
  ["REDistPD", o => o.rx.od.distPd = 30.25], ["REHorizPrismValue", o => o.rx.od.prisms![0].amount = 0.3],
  ["RESegHeight", o => o.rx.od.segHeight = 35], ["ED", o => o.frame!.ed = "49"], ["RECyl", o => o.rx.od.cylinder = NaN],
  ["RESph", o => delete o.rx.od.sphere], ["REAdd", o => o.rx.od.add = -1],
];
test("V6 invalid values throw without rounding or truncation, aggregated", () => {
  for (const [field, change] of invalid) { const o = order(); change(o); assert.throws(() => serialize(o), e => e instanceof Error && e.message.includes(field), field); }
  const o = order(); o.rx.od.sphere = 1.1255; o.rx.od.distPd = 30.25; o.frame!.ed = "49";
  assert.throws(() => serialize(o), e => e instanceof Error && ["RESph", "REDistPD", "ED"].every(f => e.message.includes(f)));
});
test("V7 XML escaping preserves the original text", () => {
  const o = order(); o.header.patientName = "O'Brien & <Smith>]]>";
  const xml = serialize(o); assert.doesNotMatch(xml, /\]\]>/);
  const fields = new XMLParser({ parseTagValue: false }).parse(xml).VWOrder.Item;
  assert.equal(fields.find((v: {FieldName:string})=>v.FieldName === "PatLastName").FieldValue, o.header.patientName);
});
