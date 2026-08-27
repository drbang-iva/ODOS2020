import assert from "node:assert/strict";
import { test } from "node:test";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import {
  formatStaleEncounterDiagnosisRepair,
  repairStaleEncounterDiagnoses,
  type StaleEncounterDiagnosisRepairAdapter,
} from "../../scripts/repair-stale-encounter-diagnoses.ts";

class FakeRepairAdapter implements StaleEncounterDiagnosisRepairAdapter {
  readonly encounters: Encounter[];
  readonly conditions: Condition[];
  readonly writes: Array<{ encounter: Encounter; headers: Record<string, string> }> = [];

  constructor(encounters: Encounter[], conditions: Condition[]) {
    this.encounters = structuredClone(encounters);
    this.conditions = structuredClone(conditions);
  }

  async listEncounters(): Promise<Encounter[]> {
    return structuredClone(this.encounters);
  }

  async listConditionsByVerificationStatus(status: "refuted" | "entered-in-error"): Promise<Condition[]> {
    return structuredClone(this.conditions.filter((condition) =>
      condition.verificationStatus?.coding?.some((coding) => coding.code === status)
    ));
  }

  async updateEncounter(encounter: Encounter, headers: Record<string, string>): Promise<Encounter> {
    const index = this.encounters.findIndex((candidate) => candidate.id === encounter.id);
    assert.notEqual(index, -1);
    assert.equal(headers["If-Match"], `W/"${this.encounters[index]?.meta?.versionId}"`);
    const updated = structuredClone({
      ...encounter,
      meta: { ...encounter.meta, versionId: String(Number(encounter.meta?.versionId) + 1) },
    });
    this.encounters[index] = updated;
    this.writes.push({ encounter: structuredClone(encounter), headers: structuredClone(headers) });
    return structuredClone(updated);
  }
}

test("stale Encounter diagnosis repair is dry-run by default, preserves rank gaps, and is idempotent", async () => {
  const adapter = new FakeRepairAdapter([
    encounter("e1", [
      ["active-a", 1],
      ["refuted", 4],
      ["entered-error", 7],
      ["active-b", 10],
    ]),
    encounter("clean", [["active-clean", 2]]),
  ], [
    condition("refuted", "Refuted diagnosis", "refuted"),
    condition("entered-error", "Entered-in-error diagnosis", "entered-in-error"),
  ]);

  const dryRun = await repairStaleEncounterDiagnoses(adapter, false);
  assert.equal(formatStaleEncounterDiagnosisRepair(dryRun), [
    "Mode: DRY RUN",
    "Encounter/e1",
    "  remove Condition/refuted | Refuted diagnosis | refuted | rank 4",
    "  remove Condition/entered-error | Entered-in-error diagnosis | entered-in-error | rank 7",
    "  keep Condition/active-a | rank 1",
    "  keep Condition/active-b | rank 10",
    "Encounters inspected: 2",
    "Encounters needing repair: 1",
    "Encounters changed: 0",
    "Dry run only. Re-run with --apply to unlink these stale diagnosis references.",
  ].join("\n"));
  assert.equal(adapter.writes.length, 0);
  assert.deepEqual(adapter.encounters[0]?.diagnosis?.map((entry) => entry.rank), [1, 4, 7, 10]);

  const applied = await repairStaleEncounterDiagnoses(adapter, true);
  assert.equal(applied.encountersChanged, 1);
  assert.deepEqual(adapter.encounters[0]?.diagnosis?.map((entry) => ({
    reference: entry.condition.reference,
    rank: entry.rank,
  })), [
    { reference: "Condition/active-a", rank: 1 },
    { reference: "Condition/active-b", rank: 10 },
  ]);
  assert.equal(adapter.writes.length, 1);

  const repeated = await repairStaleEncounterDiagnoses(adapter, true);
  assert.equal(repeated.encountersNeedingRepair, 0);
  assert.equal(repeated.encountersChanged, 0);
  assert.equal(adapter.writes.length, 1);
});

function encounter(id: string, diagnoses: Array<[conditionId: string, rank: number]>): Encounter {
  return {
    resourceType: "Encounter",
    id,
    meta: { versionId: "3" },
    status: "in-progress",
    class: {},
    diagnosis: diagnoses.map(([conditionId, rank]) => ({
      condition: { reference: `Condition/${conditionId}` },
      rank,
    })),
  };
}

function condition(
  id: string,
  display: string,
  verificationStatus: "refuted" | "entered-in-error",
): Condition {
  return {
    resourceType: "Condition",
    id,
    code: { text: display },
    subject: { reference: "Patient/p1" },
    verificationStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: verificationStatus }],
    },
  };
}
