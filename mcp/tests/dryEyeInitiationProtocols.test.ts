import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  CarePlan,
  Condition,
  PlanDefinition,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import {
  handleProtocolApplyRequest,
  handleProtocolUnapplyRequest,
} from "../src/clinical-graph/protocol-endpoint.js";
import {
  DRY_EYE_AT_HOME_REGIMEN_INIT_PROTOCOL,
  DRY_EYE_IPL_INIT_PROTOCOL,
  DRY_EYE_LLLT_INIT_PROTOCOL,
  DRY_EYE_RF_INIT_PROTOCOL,
} from "../src/clinical-graph/protocol-fixtures.js";
import { PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
import {
  buildSeriesActivityDefinition,
  buildSeriesPlanDefinition,
  type SeriesProtocolDefinitionDraft,
} from "../src/series-tracker/protocol-definition-store.js";
import { registerSeriesTrackerRoutes } from "../src/series-tracker/series-tracker-endpoint.js";
import { DRY_EYE_SERIES_PROTOCOL_DRAFTS } from "../../scripts/seed-dry-eye-treatment.js";

const NOW = "2026-07-26T18:00:00.000Z";
const PATIENT_ID = "synthetic-dry-eye";
const ENCOUNTER_ID = "encounter-dry-eye";
const CONDITION_ID = "condition-kcs";
const AUTHORIZATION = "Bearer synthetic";

test("selected IPL initiation creates a real series CarePlan returned by the tracker endpoint", async () => {
  const fhir = dryEyeFhir();
  assert.deepEqual(
    DRY_EYE_IPL_INIT_PROTOCOL.items.find((item) => item.itemKey === "series-ipl"),
    {
      itemKey: "series-ipl",
      itemType: "series-prescription",
      defaultSelected: true,
      lateralityMode: "OU-always",
      payload: {
        seriesProtocolId: "dry-eye-ipl",
        chargeSeedRef: "charge-ipl-package",
      },
    },
  );

  const result = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id);

  assert.equal(result.status, 200);
  const series = await trackerSeries(fhir);
  assert.equal(series.length, 1);
  assert.equal(series[0]?.title, "IPL");
  assert.equal(series[0]?.sessions.length, 4);
  const carePlan = fhir.resourcesOf("CarePlan")[0];
  assert.equal(carePlan?.instantiatesCanonical?.some((canonical) =>
    canonical.includes("/PlanDefinition/series-protocol-dry-eye-ipl")
  ), true);
  assert.deepEqual(carePlan?.activity?.[1]?.detail?.scheduledTiming?.repeat, {
    frequency: 1,
    period: 21,
    periodMax: 28,
    periodUnit: "d",
  });
});

test("series prescriptions reject client payloads that differ from the canonical protocol item", async () => {
  for (const payload of [
    {
      seriesProtocolId: "dry-eye-lllt",
      chargeSeedRef: "charge-ipl-package",
    },
    {
      seriesProtocolId: "dry-eye-ipl",
      chargeSeedRef: "charge-lllt-package",
    },
  ]) {
    const fhir = dryEyeFhir();

    const result = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id, {
      selections: [{
        itemKey: "series-ipl",
        selected: true,
        payload,
      }],
    });

    assert.equal(result.status, 400);
    assert.match(String((result.body as { error: string }).error), /canonical protocol payload/i);
    assert.equal(fhir.resourcesOf("CarePlan").length, 0);
    assert.equal(fhir.protocolBasics(PROTOCOL_BASIC_CODES.protocolApplication).length, 0);
    assert.equal(fhir.protocolBasics(PROTOCOL_BASIC_CODES.chargeProposal).length, 0);
  }
});

test("missing service FHIR returns a structured server error before encounter writes", async () => {
  const fhir = dryEyeFhir();

  const result = await handleProtocolApplyRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/synthetic-clinician",
      actorRole: "clinician",
      fhir: fhir as never,
    }),
    now: () => NOW,
  }, {
    authHeader: AUTHORIZATION,
    body: {
      protocolId: DRY_EYE_IPL_INIT_PROTOCOL.id,
      encounterId: ENCOUNTER_ID,
      patientId: PATIENT_ID,
      diagnosis: {
        reference: `Condition/${CONDITION_ID}`,
        code: "H16.223",
        confirmed: true,
      },
    },
  });

  assert.deepEqual(result, {
    status: 500,
    body: { error: "Protocol series prescriptions require the service FHIR client." },
  });
  assert.equal(fhir.protocolBasics(PROTOCOL_BASIC_CODES.protocolApplication).length, 0);
});

