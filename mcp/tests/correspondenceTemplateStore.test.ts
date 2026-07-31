import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import {
  CURATED_CONSULT_REPORT_TEMPLATES,
  CURATED_REFERRAL_TEMPLATES,
  CorrespondenceTemplateStore,
  parseCorrespondenceTemplate,
} from "../src/correspondence/template-store.js";

test("correspondence template store seeds the curated referral and consult starter sets", async () => {
  const fhir = new BasicFhir();
  const store = new CorrespondenceTemplateStore(fhir, () => "template-custom");

  const templates = await store.list("referral");

  assert.deepEqual(
    templates.map((template) => [template.name, template.specialty, template.register]),
    CURATED_REFERRAL_TEMPLATES.map((template) => [
      template.name,
      template.specialty,
      template.register,
    ]),
  );
  const consultTemplates = await store.list("consult-report");
  assert.deepEqual(
    consultTemplates.map((template) => [template.name, template.register]),
    CURATED_CONSULT_REPORT_TEMPLATES.map((template) => [template.name, template.register]),
  );
  assert.equal(fhir.resources.length, 5);
  assert.ok(templates.every((template) => template.letterType === "referral"));
  assert.ok(consultTemplates.every((template) => template.letterType === "consult-report"));
});

test("correspondence template store creates, reads, updates, and recoverably removes a template", async () => {
  const fhir = new BasicFhir();
  const store = new CorrespondenceTemplateStore(fhir, () => "template-custom");
  const created = await store.create({
    name: "Neuro-ophthalmology referral",
    letterType: "referral",
    specialty: "neuro-ophthalmology",
    bodyHtml: "<p>Dear {{recipient.name}},</p><p>{{findings.block}}</p>",
    register: "formal",
  });

  assert.equal(created.id, "template-custom");
  assert.deepEqual(await store.read("template-custom"), created);

  const updated = await store.update("template-custom", {
    ...created,
    register: "warm",
    bodyHtml: "<p>Hello {{recipient.name}},</p><p>{{plan.block}}</p>",
  });
  assert.equal(updated.register, "warm");
  assert.match(updated.bodyHtml, /plan\.block/);

  await store.remove("template-custom");
  assert.equal(await store.read("template-custom"), undefined);
  assert.equal(parseCorrespondenceTemplate(fhir.resources[0]!).active, false);
});

class BasicFhir {
  readonly resources: Basic[] = [];

  async search(): Promise<Bundle<Basic>> {
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: this.resources.map((resource) => ({ resource })),
    };
  }

  async searchUrl(): Promise<Bundle<Basic>> {
    return this.search();
  }

  async create(resource: Basic): Promise<Basic> {
    const identifier = resource.identifier?.[0]?.value;
    const existing = this.resources.find((row) => row.identifier?.[0]?.value === identifier);
    if (existing) return existing;
    const created = { ...resource, id: resource.id ?? `basic-${this.resources.length + 1}` };
    this.resources.push(created);
    return created;
  }

  async update(_resourceType: "Basic", id: string, resource: Basic): Promise<Basic> {
    const index = this.resources.findIndex((row) => row.id === id);
    assert.notEqual(index, -1);
    const updated = { ...resource, id };
    this.resources[index] = updated;
    return updated;
  }
}
