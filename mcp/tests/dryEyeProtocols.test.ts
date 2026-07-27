import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import type {
  PackageDefinition,
  PackageDefinitionDraft,
} from "../src/commercial-engine/ledger-store.js";
import {
  DRY_EYE_CHARGE_RULES,
  DRY_EYE_EVALUATION_PROTOCOL,
  DRY_EYE_PUNCTAL_OCCLUSION_RULE_ID,
} from "../src/clinical-graph/protocol-fixtures.js";
import {
  DRY_EYE_PROCEDURE_STABLE_KEYS,
  buildProcedureDefinitionSeeds,
} from "../src/clinical-graph/procedure-definition-store.js";
import { ProtocolService } from "../src/clinical-graph/protocol-service.js";
import type { ProtocolFhirClient } from "../src/clinical-graph/protocol-store.js";
import type { ProtocolDefinition } from "../src/clinical-graph/protocol-types.js";
import type {
  SeriesProtocolDefinition,
  SeriesProtocolDefinitionDraft,
} from "../src/series-tracker/protocol-definition-store.js";
import {
  DRY_EYE_PACKAGE_DEFINITION_DRAFTS,
  DRY_EYE_SERIES_PROTOCOL_DRAFTS,
  seedDryEyeTreatmentDefinitions,
  type DryEyeTreatmentSeedAdapter,
} from "../../scripts/seed-dry-eye-treatment.js";

test("DE-2 compiles all seven eyecare procedure definitions without unverified CPT codes", () => {
  const dryEye = buildProcedureDefinitionSeeds().filter((definition) =>
    definition.stableKey.startsWith("procedure:dry-eye:")
  );
  assert.deepEqual(dryEye.map((definition) => definition.stableKey), Object.values(DRY_EYE_PROCEDURE_STABLE_KEYS));
  assert.deepEqual(dryEye.map((definition) => definition.display), [
    "IPL (OptiLight-class)",
    "RF (Opus-class)",
    "LLLT (Equinox-class)",
    "BlephEx / microblepharoexfoliation",
    "Meibomian gland expression",
    "Maskin probing",
    "Punctal occlusion (plugs)",
  ]);
  assert.equal(dryEye.every((definition) => definition.discipline === "eyecare"), true);
  assert.deepEqual(
    dryEye.filter((definition) => definition.photo_posture === "compare").map((definition) => definition.stableKey),
    [DRY_EYE_PROCEDURE_STABLE_KEYS.ipl, DRY_EYE_PROCEDURE_STABLE_KEYS.rf],
  );
  assert.equal(dryEye.every((definition) =>
    !("coding" in definition.fhirProcedureCode) &&
    definition.fhirProcedureCode.code === definition.stableKey &&
    definition.fhirProcedureCode.system !== "urn:ama:cpt"
  ), true);
  assert.equal(dryEye.every((definition) => definition.notBillReady), true);
});

test("IPL and LLLT series and package forks share one procedure vocabulary while RF stays definition-only", () => {
  for (const [name, code] of [
    ["IPL", DRY_EYE_PROCEDURE_STABLE_KEYS.ipl],
    ["LLLT", DRY_EYE_PROCEDURE_STABLE_KEYS.lllt],
  ] as const) {
    const series = DRY_EYE_SERIES_PROTOCOL_DRAFTS.find((draft) => draft.name === name);
    const packages = DRY_EYE_PACKAGE_DEFINITION_DRAFTS.filter((draft) => draft.name.startsWith(name));
    assert.ok(series);
    assert.equal(series.sessionCount, 4);
    assert.equal(series.intervalMinDays, 21);
    assert.equal(series.intervalMaxDays, 28);
    assert.equal(series.maintenanceAfter, true);
    assert.equal(packages.length, 2);
    assert.deepEqual(series.eligibleProcedureTypeCodes, [code]);
    assert.equal(packages.every((draft) =>
      JSON.stringify(draft.eligibleProcedureTypeCodes) === JSON.stringify(series.eligibleProcedureTypeCodes)
    ), true);
    assert.deepEqual(new Set(packages.map((draft) => draft.sessionCount)), new Set([1, 4]));
  }
  assert.equal(DRY_EYE_SERIES_PROTOCOL_DRAFTS.some((draft) =>
    draft.eligibleProcedureTypeCodes.includes(DRY_EYE_PROCEDURE_STABLE_KEYS.rf)
  ), false);
  assert.equal(DRY_EYE_PACKAGE_DEFINITION_DRAFTS.some((draft) =>
    draft.eligibleProcedureTypeCodes.includes(DRY_EYE_PROCEDURE_STABLE_KEYS.rf)
  ), false);
});