test("deselecting a series prescription records opted-out and creates no series CarePlan", async () => {
  const fhir = dryEyeFhir();

  const result = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id, {
    selections: [
      { itemKey: "series-ipl", selected: false },
      { itemKey: "charge-ipl-package", selected: false },
    ],
  });

  assert.equal(result.status, 200);
  const body = result.body as {
    application: { dispositions: Array<{ itemKey: string; outcome: string }> };
  };
  assert.deepEqual(
    body.application.dispositions.find((disposition) => disposition.itemKey === "series-ipl"),
    { itemKey: "series-ipl", outcome: "opted-out" },
  );
  assert.equal(fhir.resourcesOf("CarePlan").length, 0);
  assert.equal((await trackerSeries(fhir)).length, 0);
});

test("missing and archived series protocols fail pre-flight with zero encounter artifacts", async () => {
  for (const mode of ["missing", "archived"] as const) {
    const fhir = dryEyeFhir(
      mode === "archived" ? ["dry-eye-ipl"] : [],
      mode === "missing" ? ["dry-eye-ipl"] : [],
    );
    const result = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id);

    assert.equal(result.status, 400, mode);
    assert.match(String((result.body as { error: string }).error), /no active series protocol definition/i);
    assert.equal(fhir.resourcesOf("CarePlan").length, 0, mode);
    assert.equal(fhir.protocolBasics(PROTOCOL_BASIC_CODES.protocolApplication).length, 0, mode);
    assert.equal(fhir.protocolBasics(PROTOCOL_BASIC_CODES.findingInstance).length, 0, mode);
    assert.equal(fhir.protocolBasics(PROTOCOL_BASIC_CODES.chargeProposal).length, 0, mode);
  }
});

test("retry after a mid-commit action-write failure conditionally reuses the CarePlan", async () => {
  const fhir = dryEyeFhir();
  fhir.rejectNextPlanActionWrite = true;

  await assert.rejects(
    applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id),
    /Simulated archived-write adapter rejection/,
  );
  assert.equal(fhir.resourcesOf("CarePlan").length, 1);

  const retried = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id);

  assert.equal(retried.status, 200);
  assert.equal(fhir.resourcesOf("CarePlan").length, 1);
  assert.equal((await trackerSeries(fhir)).length, 1);
});

test("un-apply revokes the series CarePlan and removes it from the tracker view", async () => {
  const fhir = dryEyeFhir();
  const applied = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id);
  const applicationId = (applied.body as { application: { id: string } }).application.id;

  const unapplied = await unapplyProtocol(fhir, applicationId);

  assert.equal(unapplied.status, 200);
  assert.equal(fhir.resourcesOf("CarePlan")[0]?.status, "revoked");
  assert.equal((await trackerSeries(fhir)).length, 0);
});

test("un-apply remains blocked while the companion package charge is accepted", async () => {
  const fhir = dryEyeFhir();
  const applied = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id, { acceptCharges: true });
  const applicationId = (applied.body as { application: { id: string } }).application.id;

  const unapplied = await unapplyProtocol(fhir, applicationId);

  assert.equal(unapplied.status, 409);
  assert.match(String((unapplied.body as { error: string }).error), /accepted charge/i);
  assert.equal(fhir.resourcesOf("CarePlan")[0]?.status, "active");
});

test("at-home regimen applies only counseling, education, and instruction with no series or charge", async () => {
  const fhir = dryEyeFhir();

  const applied = await applyProtocol(fhir, DRY_EYE_AT_HOME_REGIMEN_INIT_PROTOCOL.id);

  assert.equal(applied.status, 200);
  const body = applied.body as {
    actions: Array<{ actionType: string }>;
    charges: unknown[];
  };
  assert.deepEqual(
    new Set(body.actions.map((action) => action.actionType)),
    new Set(["counseling", "education", "instruction"]),
  );
  assert.equal(body.charges.length, 0);
  assert.equal(fhir.resourcesOf("CarePlan").length, 0);
  assert.equal((await trackerSeries(fhir)).length, 0);
});

