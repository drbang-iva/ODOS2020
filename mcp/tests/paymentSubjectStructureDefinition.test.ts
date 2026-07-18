import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { StructureDefinition } from "@medplum/fhirtypes";

test("odos-payment-subject is an installable R4 extension constrained to Reference(Patient)", async () => {
  const definition = JSON.parse(await readFile(resolve(
    import.meta.dirname,
    "../../data/canonical-extensions/odos-payment-subject.json",
  ), "utf8")) as StructureDefinition;
  assert.equal(definition.url, "https://odos2020.com/fhir/StructureDefinition/odos-payment-subject");
  assert.equal(definition.fhirVersion, "4.0.1");
  assert.equal(definition.type, "Extension");
  assert.deepEqual(definition.context, [{ type: "element", expression: "PaymentReconciliation" }]);
  const value = definition.differential?.element?.find((element) => element.id === "Extension.value[x]");
  assert.equal(value?.min, 1);
  assert.equal(value?.max, "1");
  assert.deepEqual(value?.type, [{
    code: "Reference",
    targetProfile: ["http://hl7.org/fhir/StructureDefinition/Patient"],
  }]);
});
