import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent, Basic, Binary, Bundle, Provenance, Resource } from "@medplum/fhirtypes";

const BASIC_KIND_SYSTEM = "https://odos2020.com/fhir/CodeSystem/basic-kind";
const CATALOG_URL = "https://odos2020.com/catalog/frames/SKU-100";
const URLS = {
  canonical: "https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url",
  receivedAt: "https://odos2020.com/fhir/StructureDefinition/received-at",
  status: "https://odos2020.com/fhir/StructureDefinition/unit-status",
} as const;
const NOW = "2026-08-22T14:30:00.000Z";

interface HandlerResult {
  status: number;
  body: unknown;
}

type AdjustmentHandler = (
  deps: Record<string, unknown>,
  input: { authHeader?: string; unitId?: string; body: unknown },
) => Promise<HandlerResult>;

test("a reasoned correction persists an AuditEvent and Provenance recording who, when, and why", async () => {
  const handle = await adjustmentHandler();
  const fixture = setup(["admin"]);

  const result = await handle(fixture.deps, request({ status: "hold", reason: "Damaged during handling" }));

  assert.equal(result.status, 200);
  const audit = fixture.fhir.only<AuditEvent>("AuditEvent");
  assert.equal(audit.type.code, "practice.frame-inventory.adjusted");
  assert.equal(audit.recorded, NOW);
  assert.equal(audit.agent[0]?.who?.reference, "Practitioner/admin-1");
  assert.equal(audit.outcomeDesc, "Damaged during handling");
  assert.deepEqual(detailValues(audit), {
    "corrected-status": "hold",
    "prior-status": "on_hand",
    reason: "Damaged during handling",
  });
  const provenance = fixture.fhir.only<Provenance>("Provenance");
  assert.equal(provenance.recorded, NOW);
  assert.equal(provenance.agent[0]?.who.reference, "Practitioner/admin-1");
  assert.equal(provenance.reason?.[0]?.text, "Damaged during handling");
  assert.deepEqual(provenance.target, [{ reference: "Basic/unit-1" }]);
});

test("a correction without a reason is rejected before persistence", async () => {
  const handle = await adjustmentHandler();
  const fixture = setup(["admin"]);

  const result = await handle(fixture.deps, request({ status: "hold", reason: "   " }));

  assert.deepEqual(result, { status: 400, body: { error: "A correction reason is required." } });
  assert.equal(fixture.fhir.readCalls, 0);
  assert.equal(fixture.fhir.transactionCalls, 0);
  assert.equal(fixture.fhir.all("AuditEvent").length, 0);
});

test("the prior unit state remains recoverable after a correction", async () => {
  const handle = await adjustmentHandler();
  const fixture = setup(["admin"]);

  const result = await handle(fixture.deps, request({ status: "outbound", reason: "Vendor return not captured" }));

  assert.equal(result.status, 200);
  assert.equal(extensionValue(fixture.fhir.currentUnit(), URLS.status), "outbound");
  assert.deepEqual(
    fixture.fhir.unitHistory().map((version) => extensionValue(version, URLS.status)),
    ["on_hand", "outbound"],
  );
  assert.equal(detailValues(fixture.fhir.only<AuditEvent>("AuditEvent"))["prior-status"], "on_hand");
});

test("a caller lacking inventory.adjust is refused before FHIR work", async () => {
  const handle = await adjustmentHandler();
  const fixture = setup(["staff"]);

  const result = await handle(fixture.deps, request({ status: "hold", reason: "Miscount" }));

  assert.deepEqual(result, { status: 403, body: { error: "inventory.adjust role required" } });
  assert.equal(fixture.fhir.readCalls, 0);
  assert.equal(fixture.fhir.transactionCalls, 0);
});

test("a caller holding inventory.adjust can correct the unit", async () => {
  const handle = await adjustmentHandler();
  const fixture = setup(["staff", "admin"]);

  const result = await handle(fixture.deps, request({ status: "hold", reason: "Physical count correction" }));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    unit: {
      id: "unit-1",
      canonicalUrl: CATALOG_URL,
      status: "hold",
      receivedAt: "2026-07-25T12:00:00.000Z",
    },
  });
  assert.equal(fixture.fhir.transactionCalls, 1);
  assert.equal(extensionValue(fixture.fhir.currentUnit(), URLS.status), "hold");
});

test("required response metadata is validated before any correction is committed", async () => {
  const handle = await adjustmentHandler();
  const malformed = unitBasic("on_hand");
  malformed.extension = malformed.extension?.filter((entry) => entry.url !== URLS.canonical);
  const fixture = setup(["admin"], malformed);

  const result = await handle(fixture.deps, request({ status: "hold", reason: "Physical count correction" }));

  assert.deepEqual(result, { status: 400, body: { error: "Frame inventory unit is missing catalog URL." } });
  assert.equal(fixture.fhir.transactionCalls, 0);
  assert.equal(extensionValue(fixture.fhir.currentUnit(), URLS.status), "on_hand");
  assert.equal(fixture.fhir.all("AuditEvent").length, 0);
  assert.equal(fixture.fhir.all("Provenance").length, 0);
});