test("LLLT initiation creates its four-session CarePlan and package charge proposal", async () => {
  const fhir = dryEyeFhir();

  const applied = await applyProtocol(fhir, DRY_EYE_LLLT_INIT_PROTOCOL.id);

  assert.equal(applied.status, 200);
  const series = await trackerSeries(fhir);
  assert.equal(series.length, 1);
  assert.equal(series[0]?.title, "LLLT");
  assert.equal(series[0]?.sessions.length, 4);
  const carePlan = fhir.resourcesOf("CarePlan")[0];
  assert.equal(carePlan?.instantiatesCanonical?.some((canonical) =>
    canonical.includes("/PlanDefinition/series-protocol-dry-eye-lllt")
  ), true);
  const charges = fhir.protocolBasics(PROTOCOL_BASIC_CODES.chargeProposal)
    .map((resource) => JSON.parse(resource.extension?.[0]?.valueString ?? "{}") as {
      procedureConceptKey?: string;
    });
  assert.deepEqual(charges.map((charge) => charge.procedureConceptKey), [
    "dry-eye-lllt-4-sessions",
  ]);
});

test("IPL and RF initiation on one encounter create two independent series and package charges", async () => {
  const fhir = dryEyeFhir();

  const ipl = await applyProtocol(fhir, DRY_EYE_IPL_INIT_PROTOCOL.id);
  const rf = await applyProtocol(fhir, DRY_EYE_RF_INIT_PROTOCOL.id);

  assert.equal(ipl.status, 200);
  assert.equal(rf.status, 200);
  const series = await trackerSeries(fhir);
  assert.deepEqual(series.map((item) => item.title), ["IPL", "RF"]);
  assert.equal(series.every((item) => item.sessions.length === 4), true);
  const charges = fhir.protocolBasics(PROTOCOL_BASIC_CODES.chargeProposal)
    .map((resource) => JSON.parse(resource.extension?.[0]?.valueString ?? "{}") as {
      procedureConceptKey?: string;
    });
  assert.deepEqual(
    new Set(charges.map((charge) => charge.procedureConceptKey)),
    new Set(["dry-eye-ipl-4-sessions", "dry-eye-rf-4-sessions"]),
  );
  assert.equal(fhir.resourcesOf("CarePlan").length, 2);
});

function dryEyeFhir(
  archivedSeries: readonly string[] = [],
  omittedSeries: readonly string[] = [],
): MemoryDryEyeFhir {
  const fhir = new MemoryDryEyeFhir();
  fhir.add(condition());
  for (const draft of DRY_EYE_SERIES_PROTOCOL_DRAFTS) {
    if (draft.id && omittedSeries.includes(draft.id)) continue;
    const status = draft.id && archivedSeries.includes(draft.id) ? "retired" : "active";
    fhir.addSeries(draft, status);
  }
  return fhir;
}

async function applyProtocol(
  fhir: MemoryDryEyeFhir,
  protocolId: string,
  overrides: {
    selections?: Array<{
      itemKey: string;
      selected: boolean;
      payload?: Record<string, unknown>;
    }>;
    acceptCharges?: boolean;
  } = {},
) {
  return handleProtocolApplyRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/synthetic-clinician",
      actorRole: "clinician",
      fhir: fhir as never,
    }),
    serviceFhir: fhir as never,
    now: () => NOW,
  }, {
    authHeader: AUTHORIZATION,
    body: {
      protocolId,
      encounterId: ENCOUNTER_ID,
      patientId: PATIENT_ID,
      diagnosis: {
        reference: `Condition/${CONDITION_ID}`,
        code: "H16.223",
        confirmed: true,
      },
      ...overrides,
    },
  });
}

async function unapplyProtocol(fhir: MemoryDryEyeFhir, applicationId: string) {
  return handleProtocolUnapplyRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/synthetic-clinician",
      actorRole: "clinician",
      fhir: fhir as never,
    }),
    now: () => NOW,
  }, {
    authHeader: AUTHORIZATION,
    params: { applicationId },
  });
}

