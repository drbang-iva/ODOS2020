import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiagnosisSettingsReady,
  diagnosisDescriptor,
  diagnosisMappingDescriptor,
} from "../src/scenes/settings/DiagnosisSettings";

test("diagnosis settings render grouped mappings, provisional catalog state, and read-only posture", () => {
  const html = renderToStaticMarkup(
    <DiagnosisSettingsReady
      canWrite={false}
      diagnoses={[{
        id: "custom:kcs",
        stableKey: "custom:kcs",
        display: "Keratoconjunctivitis sicca",
        clinicalFamily: "ocular-surface",
        codingStatus: "provisional",
        origin: "practice",
        lateralityRequired: false,
        code: "",
        unspecifiedEye: "",
        right: "",
        left: "",
        bilateral: "",
        active: true,
      }]}
      findings={[{
        stableKey: "tear_film",
        display: "Tear Film",
        allowDiagnosisMapping: true,
        diagnosisCandidates: [],
      }]}
      mappings={[{
        id: "CUSTOM_KCS_1",
        findingKey: "tear_film",
        findingDisplay: "Tear Film",
        diagnosisKey: "custom:kcs",
        triggerKind: "always",
        field: "",
        operator: ">=",
        triggerValue: "",
        priority: true,
        active: true,
      }]}
    />,
  );
  assert.match(html, /Suggested diagnoses by finding/);
  assert.match(html, /Tear Film/);
  assert.match(html, /Keratoconjunctivitis sicca/);
  assert.match(html, /PROVISIONAL/);
  assert.match(html, /Read only/);
  assert.doesNotMatch(html, /\+ Add diagnosis/);
});

test("existing mapping saves reject finding changes and keep unchanged saves on their persisted finding", async () => {
  let requestedPath = "";
  const request = async <T,>(path: string): Promise<T> => {
    requestedPath = path;
    return {
      candidate: { id: "MAP_1", diagnosisKey: "myopia", trigger: { kind: "always" }, active: true },
    } as T;
  };
  const findings = [{
    stableKey: "tear_film",
    display: "Tear Film",
    allowDiagnosisMapping: true,
    diagnosisCandidates: [{ id: "MAP_1", diagnosisKey: "myopia", trigger: { kind: "always" }, active: true }],
  }, {
    stableKey: "refraction",
    display: "Refraction",
    allowDiagnosisMapping: true,
    diagnosisCandidates: [],
  }];
  const descriptor = diagnosisMappingDescriptor(findings, [], request);
  const changedRow = {
    id: "MAP_1",
    findingKey: "refraction",
    findingDisplay: "Refraction",
    diagnosisKey: "myopia",
    triggerKind: "always",
    field: "",
    operator: ">=",
    triggerValue: "",
    priority: false,
    active: true,
  };
  await assert.rejects(
    descriptor.adapter.save(changedRow),
    /Changing the finding for an existing mapping isn't supported/,
  );
  assert.equal(requestedPath, "");

  const saved = await descriptor.adapter.save({
    ...changedRow,
    findingKey: "tear_film",
    findingDisplay: "Tear Film",
  });
  assert.match(requestedPath, /finding-definitions\/tear_film$/);
  assert.equal(saved.findingKey, "tear_film");
});

test("newly saved diagnoses appear in mapping options without a reload", async () => {
  let liveDiagnoses: Parameters<typeof diagnosisMappingDescriptor>[1] = [];
  const request = async <T,>(): Promise<T> => ({ diagnosis: {
      stableKey: "custom:kcs-live",
      display: "Keratoconjunctivitis sicca",
      clinicalFamily: "ocular-surface",
      codingStatus: "provisional",
      origin: "practice",
      lateralityRequired: false,
      active: true,
    } } as T);
  const catalog = diagnosisDescriptor(
    (saved) => { liveDiagnoses = [...liveDiagnoses, saved]; },
    request,
  );
  await catalog.adapter.save({
    ...catalog.createItem(),
    display: "Keratoconjunctivitis sicca",
    clinicalFamily: "ocular-surface",
  });
  const mapping = diagnosisMappingDescriptor([], liveDiagnoses);
  const diagnosisField = mapping.fields.find((field) => field.key === "diagnosisKey");
  assert.equal(diagnosisField?.type, "select");
  assert.deepEqual(diagnosisField?.type === "select" ? diagnosisField.options : [], [{
    value: "custom:kcs-live",
    label: "Keratoconjunctivitis sicca · provisional",
  }]);
});