async function adjustmentHandler(): Promise<AdjustmentHandler> {
  const module = await import("../src/inventory/frame-inventory-adjustment.js")
    .catch(() => ({} as Record<string, unknown>));
  const candidate = module.handleFrameInventoryAdjustmentRequest;
  assert.equal(
    typeof candidate,
    "function",
    "frame inventory adjustment handler is not implemented",
  );
  return candidate as AdjustmentHandler;
}

function request(body: unknown) {
  return { authHeader: "Bearer good", unitId: "unit-1", body };
}

function setup(roles: Array<"provider" | "staff" | "admin">, inventoryUnit = unitBasic("on_hand")) {
  const fhir = new MemoryFhir(inventoryUnit);
  return {
    fhir,
    deps: {
      authenticate: async (header: string | undefined) => header === "Bearer good"
        ? {
            staffReference: "Practitioner/admin-1",
            actorRole: roles[0] ?? "staff",
            roles,
            fhir,
          }
        : null,
      serviceFhir: fhir,
      now: () => NOW,
    },
  };
}

class MemoryFhir {
  readCalls = 0;
  transactionCalls = 0;
  private readonly resources: Resource[] = [];
  private readonly history: Basic[];

  constructor(unit: Basic) {
    this.resources.push(structuredClone(unit));
    this.history = [structuredClone(unit)];
  }

  async read<T extends Resource>(resourceType: string, id: string): Promise<T> {
    this.readCalls += 1;
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return structuredClone(resource) as T;
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    this.transactionCalls += 1;
    for (const entry of bundle.entry ?? []) {
      if (entry.request?.method === "PATCH") {
        this.applyPatch(entry.resource as Binary, entry.request.ifMatch);
      } else if (entry.request?.method === "POST" && entry.resource) {
        const number = this.resources.filter((row) => row.resourceType === entry.resource?.resourceType).length + 1;
        this.resources.push({ ...structuredClone(entry.resource), id: `${entry.resource.resourceType.toLowerCase()}-${number}` });
      }
    }
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: (bundle.entry ?? []).map((entry) => ({
        response: {
          status: entry.request?.method === "PATCH" ? "200 OK" : "201 Created",
          location: entry.request?.url,
        },
      })),
    };
  }

  all(resourceType: Resource["resourceType"]): Resource[] {
    return this.resources.filter((row) => row.resourceType === resourceType).map((row) => structuredClone(row));
  }

  only<T extends Resource>(resourceType: T["resourceType"]): T {
    const rows = this.all(resourceType);
    assert.equal(rows.length, 1);
    return rows[0] as T;
  }

  currentUnit(): Basic {
    return this.only<Basic>("Basic");
  }

  unitHistory(): Basic[] {
    return this.history.map((row) => structuredClone(row));
  }

  private applyPatch(binary: Binary, ifMatch: string | undefined): void {
    const current = this.currentUnit();
    assert.equal(ifMatch, `W/\"${current.meta?.versionId}\"`);
    const operations = JSON.parse(Buffer.from(binary.data ?? "", "base64").toString("utf8")) as Array<{
      op: "test" | "replace";
      path: string;
      value: string;
    }>;
    const next = structuredClone(current);
    for (const operation of operations) {
      const match = operation.path.match(/^\/extension\/(\d+)\/(url|valueString)$/);
      assert.ok(match, `Unsupported patch path ${operation.path}`);
      const extension = next.extension?.[Number(match[1])];
      assert.ok(extension);
      const field = match[2] as "url" | "valueString";
      if (operation.op === "test") assert.equal(extension[field], operation.value);
      else extension[field] = operation.value;
    }
    next.meta = { ...next.meta, versionId: String(Number(current.meta?.versionId ?? "0") + 1) };
    const index = this.resources.findIndex((row) => row.resourceType === "Basic" && row.id === current.id);
    this.resources[index] = structuredClone(next);
    this.history.push(structuredClone(next));
  }
}

function unitBasic(status: string): Basic {
  return {
    resourceType: "Basic",
    id: "unit-1",
    meta: { versionId: "7" },
    code: { coding: [{ system: BASIC_KIND_SYSTEM, code: "practice-frame-inventory-unit" }] },
    extension: [
      { url: URLS.canonical, valueString: CATALOG_URL },
      { url: URLS.status, valueString: status },
      { url: URLS.receivedAt, valueDateTime: "2026-07-25T12:00:00.000Z" },
    ],
  };
}

function extensionValue(resource: Basic, url: string): string | undefined {
  const extension = resource.extension?.find((row) => row.url === url);
  return extension?.valueString ?? extension?.valueDateTime;
}

function detailValues(audit: AuditEvent): Record<string, string> {
  return Object.fromEntries(
    (audit.entity?.[0]?.detail ?? []).map((detail) => [detail.type, detail.valueString ?? ""]),
  );
}