test("the first-run treatment seed is idempotent across the authored-only stores", async () => {
  const adapter = new MemoryTreatmentSeedAdapter();
  const first = await seedDryEyeTreatmentDefinitions(adapter);
  assert.deepEqual(first.series.created, ["IPL", "LLLT"]);
  assert.deepEqual(first.packages.created, [
    "IPL single session",
    "IPL 4 sessions",
    "LLLT single session",
    "LLLT 4 sessions",
  ]);
  const second = await seedDryEyeTreatmentDefinitions(adapter);
  assert.deepEqual(second.series.unchanged, ["IPL", "LLLT"]);
  assert.deepEqual(second.packages.unchanged, [
    "IPL single session",
    "IPL 4 sessions",
    "LLLT single session",
    "LLLT 4 sessions",
  ]);
  assert.equal(adapter.series.length, 2);
  assert.equal(adapter.packages.length, 4);
});

test("the first-run treatment seed skips archived definitions without attempting rejected updates", async () => {
  const adapter = new MemoryTreatmentSeedAdapter();
  await seedDryEyeTreatmentDefinitions(adapter);
  adapter.series[0] = { ...adapter.series[0]!, active: false, name: "Archived IPL" };
  adapter.packages[0] = { ...adapter.packages[0]!, active: false, priceCents: 1 };

  const result = await seedDryEyeTreatmentDefinitions(adapter);

  assert.deepEqual(result.series.skippedArchived, ["IPL"]);
  assert.deepEqual(result.packages.skippedArchived, ["IPL single session"]);
  assert.deepEqual(result.series.unchanged, ["LLLT"]);
  assert.deepEqual(result.packages.unchanged, [
    "IPL 4 sessions",
    "LLLT single session",
    "LLLT 4 sessions",
  ]);
});

test("dry-eye evaluation proposes eight prompt-only sections and materializes one coverage-reviewed charge", async () => {
  const fhir = new MemoryProtocolFhir();
  const materializedActions: string[] = [];
  const service = new ProtocolService(fhir, {
    async commitFinding() {
      throw new Error("Prompt-only findings must not materialize observations.");
    },
    async materializeAction(action) {
      materializedActions.push(action.sourceItemKey ?? action.id);
      return `ServiceRequest/${action.id}`;
    },
  }, () => "2026-07-26T12:00:00.000Z", sequentialId());
  await service.definitions.save(DRY_EYE_EVALUATION_PROTOCOL);
  for (const rule of DRY_EYE_CHARGE_RULES) await service.chargeRules.save(rule);
  const opened = await service.open(DRY_EYE_EVALUATION_PROTOCOL.id, {
    encounterId: "enc-dry-eye",
    patientId: "patient-1",
    diagnosis: { reference: "Condition/kcs", code: "H16.223", confirmed: true },
    actor: "Practitioner/test",
  });
  assert.equal(opened.proposedFindings.length, 8);
  assert.equal(opened.proposedFindings.every((finding) => finding.value === undefined && finding.state === "proposed"), true);

  await service.commit(opened.application.id, [], ["Condition/kcs"]);
  const findings = await service.findings.list();
  assert.equal(findings.length, 8);
  assert.equal(findings.every((finding) =>
    finding.state === "committed" && finding.observationReference === undefined
  ), true);
  assert.deepEqual(materializedActions, ["order-dry-eye-evaluation"]);
  const charges = await service.charges.list();
  assert.equal(charges.length, 1);
  assert.equal(charges[0]?.procedureConceptKey, "dry-eye-evaluation");
  assert.equal(charges[0]?.coverageEvaluations[0]?.outcome, "needs-review");
  assert.equal(charges[0]?.coverageEvaluations[0]?.ruleId, "rule-dry-eye-evaluation");
});

test("punctal occlusion alone resolves an insurance review rule; cash procedures have none", async () => {
  const fhir = new MemoryProtocolFhir();
  const service = new ProtocolService(fhir, {
    async commitFinding() { return undefined; },
    async materializeAction() { return undefined; },
  }, () => "2026-07-26T12:00:00.000Z", sequentialId());
  const punctalProtocol: ProtocolDefinition = {
    ...DRY_EYE_EVALUATION_PROTOCOL,
    id: "punctal-rule-proof",
    items: [{
      itemKey: "charge-punctal",
      itemType: "charge-seed",
      defaultSelected: true,
      lateralityMode: "inherit-dx",
      payload: {
        procedureConceptKey: DRY_EYE_PROCEDURE_STABLE_KEYS.punctalOcclusion,
        chargeRuleRefs: [DRY_EYE_PUNCTAL_OCCLUSION_RULE_ID],
      },
    }],
  };
  await service.definitions.save(punctalProtocol);
  for (const rule of DRY_EYE_CHARGE_RULES) await service.chargeRules.save(rule);
  const opened = await service.open(punctalProtocol.id, {
    encounterId: "enc-plugs",
    patientId: "patient-1",
    diagnosis: { reference: "Condition/kcs", code: "H16.223", confirmed: true },
    actor: "Practitioner/test",
  });
  await service.commit(opened.application.id, [], ["Condition/kcs"]);
  const charge = (await service.charges.list())[0];
  assert.equal(charge?.coverageEvaluations[0]?.ruleId, DRY_EYE_PUNCTAL_OCCLUSION_RULE_ID);
  assert.equal(charge?.coverageEvaluations[0]?.outcome, "needs-review");
  const coveredProcedureKeys = new Set((await service.chargeRules.list()).map((rule) => rule.procedureConceptKey));
  assert.equal(coveredProcedureKeys.has(DRY_EYE_PROCEDURE_STABLE_KEYS.punctalOcclusion), true);
  for (const code of [
    DRY_EYE_PROCEDURE_STABLE_KEYS.ipl,
    DRY_EYE_PROCEDURE_STABLE_KEYS.rf,
    DRY_EYE_PROCEDURE_STABLE_KEYS.lllt,
    DRY_EYE_PROCEDURE_STABLE_KEYS.blephex,
    DRY_EYE_PROCEDURE_STABLE_KEYS.glandExpression,
    DRY_EYE_PROCEDURE_STABLE_KEYS.maskinProbing,
  ]) assert.equal(coveredProcedureKeys.has(code), false, code);
});

