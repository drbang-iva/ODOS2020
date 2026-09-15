import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, Bundle, RelatedPerson, Task } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import { handlePatientInsuranceWrite } from "../src/insurance/patient-insurance-handlers.js";
import { generatePatientStatementForOperator, parseStatementTask } from "../src/statements/statements.js";
import { guarantorReaderFixture, readerDate } from "./helpers/guarantor-reader-fixture.js";

test("L22: Coverage subscriber referencing either moved responsible party is still refused after transfer (non-mutation regression)", async () => {
  const f = guarantorReaderFixture();
  await f.transfer();
  const before = structuredClone([...f.records]);
  const priorWrites = f.writes.length;
  const denied: OdosAuditEventRecord[] = [];
  for (const [id, patientId] of [["r1", "sam"], ["r2", "leo"]]) {
    const bundle: Bundle = { resourceType: "Bundle", type: "transaction", entry: [{ resource: {
      resourceType: "Coverage", status: "active", beneficiary: { reference: `Patient/${patientId}` }, subscriber: { reference: `RelatedPerson/${id}` }, payor: [{ reference: "Organization/synthetic-payer" }],
    }, request: { method: "POST", url: "Coverage" } }] };
    const result = await handlePatientInsuranceWrite({ authenticate: async () => ({ ...f.staff, fhir: f.fhir }), recordAudit: async row => { denied.push(row); } }, { authHeader: "Bearer synthetic-reader", body: { bundle } });
    assert.deepEqual(result, { status: 422, body: { error: "This person is a responsible party. Save the subscriber as a separate record." } });
    assert.ok(f.reads.some(read => read.type === "RelatedPerson" && read.params._id === id && read.ids.includes(id)));
  }
  assert.equal(f.writes.length, priorWrites, "insurance refuses before any transaction");
  assert.deepEqual([...f.records], before);
  assert.deepEqual(denied.map(row => [row.patientId, row.actionOutcome]), [["sam", "denied"], ["leo", "denied"]]);
});

test("L7: actual statement recipient remains the moved primary RelatedPerson before and after transfer", async () => {
  const f = guarantorReaderFixture();
  const account = f.get<Account>("Account/sam-account");
  const original = ["r1", "r2"].map(id => f.get<RelatedPerson>(`RelatedPerson/${id}`));
  async function statement() {
    const run = await generatePatientStatementForOperator(f.fhir, { patientReference: "Patient/sam", generatedAt: readerDate });
    assert.equal(run.generatedCount, 1); assert.equal(run.invalidRejects, 0);
    const result = run.statements[0];
    const persisted = parseStatementTask(f.get<Task>(result.statementReference!));
    assert.deepEqual(persisted.detail?.header, result.detail?.header);
    return persisted.detail!.header;
  }
  const before = await statement();
  assert.equal(before.recipientName, "Source Guardian");
  assert.deepEqual(before.recipientAddress, { lines: ["1 Source Street"], cityStatePostal: "Synthetic Town" });
  await f.transfer();
  const after = await statement();
  assert.equal(after.recipientName, "Destination Guardian");
  assert.deepEqual(after.recipientAddress, { lines: ["2 Destination Street"], cityStatePostal: "Synthetic Town" });
  assert.deepEqual(f.get<Account>("Account/sam-account"), account, "recipient selection still follows the same Account party, with its current demographics");
  assert.ok(f.reads.some(read => read.type === "RelatedPerson" && read.ids.includes("r1") && read.ids.includes("secondary")), "the real resolver sees both competing Account candidates");
  for (const [index, id] of ["r1", "r2"].entries()) {
    const childWrites = f.writes.filter(write => write.lane === "operation" && write.resource.resourceType === "RelatedPerson" && write.resource.id === id);
    assert.equal(childWrites.length, 3, "claim, projection, and release are all observed");
    for (const write of childWrites) {
      const child = write.resource as RelatedPerson;
      for (const field of ["active", "patient", "period", "relationship"] as const) assert.deepEqual(child[field], original[index][field], `${id} preserves ${field}`);
      assert.deepEqual(child.extension?.filter(extension => extension.url !== "https://odos2020.com/fhir/StructureDefinition/guarantor-link-claim" && !extension.url.endsWith("/odos-no-textable-number")), original[index].extension?.filter(e => !e.url.endsWith("/odos-no-textable-number")), `${id} retains its own role and sentinel values`);
    }
  }
});
