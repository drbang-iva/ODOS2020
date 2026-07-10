import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { StructureDefinition } from "@medplum/fhirtypes";

test("vision-benefit extensions are installable R4 item extensions with date and unsignedInt values", async () => {
  const cases = [
    ["osod-benefit-last-used.json", "https://osod.dev/fhir/StructureDefinition/osod-benefit-last-used", "date"],
    ["osod-benefit-frequency-months.json", "https://osod.dev/fhir/StructureDefinition/osod-benefit-frequency-months", "unsignedInt"],
  ] as const;
  for (const [file, url, type] of cases) {
    const definition = JSON.parse(await readFile(resolve(import.meta.dirname, "../../data/canonical-extensions", file), "utf8")) as StructureDefinition;
    assert.equal(definition.url, url);
    assert.equal(definition.fhirVersion, "4.0.1");
    assert.deepEqual(definition.context, [{ type: "element", expression: "CoverageEligibilityResponse.insurance.item" }]);
    const value = definition.differential?.element?.find((element) => element.id === "Extension.value[x]");
    assert.equal(value?.min, 1);
    assert.equal(value?.max, "1");
    assert.deepEqual(value?.type, [{ code: type }]);
  }
});
