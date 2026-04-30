import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  prepareBinaryForParserCreate,
} from "../../mcp/src/parsers/binarySecurityContext.js";
import {
  assertAuditMutationAllowed,
  assertAuditSessionVisible,
  buildOsodAuditEventRow,
} from "../../mcp/src/authz/osodAudit.js";
import {
  assertClinicianSessionMatches,
  buildScribeDraftObservation,
  scribeWriteObservationSchema,
} from "../../mcp/src/fhir/scribeAttestation.js";
import { assertPreflightNetworkSurface } from "../../scripts/preflight-lint.ts";
import { assertInteractiveSetupWizardAllowed } from "../../scripts/setup-practice.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_INDEX = resolve(HERE, "../../mcp/src/index.ts");

test("Mandate 8 boundary: MCP exposes no auth-flow or credential-management tools", () => {
  const toolNames = listMcpToolNames();
  const forbiddenToolNames = [
    "invite_user",
    "create_user_invite",
    "reset_user_password",
    "create_project_membership",
    "update_project_membership",
    "modify_project_membership",
    "change_role_assignment",
    "bind_access_policy",
    "approve_baa",
    "approve_deploy",
    "approve_legal_screen",
    "initiate_break_glass",
    "break_glass",
  ];

  for (const forbidden of forbiddenToolNames) {
    assert.equal(
      toolNames.includes(forbidden),
      false,
      `Mandate 8 boundary: MCP must not expose ${forbidden}.`,
    );
  }
});

test("Mandate 8 boundary: MCP tool names contain no auth-flow aliases", () => {
  const toolNames = listMcpToolNames();
  const forbiddenPatterns = [
    /invite/i,
    /password/i,
    /project.*membership/i,
    /membership.*project/i,
    /role.*assign/i,
    /access.*policy.*bind/i,
    /baa/i,
    /legal/i,
    /deploy.*approve/i,
    /break.*glass/i,
  ];

  for (const toolName of toolNames) {
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(toolName),
        false,
        `Mandate 8 boundary: MCP tool ${toolName} matches forbidden auth-flow pattern ${pattern}.`,
      );
    }
  }
});

test("Mandate 8 boundary: MCP exposes no ProjectMembership write tool", () => {
  const toolNames = listMcpToolNames();
  assert.equal(toolNames.some((toolName) => /project.*membership|membership.*project/i.test(toolName)), false);
});

test("Mandate 8 boundary: MCP exposes no break-glass invocation tool", () => {
  const toolNames = listMcpToolNames();
  assert.equal(toolNames.some((toolName) => /break.*glass/i.test(toolName)), false);
});

test("Mandate 8 boundary: MCP exposes no legal or deploy approval tool", () => {
  const toolNames = listMcpToolNames();
  assert.equal(toolNames.some((toolName) => /baa|legal|deploy.*approve/i.test(toolName)), false);
});

test("Mandate 8 boundary: agent direct Binary POST bypass is rejected by parser guard", () => {
  assert.throws(
    () =>
      prepareBinaryForParserCreate(
        { resourceType: "Binary", contentType: "image/jpeg", data: "AA==" },
        { source: "agent-direct-fhir", anchorReference: "Patient/patient-1" },
      ),
    /Mandate 8 boundary/,
  );
});

test("Mandate 8 boundary: MCP exposes no audit-session or audit-row mutation tools", () => {
  const toolNames = listMcpToolNames();
  const forbiddenToolNames = [
    "read_audit_session",
    "get_audit_session",
    "read_audit_event_session_id",
    "update_osod_audit_event",
    "delete_osod_audit_event",
    "truncate_osod_audit_events",
  ];

  for (const forbidden of forbiddenToolNames) {
    assert.equal(
      toolNames.includes(forbidden),
      false,
      `Mandate 8 boundary: MCP must not expose ${forbidden}.`,
    );
  }
});

test("Mandate 8 boundary: MCP exposes no backup, restore, or DR drill tools", () => {
  const toolNames = listMcpToolNames();
  const forbiddenPatterns = [
    /backup/i,
    /restore/i,
    /dr.*drill/i,
    /disaster.*recovery/i,
  ];

  for (const toolName of toolNames) {
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(toolName),
        false,
        `Mandate 8 boundary: MCP tool ${toolName} matches operator-only pattern ${pattern}.`,
      );
    }
  }
});

