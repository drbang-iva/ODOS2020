import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import {
  assertSearchParameterKeys,
  FHIR_R4_SEARCH_RESULT_PARAMETERS,
  invalidSearchParameterKeys,
  MEDPLUM_5_1_8_SEARCH_PARAMETERS,
  MEDPLUM_SEARCH_PARAMETER_SOURCE,
  type ContractResourceType,
} from "./search-param-contract.js";

type SearchSpec = {
  resourceType: ContractResourceType;
  parameterKeys: string[];
};

const EXPECTED_DIRECT_SEARCH_CALLS = 81;
const DYNAMIC_FHIR_SEARCH = "dynamic-fhir-search";
const DYNAMIC_SEARCH_SPECS: Record<string, SearchSpec[] | typeof DYNAMIC_FHIR_SEARCH> = {
  "src/clinic/clinic-summary.ts:233": [
    spec("Appointment", "date", "_count", "_sort"),
    spec("Encounter", "date", "_count", "_sort"),
    spec("Task", "code", "_count", "_sort"),
    spec("Provenance", "patient", "recorded", "_count", "_sort"),
    spec("Patient", "_id", "_count"),
  ],
  "src/clinic/patient-overview.ts:407": [
    spec("Coverage", "beneficiary", "status", "_count"),
    spec("Condition", "patient", "category", "_count"),
    spec("Procedure", "patient", "_count", "_sort"),
    spec("MedicationStatement", "patient", "status", "_count"),
    spec("MedicationRequest", "patient", "status", "_count"),
    spec("Observation", "patient", "code", "_count", "_sort"),
    spec("Condition", "patient", "category", "verification-status", "code", "_count"),
    spec("Encounter", "patient", "type", "_id", "_count", "_sort"),
    spec("Provenance", "patient", "_count", "_sort"),
    spec("DocumentReference", "subject", "identifier", "_count"),
  ],
  "src/clinical-graph/iop-history-endpoint.ts:119": [spec("Observation", "subject", "code", "_count")],
  "src/clinical-graph/iop-history-endpoint.ts:120": [spec("Observation", "subject", "code", "_count")],
  "src/clinical-graph/iop-history-endpoint.ts:121": [spec("Goal", "subject", "category", "_count")],
  "src/clinical-graph/iop-history-endpoint.ts:163": [spec("Goal", "subject", "category", "_count")],
  "src/clinical-graph/protocol-store.ts:79": [spec("Basic", "code", "identifier", "_count")],
  "src/desk/day-ledger.ts:234": [
    spec("Invoice", "date", "_count", "_sort"),
    spec("PaymentReconciliation", "status", "created", "_count", "_sort"),
    spec("ChargeItem", "occurrence", "_count", "_sort"),
  ],
  "src/desk/desk-summary.ts:446": [
    spec("Appointment", "date", "_count", "_sort"),
    spec("Task", "status", "code", "business-status", "_count", "_sort"),
    spec("Claim", "_count", "_sort"),
    spec("ClaimResponse", "_count", "_sort"),
    spec("PaymentReconciliation", "_count", "_sort"),
    spec("Invoice", "_count", "_sort"),
    spec("Patient", "_id", "_count"),
  ],
  "src/fhir/wenoMappingCatalog.ts:120": [spec("Basic", "code", "_count")],
  "src/index.ts:2588": [spec("Patient", "name", "_count")],
  "src/index.ts:2629": [spec("Observation", "subject", "category", "_count")],
  "src/index.ts:2637": [spec("ChargeItem", "subject", "context", "_count")],
  "src/index.ts:2645": DYNAMIC_FHIR_SEARCH,
  "src/index.ts:4243": [spec("Observation", "subject", "code", "date", "focus", "_count", "_sort")],
  "src/index.ts:4265": [spec("Observation", "subject", "code", "date", "focus", "_count", "_sort")],
  "src/office/office-channel.ts:190": [
    spec("Communication", "category", "_count", "_sort"),
    spec("Provenance", "_tag", "recorded", "_count", "_sort"),
  ],
  "src/reporting/margin-ledger.ts:526": [
    spec("Invoice", "date", "_count", "_sort"),
    spec("PaymentReconciliation", "status", "created", "_count", "_sort"),
    spec("Claim", "_count", "_sort"),
    spec("ClaimResponse", "_count", "_sort"),
    spec("Task", "code", "_count", "_sort"),
    spec("ChargeItemDefinition", "_count"),
    spec("ChargeItem", "_id", "_count"),
  ],
  "src/reporting/reporting.ts:444": [
    spec("Invoice", "date", "_count"),
    spec("PaymentReconciliation", "created", "status", "_count"),
  ],
  "src/referral/referral-service.ts:448": [
    spec("Observation", "patient", "encounter", "_count"),
    spec("CarePlan", "patient", "encounter", "_count"),
  ],
  "src/scheduling/scheduling-service.ts:104": [
    spec("Appointment", "actor"),
    spec("HealthcareService"),
    spec("Schedule"),
  ],
};

test("contract is frozen from Medplum 5.1.8's published definition bundles", () => {
  assert.equal(MEDPLUM_SEARCH_PARAMETER_SOURCE.package, "@medplum/definitions");
  assert.equal(MEDPLUM_SEARCH_PARAMETER_SOURCE.version, "5.1.8");
  assert.equal(MEDPLUM_SEARCH_PARAMETER_SOURCE.files.length, 3);
  assert.equal(Object.keys(MEDPLUM_5_1_8_SEARCH_PARAMETERS).length, 36);
  assert.deepEqual(FHIR_R4_SEARCH_RESULT_PARAMETERS, ["_summary"]);
});

