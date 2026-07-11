import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosisSettingsReady } from "../src/scenes/settings/DiagnosisSettings";

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