async function trackerSeries(fhir: MemoryDryEyeFhir): Promise<Array<{
  title: string;
  sessions: unknown[];
}>> {
  const app = express();
  app.use(express.json());
  registerSeriesTrackerRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/synthetic-clinician",
      actorRole: "clinician",
      roles: ["clinician"],
      fhir: fhir as never,
    }),
    serviceFhir: fhir as never,
    now: () => NOW,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/series-tracker/patients/${PATIENT_ID}`, {
      headers: { Authorization: AUTHORIZATION },
    });
    assert.equal(response.status, 200);
    return (await response.json() as {
      series: Array<{ title: string; sessions: unknown[] }>;
    }).series;
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve())
    );
  }
}

function condition(): Condition {
  return {
    resourceType: "Condition",
    id: CONDITION_ID,
    verificationStatus: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
        code: "confirmed",
      }],
    },
    code: {
      coding: [{
        system: "http://hl7.org/fhir/sid/icd-10-cm",
        code: "H16.223",
      }],
    },
    subject: { reference: `Patient/${PATIENT_ID}` },
    encounter: { reference: `Encounter/${ENCOUNTER_ID}` },
  };
}

class MemoryDryEyeFhir {
  readonly resources: Resource[] = [];
  rejectNextPlanActionWrite = false;
  private next = 1;

  add<T extends Resource>(resource: T): T {
    this.resources.push(structuredClone(resource));
    return resource;
  }

  addSeries(draft: SeriesProtocolDefinitionDraft, status: PlanDefinition["status"]): void {
    if (!draft.id) throw new Error("Dry-eye series seed id is required.");
    const activity = buildSeriesActivityDefinition(draft.id, draft, NOW, status);
    const plan = buildSeriesPlanDefinition(draft.id, draft, activity.url!, NOW, status);
    this.add({ ...activity, id: `activity-${draft.id}` });
    this.add({ ...plan, id: `plan-${draft.id}` });
  }

  resourcesOf<T extends Resource["resourceType"]>(
    resourceType: T,
  ): Array<Extract<Resource, { resourceType: T }>> {
    return this.resources
      .filter((resource): resource is Extract<Resource, { resourceType: T }> =>
        resource.resourceType === resourceType
      );
  }

  protocolBasics(code: string): Basic[] {
    return this.resourcesOf("Basic").filter((resource) =>
      resource.code?.coding?.some((coding) => coding.code === code)
    );
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (!resource) throw new Error(`${resourceType}/${id} not found.`);
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    let resources = this.resources.filter((resource) => resource.resourceType === resourceType);
    if (params.code) {
      const [, code] = splitToken(params.code);
      resources = resources.filter((resource) =>
        resource.resourceType === "Basic" &&
        resource.code?.coding?.some((coding) => coding.code === code)
      );
    }
    if (params.identifier) {
      const [system, value] = splitToken(params.identifier);
      resources = resources.filter((resource) =>
        "identifier" in resource &&
        resource.identifier?.some((identifier) =>
          identifier.system === system && (!value || identifier.value === value)
        )
      );
    }
    if (params.subject) {
      resources = resources.filter((resource) =>
        "subject" in resource &&
        resource.subject &&
        "reference" in resource.subject &&
        resource.subject.reference === params.subject
      );
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      total: resources.length,
      entry: resources.map((resource) => ({ resource: structuredClone(resource) as T })),
    };
  }

  async create<T extends Resource>(
    resource: T,
    headers: Record<string, string> = {},
  ): Promise<T> {
    if (resource.resourceType === "Basic" &&
      resource.code?.coding?.some((coding) => coding.code === PROTOCOL_BASIC_CODES.planActionInstance) &&
      this.rejectNextPlanActionWrite) {
      this.rejectNextPlanActionWrite = false;
      throw new Error("Simulated archived-write adapter rejection.");
    }
    const conditional = headers["If-None-Exist"]?.replace(/^identifier=/, "");
    if (conditional) {
      const [system, value] = splitToken(conditional);
      const existing = this.resources.find((candidate) =>
        "identifier" in candidate &&
        candidate.identifier?.some((identifier) =>
          identifier.system === system && identifier.value === value
        )
      );
      if (existing) return structuredClone(existing) as T;
    }
    const saved = {
      ...structuredClone(resource),
      id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.next++}`,
    };
    this.resources.push(saved);
    return structuredClone(saved) as T;
  }

  update = async <T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> => {
    const index = this.resources.findIndex((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (index < 0) throw new Error(`${resourceType}/${id} not found for update.`);
    const saved = { ...structuredClone(resource), id };
    this.resources[index] = saved;
    return structuredClone(saved);
  };

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    for (const entry of bundle.entry ?? []) {
      if (!entry.resource) continue;
      const existing = this.resources.findIndex((candidate) =>
        candidate.resourceType === entry.resource?.resourceType &&
        "identifier" in candidate &&
        candidate.identifier?.some((identifier) =>
          entry.resource && "identifier" in entry.resource &&
          entry.resource.identifier?.some((next) =>
            next.system === identifier.system && next.value === identifier.value
          )
        )
      );
      const saved = {
        ...structuredClone(entry.resource),
        id: existing >= 0 ? this.resources[existing]!.id : `${entry.resource.resourceType.toLowerCase()}-${this.next++}`,
      };
      if (existing >= 0) this.resources[existing] = saved;
      else this.resources.push(saved);
    }
    return { resourceType: "Bundle", type: "transaction-response" };
  }
}

function splitToken(value: string): [string, string] {
  const separator = value.indexOf("|");
  return separator < 0
    ? [value, ""]
    : [value.slice(0, separator), value.slice(separator + 1)];
}
