import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ConceptMap,
  Device,
  DeviceDefinition,
  Patient,
  Provenance,
  Substance,
} from "@medplum/fhirtypes";
import {
  connectMcpServer,
  createAuthenticatedFhirClient,
  loadRepoEnv,
  parseToolOutput,
} from "./integration-helpers.js";

interface ToolOutput {
  provenance: Provenance;
}

type CreateSubstanceOutput = ToolOutput & { substance: Substance };
type CreateDeviceDefinitionOutput = ToolOutput & { deviceDefinition: DeviceDefinition };
type CreateConceptMapOutput = ToolOutput & { conceptMap: ConceptMap };
type CreateLensDeviceOutput = ToolOutput & { device: Device };

test("v0.4 foundation MCP write tools create FHIR resources with mandatory Provenance", { timeout: 180_000 }, async (t) => {
  loadRepoEnv();

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const email = process.env.MEDPLUM_ADMIN_EMAIL;
  const password = process.env.MEDPLUM_ADMIN_PASSWORD;

  if (!email || !password) {
    t.skip("MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for Medplum integration tests.");
    return;
  }

  const { fhir, accessToken } = await createAuthenticatedFhirClient({ baseUrl, email, password });
  const patient = await fhir.create<Patient>({
    resourceType: "Patient",
    active: true,
    name: [{ family: `V04Lens${Date.now()}`, given: ["Test"] }],
  });
  assert.ok(patient.id);

  const mcp = await connectMcpServer({
    baseUrl,
    email,
    password,
    accessToken,
    clientName: "osod-mcp-v04-write-tools-test",
  });
  t.after(async () => {
    await mcp.client.close();
  });

  let deviceDefinition: DeviceDefinition;
  let lensDevice: Device;

  await t.test("create_substance writes Substance and Provenance", async () => {
    const output = parseToolOutput<CreateSubstanceOutput>(
      await mcp.client.callTool({
        name: "create_substance",
        arguments: {
          code: `test-coating-${Date.now()}`,
          display: "Test coating",
          kind: "coating",
        },
      }),
    );

    assert.equal(output.substance.resourceType, "Substance");
    assertProvenance(output.provenance, `Substance/${output.substance.id}`);
  });

  await t.test("create_device_definition writes DeviceDefinition and Provenance", async () => {
    const output = parseToolOutput<CreateDeviceDefinitionOutput>(
      await mcp.client.callTool({
        name: "create_device_definition",
        arguments: {
          catalog_code: `test-soft-${Date.now()}`,
          display_name: "Test stock soft lens",
          lens_type: "stock-soft",
          manufacturer: "OSOD Test",
          properties: [
            { code: "base-curve-mm", value_number: 8.6, unit_code: "mm" },
            { code: "diameter-mm", value_number: 14.2, unit_code: "mm" },
          ],
        },
      }),
    );

    deviceDefinition = output.deviceDefinition;
    assert.equal(output.deviceDefinition.resourceType, "DeviceDefinition");
    assertProvenance(output.provenance, `DeviceDefinition/${output.deviceDefinition.id}`);
  });

  await t.test("create_concept_map writes ConceptMap and Provenance", async () => {
    const output = parseToolOutput<CreateConceptMapOutput>(
      await mcp.client.callTool({
        name: "create_concept_map",
        arguments: {
          lab_code: `testlab-${Date.now()}`,
          lab_display: "Test Lab",
          target_uri: "urn:osod:testlab:parameter",
          mappings: [
            {
              source_code: "diameter-mm",
              target_code: "DIA",
              target_display: "Diameter",
            },
          ],
        },
      }),
    );

    assert.equal(output.conceptMap.resourceType, "ConceptMap");
    assert.equal(output.conceptMap.group?.[0]?.element?.[0]?.target?.[0]?.code, "DIA");
    assertProvenance(output.provenance, `ConceptMap/${output.conceptMap.id}`);
  });

  await t.test("create_lens_device writes patient-specific Device and Provenance", async () => {
    const output = parseToolOutput<CreateLensDeviceOutput>(
      await mcp.client.callTool({
        name: "create_lens_device",
        arguments: {
          lens_type: "stock-soft",
          patient_id: patient.id,
          definition_id: deviceDefinition.id,
          device_name: "OD stock soft trial",
          properties: [
            { code: "base-curve-mm", value_number: 8.6, unit_code: "mm" },
            { code: "diameter-mm", value_number: 14.2, unit_code: "mm" },
          ],
        },
      }),
    );

    lensDevice = output.device;
    assert.equal(output.device.resourceType, "Device");
    assert.equal(output.device.patient?.reference, `Patient/${patient.id}`);
    assert.equal(output.device.definition?.reference, `DeviceDefinition/${deviceDefinition.id}`);
    assertProvenance(output.provenance, `Device/${output.device.id}`);
  });

  await t.test("update_lens_device_properties uses version-aware PATCH and Provenance", async () => {
    const output = parseToolOutput<CreateLensDeviceOutput>(
      await mcp.client.callTool({
        name: "update_lens_device_properties",
        arguments: {
          lens_device_id: lensDevice.id,
          properties: [{ code: "diameter-mm", value_number: 14.0, unit_code: "mm" }],
        },
      }),
    );

    assert.equal(
      output.device.property?.find((property) => property.type.coding?.[0]?.code === "diameter-mm")
        ?.valueQuantity?.[0]?.value,
      14.0,
    );
    assertProvenance(output.provenance, `Device/${output.device.id}`);
  });
});

function assertProvenance(provenance: Provenance | undefined, targetReference: string): void {
  assert.ok(provenance, `Expected Provenance for ${targetReference}.`);
  assert.ok(
    provenance.target.some((target) => target.reference === targetReference),
    `Expected Provenance target ${targetReference}.`,
  );
}