test("historical ChargeItem status search is rejected while known-valid searches pass", () => {
  assert.throws(
    () => assertSearchParameterKeys("ChargeItem", ["status"]),
    /Medplum 5\.1\.8 rejects ChargeItem\?status/,
  );
  assert.doesNotThrow(() => assertSearchParameterKeys("ChargeItem", ["subject", "context", "_count"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("ChargeItem", ["occurrence", "_count", "_sort"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("PaymentReconciliation", ["status", "created", "_sort"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("Task", ["code", "business-status", "_sort"]));
  assert.doesNotThrow(() => assertSearchParameterKeys("AccessPolicy", ["name:exact"]));
});

test("all 81 direct fhir.search call sites are statically resolved or explicitly dynamic", () => {
  const calls = collectDirectFhirSearchCalls();
  assert.equal(calls.length, EXPECTED_DIRECT_SEARCH_CALLS);
  const usedOverrides = new Set<string>();
  let dynamicEscapeHatches = 0;

  for (const call of calls) {
    if (call.resourceType && call.parameterKeys) {
      assert.ok(call.resourceType in MEDPLUM_5_1_8_SEARCH_PARAMETERS, `${call.location} searches unmapped ${call.resourceType}`);
      continue;
    }

    const override = DYNAMIC_SEARCH_SPECS[call.location];
    assert.ok(override, `${call.location} has unresolved search parameters and no contract override`);
    usedOverrides.add(call.location);
    if (override === DYNAMIC_FHIR_SEARCH) {
      dynamicEscapeHatches += 1;
    }
  }

  assert.equal(dynamicEscapeHatches, 1, "Only the user-supplied fhir_search tool may stay dynamically typed.");
  assert.deepEqual([...usedOverrides].sort(), Object.keys(DYNAMIC_SEARCH_SPECS).sort());
});

test("static audit finds zero invalid search parameters", () => {
  const violations = collectSearchSpecs().flatMap(({ location, spec: current }) =>
    invalidSearchParameterKeys(current.resourceType, current.parameterKeys).map((parameter) => ({
      location,
      resourceType: current.resourceType,
      parameter,
    })),
  );

  assert.deepEqual(violations, []);
});

test("static audit rejects a mistyped dynamic override key", () => {
  const overrides = { ...DYNAMIC_SEARCH_SPECS };
  delete overrides["src/referral/referral-service.ts:448"];
  overrides["src/referral/referral-service.ts:449"] = [
    spec("Observation", "patient", "encounter", "_count"),
  ];

  assert.throws(
    () => collectSearchSpecs(overrides),
    /src\/referral\/referral-service\.ts:448 has unresolved search parameters and no contract override/,
  );
});

function spec(resourceType: ContractResourceType, ...parameterKeys: string[]): SearchSpec {
  return { resourceType, parameterKeys };
}

function collectSearchSpecs(
  overrides: Record<string, SearchSpec[] | typeof DYNAMIC_FHIR_SEARCH> = DYNAMIC_SEARCH_SPECS,
): Array<{ location: string; spec: SearchSpec }> {
  return collectDirectFhirSearchCalls().flatMap((call) => {
    if (call.resourceType && call.parameterKeys) {
      return [{
        location: call.location,
        spec: spec(call.resourceType as ContractResourceType, ...call.parameterKeys),
      }];
    }
    const override = overrides[call.location];
    if (override === undefined) {
      throw new Error(`${call.location} has unresolved search parameters and no contract override`);
    }
    return override === DYNAMIC_FHIR_SEARCH ? [] : override.map((current) => ({
      location: call.location,
      spec: current,
    }));
  });
}

function collectDirectFhirSearchCalls(): Array<{
  location: string;
  resourceType?: string;
  parameterKeys?: string[];
}> {
  const sourceRoot = resolve(process.cwd(), "src");
  return sourceFiles(sourceRoot).flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const calls: Array<{ location: string; resourceType?: string; parameterKeys?: string[] }> = [];

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "search"
        && /(^|\.)fhir$/.test(node.expression.expression.getText(source))
      ) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        const resourceType = stringLiteral(node.arguments[0]);
        const parameterKeys = extractParameterKeys(node.arguments[1]);
        calls.push({
          location: `${relative(process.cwd(), file).replaceAll("\\", "/")}:${position.line + 1}`,
          ...(resourceType ? { resourceType } : {}),
          ...(parameterKeys ? { parameterKeys } : {}),
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
    return calls;
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return stringLiteral(node.expression);
  return undefined;
}

function extractParameterKeys(node: ts.Expression | undefined): string[] | undefined {
  if (!node) return [];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return extractParameterKeys(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = extractParameterKeys(node.whenTrue);
    const whenFalse = extractParameterKeys(node.whenFalse);
    return whenTrue && whenFalse ? [...new Set([...whenTrue, ...whenFalse])].sort() : undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const keys = node.elements.map((element) => {
      if (!ts.isArrayLiteralExpression(element)) return undefined;
      return stringLiteral(element.elements[0] as ts.Expression | undefined);
    });
    return keys.every((key): key is string => key !== undefined) ? [...new Set(keys)].sort() : undefined;
  }
  if (!ts.isObjectLiteralExpression(node)) return undefined;

  const keys: string[] = [];
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadKeys = extractParameterKeys(property.expression);
      if (!spreadKeys) return undefined;
      keys.push(...spreadKeys);
      continue;
    }
    const name = propertyName(property.name);
    if (!name) return undefined;
    keys.push(name);
  }
  return [...new Set(keys)].sort();
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return stringLiteral(name.expression);
  return undefined;
}
