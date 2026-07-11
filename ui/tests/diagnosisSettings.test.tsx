import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiagnosisSettingsReady,
  diagnosisDescriptor,
  diagnosisMappingDescriptor,
  keyFindingDescriptor,
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
        keyFindings: [],
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

test("key-finding settings save ordered practice rows and deactivate instead of deleting", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const diagnoses = [{
    id: "glaucoma",
    stableKey: "glaucoma",
    display: "POAG",
    clinicalFamily: "glaucoma",
    codingStatus: "verified" as const,
    origin: "seed" as const,
    lateralityRequired: false,
    code: "",
    unspecifiedEye: "",
    right: "",
    left: "",
    bilateral: "",
    keyFindings: [
      { findingKey: "cup_disc_ratio", satisfiedBy: "this-encounter" as const, origin: "practice" as const, active: true },
      { findingKey: "pachymetry_um", satisfiedBy: "any-on-file" as const, withinMonths: 12, origin: "practice" as const, active: true },
    ],
    active: true,
  }];
  const request = async <T,>(path: string, body: unknown): Promise<T> => {
    requests.push({ path, body });
    return { diagnosis: { ...diagnoses[0], keyFindings: (body as { keyFindings: unknown[] }).keyFindings } } as T;
  };
  const descriptor = keyFindingDescriptor([
    { stableKey: "cup_disc_ratio", display: "Cup/disc ratio", active: true, allowDiagnosisMapping: true, diagnosisCandidates: [] },
    { stableKey: "pachymetry_um", display: "Pachymetry", active: true, allowDiagnosisMapping: true, diagnosisCandidates: [] },
  ], diagnoses, undefined, request);

  await descriptor.adapter.reorder?.([
    "key-finding:glaucoma:pachymetry_um",
    "key-finding:glaucoma:cup_disc_ratio",
  ]);
  assert.deepEqual((requests[0]?.body as { keyFindings: Array<{ findingKey: string }> }).keyFindings.map((row) => row.findingKey), [
    "pachymetry_um",
    "cup_disc_ratio",
  ]);

  await descriptor.adapter.deactivate({
    id: "key-finding:glaucoma:cup_disc_ratio",
    diagnosisKey: "glaucoma",
    persistedDiagnosisKey: "glaucoma",
    findingKey: "cup_disc_ratio",
    persistedFindingKey: "cup_disc_ratio",
    label: "",
    satisfiedBy: "this-encounter",
    origin: "practice",
    active: true,
  });
  const deactivated = (requests[1]?.body as { keyFindings: Array<{ findingKey: string; active: boolean }> }).keyFindings
    .find((row) => row.findingKey === "cup_disc_ratio");
  assert.equal(deactivated?.active, false);
  assert.match(requests[1]?.path ?? "", /diagnosis-catalog\/glaucoma$/);
});

test("rapid key-finding edits serialize against the latest saved array", async () => {
  const requests: Array<{ keyFindings: Array<Record<string, unknown>> }> = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const diagnosis = {
    id: "glaucoma",
    stableKey: "glaucoma",
    display: "POAG",
    clinicalFamily: "glaucoma",
    codingStatus: "verified" as const,
    origin: "seed" as const,
    lateralityRequired: false,
    code: "",
    unspecifiedEye: "",
    right: "",
    left: "",
    bilateral: "",
    keyFindings: [
      { findingKey: "cup_disc_ratio", satisfiedBy: "this-encounter" as const, origin: "practice" as const, active: true },
      { findingKey: "pachymetry_um", satisfiedBy: "any-on-file" as const, withinMonths: 12, origin: "practice" as const, active: true },
    ],
    active: true,
  };
  const request = async <T,>(_path: string, body: unknown): Promise<T> => {
    const payload = body as { keyFindings: Array<Record<string, unknown>> };
    requests.push(payload);
    if (requests.length === 1) await firstBlocked;
    return {
      diagnosis: {
        ...diagnosis,
        keyFindings: payload.keyFindings.map((entry) => ({ ...entry, origin: "practice" })),
      },
    } as T;
  };
  const adapter = keyFindingDescriptor([], [diagnosis], undefined, request).adapter;
  const first = adapter.save({
    id: "key-finding:glaucoma:cup_disc_ratio",
    diagnosisKey: "glaucoma",
    persistedDiagnosisKey: "glaucoma",
    findingKey: "cup_disc_ratio",
    persistedFindingKey: "cup_disc_ratio",
    label: "Disc appearance",
    satisfiedBy: "this-encounter",
    origin: "practice",
    active: true,
  });
  const second = adapter.save({
    id: "key-finding:glaucoma:pachymetry_um",
    diagnosisKey: "glaucoma",
    persistedDiagnosisKey: "glaucoma",
    findingKey: "pachymetry_um",
    persistedFindingKey: "pachymetry_um",
    label: "Corneal thickness",
    satisfiedBy: "any-on-file",
    withinMonths: 12,
    origin: "practice",
    active: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1]?.keyFindings.map((entry) => [entry.findingKey, entry.label]),
    [["cup_disc_ratio", "Disc appearance"], ["pachymetry_um", "Corneal thickness"]],
  );
});
