import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition, Resource } from "@medplum/fhirtypes";
import {
  buildProcedureFeeDefinition,
  listActiveCodedNonVisitProcedureFees,
} from "../clinical-graph/procedure-fee-schedule.js";

test("lists only active coded non-visit procedure fees without mutations", async () => {
  const definitions = [
    buildProcedureFeeDefinition({ procedureConceptKey: "gonioscopy", display: "Gonioscopy", billingCode: "SYNTHA", active: true }),
    buildProcedureFeeDefinition({ procedureConceptKey: "corneal-pachymetry", display: "Corneal pachymetry", active: true }),
    buildProcedureFeeDefinition({ procedureConceptKey: "fundus-photography", display: "Fundus photography", billingCode: "SYNTHB", active: false }),
    buildProcedureFeeDefinition({ procedureConceptKey: "comprehensive-exam-new", display: "Visit", billingCode: "SYNTHC", active: true }),
  ];
  let mutations = 0;
  const fhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: definitions.map((resource) => ({ resource: resource as T })),
      };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    },
    async create(): Promise<never> {
      mutations += 1;
      throw new Error("The option filter must not create fee definitions.");
    },
    async update(): Promise<never> {
      mutations += 1;
      throw new Error("The option filter must not update fee definitions.");
    },
  };

  const options = await listActiveCodedNonVisitProcedureFees(fhir);

  assert.deepEqual(options.map((item) => item.procedureConceptKey), ["gonioscopy"]);
  assert.equal(options[0]?.billingCode, "SYNTHA");
  assert.equal(mutations, 0);
});