class MemoryProtocolFhir implements ProtocolFhirClient {
  rows: Basic[] = [];
  next = 1;

  async search<T extends Basic>(_resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> {
    const code = params?.code?.split("|")[1];
    const [system, value] = params?.identifier?.split("|") ?? [];
    let rows = code
      ? this.rows.filter((row) => row.code?.coding?.some((coding) => coding.code === code))
      : this.rows;
    if (system && value) rows = rows.filter((row) => row.identifier?.some((identifier) =>
      identifier.system === system && identifier.value === value
    ));
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: resource as T })),
    };
  }

  async create<T extends Basic>(resource: T, headers?: Record<string, string>): Promise<T> {
    const conditional = headers?.["If-None-Exist"]?.replace(/^identifier=/, "");
    if (conditional) {
      const [system, value] = conditional.split("|");
      const existing = this.rows.find((row) => row.identifier?.some((identifier) =>
        identifier.system === system && identifier.value === value
      ));
      if (existing) return existing as T;
    }
    const saved = { ...resource, id: `basic-${this.next++}` };
    this.rows.push(saved);
    return saved;
  }

  async update<T extends Basic>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    const saved = { ...resource, id };
    const index = this.rows.findIndex((row) => row.id === id);
    this.rows[index] = saved;
    return saved;
  }
}

class MemoryTreatmentSeedAdapter implements DryEyeTreatmentSeedAdapter {
  series: SeriesProtocolDefinition[] = [];
  packages: PackageDefinition[] = [];
  nextPackage = 1;

  async listSeriesProtocols(): Promise<SeriesProtocolDefinition[]> {
    return structuredClone(this.series);
  }

  async saveSeriesProtocol(draft: SeriesProtocolDefinitionDraft): Promise<SeriesProtocolDefinition> {
    const existing = this.series.find((definition) => definition.id === draft.id);
    if (existing && !existing.active) throw new Error("Archived protocol definitions cannot be edited.");
    const saved: SeriesProtocolDefinition = {
      ...draft,
      id: draft.id ?? `series-${this.series.length + 1}`,
      active: true,
      planDefinitionCanonical: `https://odos2020.com/fhir/PlanDefinition/${draft.id}`,
      activityDefinitionCanonical: `https://odos2020.com/fhir/ActivityDefinition/${draft.id}`,
      updatedAt: "2026-07-26T12:00:00.000Z",
    };
    const index = this.series.findIndex((definition) => definition.id === saved.id);
    if (index < 0) this.series.push(saved);
    else this.series[index] = saved;
    return structuredClone(saved);
  }

  async listPackageDefinitions(): Promise<PackageDefinition[]> {
    return structuredClone(this.packages);
  }

  async savePackageDefinition(draft: PackageDefinitionDraft): Promise<PackageDefinition> {
    const existing = draft.id ? this.packages.find((definition) => definition.id === draft.id) : undefined;
    if (existing && !existing.active) throw new Error("Archived package definitions cannot be edited.");
    const saved: PackageDefinition = {
      ...draft,
      id: draft.id ?? `package-${this.nextPackage++}`,
      expiryDays: draft.expiryDays ?? 365,
      refundPolicy: draft.refundPolicy ?? "non_refundable",
      active: true,
      soldCount: existing?.soldCount ?? 0,
      createdAt: existing?.createdAt ?? "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
    };
    const index = this.packages.findIndex((definition) => definition.id === saved.id);
    if (index < 0) this.packages.push(saved);
    else this.packages[index] = saved;
    return structuredClone(saved);
  }
}

function sequentialId(): () => string {
  let next = 1;
  return () => `id-${next++}`;
}
