import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceRequest } from "@medplum/fhirtypes";
import {
  ReferralCompose,
  consultantChangeAction,
} from "../src/components/referral/ReferralCompose";
import {
  REFERRAL_LETTER_BODY_EXTENSION_URL,
  ReferralConflictError,
  createReferralApi,
  readReferralLetterBody,
  type ReferralApi,
  type ReferralIncludeList,
} from "../src/components/referral/referral-api";

const INCLUDE_LIST: ReferralIncludeList = {
  letter: true,
  demographics: true,
  history: true,
  clinical_summary: false,
  images: false,
  hipaa_cover_sheet: false,
  history_count: 2,
};

test("the compose surface presents the locked clinical rail and honest transport controls", () => {
  const html = renderToStaticMarkup(
    <ReferralCompose
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onClose={() => undefined}
      api={apiStub()}
      loadContext={async () => ({ doctorDisplay: "Dr. Rivera", findingCount: 3, hasPlan: true })}
    />,
  );

  for (const label of [
    "Consultant",
    "Reason &amp; urgency",
    "Letter",
    "Packet contents",
    "Send",
    "The Packet",
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /Routine|routine/);
  assert.match(html, /Urgent|urgent/);
  assert.match(html, /Stat|stat/);
  assert.match(html, /Fax · soon/);
  assert.match(html, /disabled=""[^>]*>Fax · soon|>Fax · soon<\/button>/);
  assert.match(html, /Sending records a disclosure/);
  assert.match(html, /Return to chart/);
});

test("consultant changes regenerate untouched letters but protect clinician edits", () => {
  assert.equal(consultantChangeAction(false), "regenerate");
  assert.equal(consultantChangeAction(true), "warn");
});

test("the packet preview is a sandboxed srcDoc iframe and never joins artifact HTML to the app DOM", () => {
  const source = readFileSync(
    new URL("../src/components/referral/ReferralCompose.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<iframe[\s\S]*sandbox="allow-modals"[\s\S]*srcDoc=\{artifact\}/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.match(source, /Consultant changed — this letter may still address the previous consultant/);
  assert.match(source, /Regenerate this letter and discard your edits/);
});

test("the assessment disposition exposes the referral compose screen from the live encounter", () => {
  const assessment = readFileSync(
    new URL("../src/components/charting/AssessmentSection.tsx", import.meta.url),
    "utf8",
  );
  const encounter = readFileSync(
    new URL("../src/scenes/EncounterCharting.tsx", import.meta.url),
    "utf8",
  );
  assert.match(assessment, /onRefer\?\(\)|onRefer/);
  assert.match(assessment, /Refer to…/);
  assert.match(encounter, /<ReferralCompose/);
  assert.match(encounter, /onRefer=\{\(\) => setReferralComposeOpen\(true\)\}/);
});

test("the referral API uses the directory, PATCH mutation, regenerate, preview, send, and defaults contracts", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const serviceRequest = referral();
  const api = createReferralApi(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const body = url.endsWith("/defaults")
      ? { includeList: INCLUDE_LIST }
      : url.includes("/consultants")
        ? { consultants: [{ reference: "Organization/o1", display: "Retina Group" }] }
        : url.endsWith("/preview") || url.endsWith("/send")
          ? { serviceRequestReference: "ServiceRequest/r1", artifact: "<!doctype html><html></html>" }
          : { serviceRequest };
    return jsonResponse(body);
  });

  await api.loadDefaults();
  await api.saveDefaults(INCLUDE_LIST);
  await api.loadRecentConsultants();
  await api.searchConsultants("retina");
  await api.createReferral({
    patientId: "p1",
    targetReference: "Organization/o1",
    encounterReference: "Encounter/e1",
    includeList: INCLUDE_LIST,
    priority: "urgent",
    reasonText: "  macular change  ",
  });
  await api.updateReferral("p1", "r1", { priority: "stat" });
  await api.regenerateReferral("p1", "r1");
  await api.previewReferral("p1", "r1", "Edited preview");
  await api.sendReferral("p1", "r1", "Edited send");

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", "/referrals/defaults"],
    ["PUT", "/referrals/defaults"],
    ["GET", "/referrals/consultants/recent"],
    ["GET", "/referrals/consultants?q=retina"],
    ["POST", "/referrals/patients/p1"],
    ["PATCH", "/referrals/patients/p1/r1"],
    ["POST", "/referrals/patients/p1/r1/regenerate"],
    ["POST", "/referrals/patients/p1/r1/preview"],
    ["POST", "/referrals/patients/p1/r1/send"],
  ]);
  assert.deepEqual(calls[4]?.body, {
    targetReference: "Organization/o1",
    encounterReference: "Encounter/e1",
    includeList: INCLUDE_LIST,
    priority: "urgent",
    reasonText: "macular change",
  });
  assert.deepEqual(calls[5]?.body, { priority: "stat" });
  assert.deepEqual(calls[7]?.body, { editedLetterBody: "Edited preview" });
  assert.deepEqual(calls[8]?.body, { editedLetterBody: "Edited send" });
});

test("the referral API turns documented 409 responses into a reopen-required conflict", async () => {
  const api = createReferralApi(async () => jsonResponse({ error: "stale" }, 409));
  await assert.rejects(
    api.updateReferral("p1", "r1", { priority: "urgent" }),
    (error: unknown) => error instanceof ReferralConflictError && error.message === "stale",
  );
});

test("the created ServiceRequest supplies the editable generated letter without another fetch", () => {
  assert.equal(readReferralLetterBody(referral()), "Dear Retina Group,\n\nPlease evaluate this patient.");
});

function referral(): ServiceRequest {
  return {
    resourceType: "ServiceRequest",
    id: "r1",
    meta: { versionId: "1" },
    status: "draft",
    intent: "order",
    code: { text: "Specialist referral" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    requester: { reference: "Practitioner/doctor" },
    performer: [{ reference: "Organization/o1", display: "Retina Group" }],
    extension: [{
      url: REFERRAL_LETTER_BODY_EXTENSION_URL,
      valueString: "Dear Retina Group,\n\nPlease evaluate this patient.",
    }],
  };
}

function apiStub(): ReferralApi {
  return {
    loadDefaults: async () => INCLUDE_LIST,
    saveDefaults: async (includeList) => includeList,
    searchConsultants: async () => [],
    loadRecentConsultants: async () => [],
    createReferral: async () => referral(),
    updateReferral: async () => referral(),
    regenerateReferral: async () => referral(),
    previewReferral: async () => ({ serviceRequestReference: "ServiceRequest/r1", artifact: "" }),
    sendReferral: async () => ({ serviceRequestReference: "ServiceRequest/r1", artifact: "" }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
