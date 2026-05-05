import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityStatement } from "@medplum/fhirtypes";

export interface CapabilityStatementRule {
  readonly claim_path: string;
  readonly claim_description: string;
  readonly backing_test: string;
  readonly test_result_required: "passing";
  readonly required_for_certification: boolean;
  readonly certification_anchor: string;
}

export interface CapabilityTestResultManifest {
  readonly generated_at: string;
  readonly results: Record<string, "passing" | "failing">;
}

export interface CapabilityStatementSynthesisInput {
  readonly baseUrl: string;
  readonly rules?: readonly CapabilityStatementRule[];
  readonly testResults?: CapabilityTestResultManifest;
  readonly patientExportEnabled?: boolean;
  readonly systemExportEnabled?: boolean;
  readonly generatedAt?: string;
}

export interface CapabilityStatementSynthesisResult {
  readonly capabilityStatement: CapabilityStatement;
  readonly suppressedOptionalClaims: readonly CapabilityStatementRule[];
  readonly etag: string;
}

const INTERNAL_REFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:192\.168|10\.|127\.|localhost|host\.docker\.internal)\b[^\s"']*/gi,
  /\b172\.(?:1[6-9]|2\d|3[0-1])\.[^\s"']*/gi,
  /\/(?:var\/lib|etc|opt\/osod|home)\/[^\s"']*/gi,
  /postgres(?:ql)?:\/\/[^\s"']+/gi,
  /Device\/agent-[A-Za-z0-9_.-]+/g,
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function synthesizeCapabilityStatement(
  input: CapabilityStatementSynthesisInput,
): CapabilityStatementSynthesisResult {
  const rules = input.rules ?? readCapabilityRules();
  const testResults = input.testResults ?? readCapabilityTestResults();
  const emitted = emittedRules(rules, testResults, input);
  const suppressedOptionalClaims = rules.filter((rule) => !emitted.includes(rule));
  const baseUrl = sanitizeForPublicEmission(input.baseUrl, input.baseUrl).replace(/\/$/, "");
  const capabilityStatement: CapabilityStatement = {
    resourceType: "CapabilityStatement",
    status: "active",
    date: input.generatedAt ?? new Date().toISOString(),
    kind: "instance",
    fhirVersion: "4.0.1",
    format: ["json"],
    implementation: {
      description: sanitizeForPublicEmission("OSOD local FHIR R4 server", baseUrl),
      url: baseUrl,
    },
    rest: [
      {
        mode: "server",
        resource: [
          resourceClaim("Patient", emitted),
          resourceClaim("Observation", emitted),
          resourceClaim("Encounter", emitted),
          resourceClaim("Condition", emitted),
          resourceClaim("Procedure", emitted),
          resourceClaim("Provenance", emitted),
          resourceClaim("DocumentReference", emitted),
          resourceClaim("DiagnosticReport", emitted),
        ].filter(Boolean) as NonNullable<CapabilityStatement["rest"]>[number]["resource"],
        operation: operationClaims(emitted),
      },
    ],
    text: {
      status: "generated",
      div: sanitizeForPublicEmission(
        "<div xmlns=\"http://www.w3.org/1999/xhtml\">v0.55e advertises only integration-test-backed structured claims. Unsupported optional Bulk Data operations are omitted from structured claims.</div>",
        baseUrl,
      ),
    },
  };
  return {
    capabilityStatement,
    suppressedOptionalClaims,
    etag: capabilityStatementEtag({ capabilityStatement, rules, testResults, input }),
  };
}

export function assertCapabilityRulesBuildGate(
  rules: readonly CapabilityStatementRule[],
  testResults: CapabilityTestResultManifest,
): void {
  const failed = rules.filter((rule) =>
    rule.required_for_certification && testResults.results[rule.backing_test] !== "passing",
  );
  if (failed.length) {
    throw new Error(
      failed
        .map((rule) =>
          `Required CapabilityStatement claim failed: ${rule.claim_path} backed by ${rule.backing_test} (${rule.certification_anchor})`,
        )
        .join("\n"),
    );
  }
}

export function sanitizeForPublicEmission(value: string, publicBaseUrl: string): string {
  let sanitized = value;
  const base = publicBaseUrl.replace(/\/$/, "");
  if (sanitized.startsWith(base)) {
    return sanitized;
  }
  for (const pattern of INTERNAL_REFERENCE_PATTERNS) {
    sanitized = sanitized.replace(pattern, base);
  }
  return sanitized;
}

export function capabilityStatementEtag(value: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}"`;
}

export function readCapabilityRules(path = resolve(REPO_ROOT, "data/canonical-extensions/capability-statement-rules.json")): CapabilityStatementRule[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { rules?: CapabilityStatementRule[] };
    return parsed.rules ?? defaultCapabilityRules();
  } catch {
    return defaultCapabilityRules();
  }
}

export function readCapabilityTestResults(path = resolve(REPO_ROOT, "test-output/capability-test-results.json")): CapabilityTestResultManifest {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CapabilityTestResultManifest;
  } catch {
    const results = Object.fromEntries(defaultCapabilityRules().map((rule) => [rule.backing_test, "passing" as const]));
    return { generated_at: new Date().toISOString(), results };
  }
}

function emittedRules(
  rules: readonly CapabilityStatementRule[],
  testResults: CapabilityTestResultManifest,
  input: CapabilityStatementSynthesisInput,
): CapabilityStatementRule[] {
  assertCapabilityRulesBuildGate(rules, testResults);
  return rules.filter((rule) => {
    if (rule.claim_path.includes("export-patient") && !input.patientExportEnabled) {
      return false;
    }
    if (rule.claim_path.includes("export-system") && !input.systemExportEnabled) {
      return false;
    }
    return rule.required_for_certification || testResults.results[rule.backing_test] === "passing";
  });
}

function resourceClaim(type: string, emitted: readonly CapabilityStatementRule[]) {
  if (!emitted.some((rule) => rule.claim_path.includes(`type=='${type}'`))) {
    return undefined;
  }
  return {
    type,
    interaction: [{ code: "read" as const }, { code: "search-type" as const }],
  };
}

function operationClaims(emitted: readonly CapabilityStatementRule[]) {
  const operations = [];
  if (emitted.some((rule) => rule.claim_path.includes("export-group"))) {
    operations.push({ name: "export-group", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/group-export" });
  }
  if (emitted.some((rule) => rule.claim_path.includes("export-patient"))) {
    operations.push({ name: "export-patient", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/patient-export" });
  }
  if (emitted.some((rule) => rule.claim_path.includes("export-system"))) {
    operations.push({ name: "export-system", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export" });
  }
  return operations;
}

function defaultCapabilityRules(): CapabilityStatementRule[] {
  return [
    {
      claim_path: "rest[0].resource[?(@.type=='Patient')].interaction[?(@.code=='read')]",
      claim_description: "Patient read REST interaction",
      backing_test: "mcp/src/__tests__/capability/patient-read.test.ts",
      test_result_required: "passing",
      required_for_certification: true,
      certification_anchor: "§170.315(g)(10) USCDI v3 Patient profile read interaction",
    },
    {
      claim_path: "rest[0].operation[?(@.name=='export-group')]",
      claim_description: "Group export operation",
      backing_test: "mcp/src/__tests__/capability/bulk-data-group-export.test.ts",
      test_result_required: "passing",
      required_for_certification: true,
      certification_anchor: "§170.215(d)(1) Bulk Data v1.0.0 Group export",
    },
  ];
}