test("Mandate 8 boundary: MCP cannot read another user's audit session_id", () => {
  const row = buildOsodAuditEventRow({
    eventType: "read",
    actorId: "clinician-2",
    actorRole: "clinician",
    patientId: "patient-x",
    sessionId: "other-session",
    actionOutcome: "granted",
  });

  assert.throws(
    () =>
      assertAuditSessionVisible({
        callerRole: "clinician",
        callerActorId: "clinician-1",
        row,
      }),
    /Mandate 8 boundary/,
  );
});

test("Mandate 8 boundary: MCP cannot modify osod_audit_events rows", () => {
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "UPDATE", dbRole: "app" }),
    /permission denied/,
  );
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "DELETE", dbRole: "superuser" }),
    /trigger guard/,
  );
});

test("Mandate 8 boundary: scribe-write emits preliminary and cannot directly finalize", () => {
  const toolNames = listMcpToolNames();
  assert.equal(toolNames.includes("scribe_write_observation"), true);

  const draft = buildScribeDraftObservation({
    patient_id: "patient-x",
    encounter_id: "encounter-x",
    intended_observation_type: "Scribe draft",
    text: "Draft text from local transcription.",
    scribe_id: "scribe-1",
  });
  assert.equal(draft.status, "preliminary");
  assert.equal(draft.performer?.[0]?.reference, "Practitioner/scribe-1");

  assert.equal(
    scribeWriteObservationSchema.safeParse({
      patient_id: "patient-x",
      encounter_id: "encounter-x",
      intended_observation_type: "Scribe draft",
      text: "Draft text from local transcription.",
      scribe_id: "scribe-1",
      status: "final",
    }).success,
    false,
  );
});

test("Mandate 8 boundary: clinician attestation cannot cross-sign for another clinician", () => {
  const toolNames = listMcpToolNames();
  assert.equal(toolNames.includes("clinician_attest_observation"), true);

  assert.throws(
    () =>
      assertClinicianSessionMatches({
        clinicianId: "clinician-b",
        sessionPractitionerId: "clinician-a",
      }),
    /Mandate 8 boundary \+ ledger row 20/,
  );
});

test("Mandate 8 boundary: setup wizard is interactive and refuses unattended agent context", () => {
  assert.throws(
    () =>
      assertInteractiveSetupWizardAllowed({
        env: { OSOD_UNATTENDED_AGENT: "true" } as NodeJS.ProcessEnv,
        hasTty: true,
      }),
    /interactive setup wizard/,
  );
  assert.throws(
    () =>
      assertInteractiveSetupWizardAllowed({
        env: {} as NodeJS.ProcessEnv,
        hasTty: false,
      }),
    /soul\.md security policy/,
  );
  assert.throws(
    () =>
      assertInteractiveSetupWizardAllowed({
        env: { OSOD_SETUP_INTERACTIVE_ACK: "human-supervised" } as NodeJS.ProcessEnv,
        hasTty: true,
        parentCommand: "cron",
      }),
    /human at the keyboard/,
  );
  assert.doesNotThrow(() =>
    assertInteractiveSetupWizardAllowed({
      env: { OSOD_SETUP_INTERACTIVE_ACK: "human-supervised" } as NodeJS.ProcessEnv,
      hasTty: false,
    }),
  );
});

test("Mandate 8 boundary: preflight linter network surface is local and never auth-flow navigation", () => {
  assert.doesNotThrow(() =>
    assertPreflightNetworkSurface([
      "http://localhost:8103/healthcheck",
      "http://127.0.0.1:8103/fhir/R4/metadata",
      "http://medplum-server:8103/healthcheck",
    ]),
  );
  assert.throws(
    () => assertPreflightNetworkSurface(["https://example.com/fhir/R4/Patient"]),
    /local-only/,
  );
  assert.throws(
    () => assertPreflightNetworkSurface(["http://localhost:8103/auth/login"]),
    /login, recovery, or password-change/,
  );
  assert.throws(
    () => assertPreflightNetworkSurface(["http://localhost:8103/password/change"]),
    /login, recovery, or password-change/,
  );
  assert.throws(
    () => assertPreflightNetworkSurface(["http://localhost:8103/account-recovery"]),
    /login, recovery, or password-change/,
  );
});

function listMcpToolNames(): string[] {
  const source = readFileSync(MCP_INDEX, "utf8");
  return Array.from(source.matchAll(/name:\s*"([^"]+)"/g), (match) => match[1]);
}
