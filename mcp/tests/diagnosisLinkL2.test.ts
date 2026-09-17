import { randomUUID } from "node:crypto";
import { FINDING_PANEL_SYSTEM, SUPPORTS_DIAGNOSIS_URL, currentFindingIdentifier, findingPanelIdentifier, parseCurrentFindingEnvelope, type CurrentFindingKey } from "../src/clinical-graph/current-finding-identity.js";
import { canonicalFact, keyFor } from "./fixtures/r10/writer-harness.js";
import { comp, snapshot } from "./fixtures/r10/factories.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Basic, Bundle, Condition, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import ts from "typescript";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { handleCupDiscCaptureRequest } from "../src/clinical-graph/cup-disc-endpoint.js";
import {
  handleCustomSectionCaptureRequest as captureCustomSection,
  handleCustomSectionHistoryRequest,
} from "../src/clinical-graph/custom-section-endpoint.js";
import {
  deduplicateDiagnosisCandidates,
  handleDiagnosisCandidatesRequest,
} from "../src/clinical-graph/diagnosis-candidates-endpoint.js";
import { handleDiagnosisOrderRequest } from "../src/clinical-graph/diagnosis-order-endpoint.js";
import { buildDiagnosisCatalogSeeds } from "../src/clinical-graph/diagnosis-catalog-store.js";
import { FAMILY_RESOLUTION_MODES } from "../src/clinical-graph/diagnosis-catalog-seeds.js";
import {
  buildEntranceFindingDefinitions,
  VISUAL_FIELD_DEFECT_KEY,
  VISUAL_FIELD_DESCRIPTOR_FIELD,
  visualFieldDescriptorResolution,
} from "../src/clinical-graph/entrance-definition.js";
import * as diagnosisPickEndpoint from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import {
  DX_PICK_TALLY_CODE,
  DX_PICK_TALLY_CODE_SYSTEM,
  FhirDiagnosisPickTallyStore,
} from "../src/clinical-graph/diagnosis-pick-tally-store.js";
import {
  buildFindingDefinitionSeeds,
  FhirFindingDefinitionStore,
} from "../src/clinical-graph/finding-definition-store.js";
import {
  createDiagnosisCandidateSchema,
  evaluateMappingTrigger,
  matchingQualifierGroups,
  updateDiagnosisCandidateSchema,
} from "../src/clinical-graph/diagnosis-mapping.js";
import {
  buildGlaucomaFindingDefinitionStubs,
  captureGlaucomaFinding,
  evaluateGlaucomaDiagnosisSuggestions,
  evaluateIopDiagnosisSuggestions,
  GLAUCOMA_FINDING_DEFINITION_KEYS,
  type ClinicalGraphProvenance,
  type FindingInstance,
} from "../src/clinical-graph/glaucoma-suspect.js";
import { handleEomCaptureRequest } from "../src/clinical-graph/eom-endpoint.js";
import {
  buildRefractionFindingDefinitionStub,
  evaluateRefractiveErrorSuggestions,
} from "../src/clinical-graph/refraction-suspect.js";

const { handleDiagnosisPickRequest } = diagnosisPickEndpoint;

async function captureCustomSectionFixture(
  deps: Parameters<typeof captureCustomSection>[0],
  input: Parameters<typeof captureCustomSection>[1],
) {
  const definitions = deps.findingDefinitions?.() ??
    await new FhirFindingDefinitionStore((await deps.authenticate(input.authHeader))!.fhir).list();
  const definition = definitions.find(row => row.stableKey === (input.params as { stableKey: string }).stableKey);
  const body = input.body as {
    patientReference: string;
    encounterReference: string;
    commandId?: string;
    eyes?: Record<string, {
      customFields?: Array<{ code: string; value: unknown }>;
      findingDetails?: Record<string, Record<string, unknown>>;
    }>;
  };
  if (definition?.valueSchema.type !== "ocular-health-structure" || body.commandId) return captureCustomSection(deps, input);
  const eyes = Object.fromEntries(Object.entries(body.eyes ?? {}).map(([eye, row]) => [eye, {
    loaded: [],
    selected: (row.customFields ?? []).flatMap(field => {
      assert.ok(Array.isArray(field.value), "Shared clinical fixture must supply checkbox options explicitly.");
      return field.value.map(optionCode => {
        const key = {
          v: 1 as const,
          patientId: body.patientReference.slice(8),
          encounterId: body.encounterReference.slice(10),
          stableKey: definition.stableKey,
          fieldCode: field.code,
          optionCode,
          eye,
        };
        return { key, baseline: { kind: "absent", key }, presence: "present", qualifiers: row.findingDetails?.[optionCode] ?? {}, homes: [] };
      });
    }),
  }]));
  return captureCustomSection(deps, {
    ...input,
    body: { commandId: randomUUID(), patientReference: body.patientReference, encounterReference: body.encounterReference, eyes },
  });
}

test("staff diagnosis pick refuses all actions with zero writes", async (t) => {
  for (const action of ["possible", "confirm", "discard"] as const) {
    await t.test(action, async () => {
      const fhir = diagnosisPickFhir();
      const before = structuredClone(fhir.resources);
      const result = await handleDiagnosisPickRequest({
        authenticate: async () => ({ staffReference: "Practitioner/staff", actorRole: "staff", fhir }),
      }, {
        authHeader: "Bearer staff", params: { encounterId: "e1" },
        body: { diagnosisKey: "presbyopia", action, source: "catalog-search" },
      });
      assert.equal(fhir.writes.length, 0);
      assert.equal(fhir.transactions.length, 0);
      assert.deepEqual(fhir.resources, before);
      assert.equal(result.status, 403);
    });
  }
});

const GLAUCOMA_RULE_FINDING_KEYS_NOT_YET_EXERCISED = new Set([
  "corneal_hysteresis",
  "pachymetry_um",
  "rnfl_gcc",
]);
const RULE_CATALOG_KEYS_NOT_YET_EXERCISED = new Set<string>();

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function parseSource(sourceUrl: URL): ts.SourceFile {
  const sourcePath = fileURLToPath(sourceUrl);
  return ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function stringUnionMembers(source: ts.SourceFile, aliasName: string): string[] {
  const declaration = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === aliasName
  );
  assert.ok(declaration, `Missing evaluator declaration ${aliasName}.`);
  const members = ts.isUnionTypeNode(declaration.type) ? declaration.type.types : [declaration.type];
  const values = members.flatMap((member) =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteralLike(member.literal) ? [member.literal.text] : []
  );
  assert.equal(values.length, members.length, `${aliasName} must remain an enumerable string-literal union.`);
  return values;
}

function catalogKeyForRuleDeclaration(): {
  resolve(stableKey: string): string;
  declaredCatalogKeys: string[];
} {
  const source = parseSource(new URL("../src/clinical-graph/diagnosis-candidates-endpoint.ts", import.meta.url));
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "catalogKeyForRule"
  );
  assert.ok(declaration?.body, "Missing catalogKeyForRule declaration.");

  const declaredCatalogKeys = new Set<string>();
  const enumeratedLoopVariables = new Set<string>();
  const unsupportedReturns: string[] = [];
  const stableKeyParameter = declaration.parameters[0]?.name;
  assert.ok(stableKeyParameter && ts.isIdentifier(stableKeyParameter));
  const arrayValues = (expression: ts.Expression): string[] => {
    let unwrapped = expression;
    while (ts.isAsExpression(unwrapped) || ts.isSatisfiesExpression(unwrapped) || ts.isParenthesizedExpression(unwrapped)) {
      unwrapped = unwrapped.expression;
    }
    return ts.isArrayLiteralExpression(unwrapped)
      ? unwrapped.elements.flatMap((element) => ts.isStringLiteralLike(element) ? [element.text] : [])
      : [];
  };
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const variable = node.initializer.declarations[0]?.name;
      const values = arrayValues(node.expression);
      if (variable && ts.isIdentifier(variable) && values.length > 0) {
        let returnsVariable = false;
        const inspectLoop = (child: ts.Node): void => {
          if (ts.isReturnStatement(child) && child.expression && ts.isIdentifier(child.expression) &&
              child.expression.text === variable.text) {
            returnsVariable = true;
          }
          ts.forEachChild(child, inspectLoop);
        };
        inspectLoop(node.statement);
        if (returnsVariable) {
          enumeratedLoopVariables.add(variable.text);
          values.forEach((value) => declaredCatalogKeys.add(value));
        }
      }
    }
    if (ts.isReturnStatement(node) && node.expression) {
      if (ts.isStringLiteralLike(node.expression)) {
        declaredCatalogKeys.add(node.expression.text);
      } else if (!ts.isIdentifier(node.expression) ||
          (node.expression.text !== stableKeyParameter.text && !enumeratedLoopVariables.has(node.expression.text))) {
        unsupportedReturns.push(node.expression.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  assert.deepEqual(
    unsupportedReturns,
    [],
    `catalogKeyForRule gained non-enumerable return declarations: ${unsupportedReturns.join(", ")}`,
  );

  const transpiled = ts.transpileModule(
    `${declaration.getText(source)}\nmodule.exports.catalogKeyForRule = catalogKeyForRule;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const loaded = { exports: {} as { catalogKeyForRule?: (stableKey: string) => string } };
  const evaluate = new Function("module", "exports", transpiled) as (
    module: typeof loaded,
    exports: typeof loaded.exports,
  ) => void;
  evaluate(loaded, loaded.exports);
  assert.equal(typeof loaded.exports.catalogKeyForRule, "function");

  return {
    resolve: loaded.exports.catalogKeyForRule!,
    declaredCatalogKeys: sortedUnique([...declaredCatalogKeys]),
  };
}

function declaredRuleCatalogKeys(resolve: (stableKey: string) => string): string[] {
  const glaucomaSource = parseSource(new URL("../src/clinical-graph/glaucoma-suspect.ts", import.meta.url));
  const refractionSource = parseSource(new URL("../src/clinical-graph/refraction-suspect.ts", import.meta.url));
  const cupDiscKeys = stringUnionMembers(glaucomaSource, "GlaucomaCupDiscRiskTier")
    .filter((tier) => tier !== "normal")
    .map((tier) => resolve(`glaucoma_suspect_open_angle_${tier}_od`));
  const iopKeys = stringUnionMembers(glaucomaSource, "GlaucomaIopRiskTier")
    .filter((tier) => tier !== "normal")
    .map(() => resolve("ocular_hypertension_od"));
  const refractiveKeys = stringUnionMembers(refractionSource, "RefractiveDiagnosisKind")
    .map((kind) => resolve(`${kind}_od`));
  return sortedUnique([...cupDiscKeys, ...iopKeys, ...refractiveKeys]);
}

function assertDeclaredInventory(
  label: string,
  declaredValues: readonly string[],
  exercisedValues: ReadonlySet<string>,
  notYetExercisedValues: ReadonlySet<string>,
): void {
  const declared = new Set(declaredValues);
  const unexpectedExercises = sortedUnique([...exercisedValues].filter((key) => !declared.has(key)));
  const staleDeferrals = sortedUnique([...notYetExercisedValues].filter((key) => !declared.has(key)));
  const exercisedDeferrals = sortedUnique([...notYetExercisedValues].filter((key) => exercisedValues.has(key)));
  const unaccountedDeclarations = sortedUnique(declaredValues.filter((key) =>
    !exercisedValues.has(key) && !notYetExercisedValues.has(key)
  ));

  assert.deepEqual(unexpectedExercises, [], `${label} fixtures exercised undeclared keys: ${unexpectedExercises.join(", ")}`);
  assert.deepEqual(staleDeferrals, [], `${label} not-yet-exercised list names undeclared keys: ${staleDeferrals.join(", ")}`);
  assert.deepEqual(exercisedDeferrals, [], `${label} keys cannot be both exercised and not-yet-exercised: ${exercisedDeferrals.join(", ")}`);
  assert.deepEqual(unaccountedDeclarations, [], `${label} declarations are unaccounted: ${unaccountedDeclarations.join(", ")}`);
}

test("condition code resolution returns zero, one, or two codes only when the catalog declaration permits it", () => {
  const resolve = (diagnosisPickEndpoint as typeof diagnosisPickEndpoint & {
    resolveConditionCodes?: (
      row: ReturnType<typeof buildDiagnosisCatalogSeeds>[number],
      laterality: "right" | "left" | "bilateral" | undefined,
    ) => string[];
  }).resolveConditionCodes;
  assert.equal(typeof resolve, "function");
  const rows = buildDiagnosisCatalogSeeds();
  const mgd = rows.find((row) => row.stableKey === "meibomian_gland_dysfunction")!;
  const myopia = rows.find((row) => row.stableKey === "myopia")!;
  const uncoded = { ...myopia, icd10: undefined, icd10Code: undefined, codingStatus: "provisional" as const };

  assert.deepEqual(resolve!(uncoded, "bilateral"), []);
  assert.deepEqual(resolve!(myopia, "bilateral"), ["H52.13"]);
  assert.deepEqual(resolve!(mgd, "bilateral"), ["H02.88A", "H02.88B"]);
  assert.deepEqual(resolve!({ ...mgd, bilateralResolution: undefined }, "bilateral"), []);
});

test("staged POAG picks persist the chosen member code and keep different per-eye stages separate", async () => {
  const fhir = diagnosisPickFhir();
  const authenticate = async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider" as const, fhir });
  const mildOd = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "poag_mild", action: "confirm", laterality: "OD", source: "catalog-search" },
  });
  const moderateOs = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "poag_moderate", action: "confirm", laterality: "OS", source: "catalog-search" },
  });

  assert.equal(mildOd.status, 200, JSON.stringify(mildOd.body));
  assert.equal(moderateOs.status, 200, JSON.stringify(moderateOs.body));
  assert.equal((mildOd.body as { condition: Condition }).condition.code?.coding?.[0]?.code, sourcedDiagnosisCode("poag_mild", "right"));
  assert.equal((moderateOs.body as { condition: Condition }).condition.code?.coding?.[0]?.code, sourcedDiagnosisCode("poag_moderate", "left"));
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(conditions.length, 2);
  assert.deepEqual(conditions.map((condition) => condition.identifier?.[0]?.value), [
    "e1::poag_mild::right",
    "e1::poag_moderate::left",
  ]);
});

test("Stage later persists a staged family Condition with no ICD-10-CM coding", async () => {
  const fhir = diagnosisPickFhir();
  const result = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      diagnosisKey: "primary-open-angle-glaucoma",
      action: "confirm",
      laterality: "OD",
      source: "catalog-search",
      stageDeferred: true,
    },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const condition = (result.body as { condition: Condition }).condition;
  assert.deepEqual(condition.identifier?.map((identifier) => identifier.value), ["e1::primary-open-angle-glaucoma::right"]);
  assert.equal(condition.code?.text, "Primary open-angle glaucoma");
  assert.equal(condition.code?.coding?.some((coding) => coding.system === "http://hl7.org/fhir/sid/icd-10-cm") ?? false, false);
});

test("Stage later cannot duplicate an existing same-eye staged member Condition", async () => {
  const fhir = diagnosisPickFhir();
  const authenticate = async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider" as const, fhir });
  const confirmed = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "poag_mild", action: "confirm", laterality: "OD", source: "catalog-search" },
  });
  const deferred = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      diagnosisKey: "primary-open-angle-glaucoma",
      action: "confirm",
      laterality: "OD",
      source: "catalog-search",
      stageDeferred: true,
    },
  });

  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(deferred.status, 409, JSON.stringify(deferred.body));
  assert.deepEqual(deferred.body, {
    result: "invalid", reason: "invalid-pick",
    error: "A staged diagnosis already exists for primary-open-angle-glaucoma right. Re-stage the existing diagnosis instead.",
  });
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0]?.code?.coding?.[0]?.code, sourcedDiagnosisCode("poag_mild", "right"));
  assert.deepEqual(conditions[0]?.identifier?.map((identifier) => identifier.value), ["e1::poag_mild::right"]);
});

test("a member pick completes the same-eye pending family Condition instead of creating a duplicate", async () => {
  const fhir = diagnosisPickFhir();
  const authenticate = async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider" as const, fhir });
  const deferred = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      diagnosisKey: "primary-open-angle-glaucoma",
      action: "confirm",
      laterality: "OD",
      source: "catalog-search",
      stageDeferred: true,
    },
  });
  const completed = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "poag_mild", action: "confirm", laterality: "OD", source: "catalog-search" },
  });

  assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const deferredCondition = (deferred.body as { condition: Condition }).condition;
  const completedCondition = (completed.body as { condition: Condition }).condition;
  assert.equal(completedCondition.id, deferredCondition.id);
  assert.equal(completedCondition.code?.coding?.[0]?.code, sourcedDiagnosisCode("poag_mild", "right"));
  assert.deepEqual(completedCondition.identifier?.map((identifier) => identifier.value), ["e1::poag_mild::right"]);
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Condition").length, 1);
});

test("discarding an absent staged member cannot refute a same-eye pending family Condition", async () => {
  const fhir = diagnosisPickFhir();
  const authenticate = async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider" as const, fhir });
  const deferred = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      diagnosisKey: "primary-open-angle-glaucoma",
      action: "confirm",
      laterality: "OD",
      source: "catalog-search",
      stageDeferred: true,
    },
  });
  const discarded = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "poag_mild", action: "discard", laterality: "OD", source: "catalog-search" },
  });

  assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
  assert.equal(discarded.status, 404, JSON.stringify(discarded.body));
  const condition = fhir.resources.find((resource): resource is Condition => resource.resourceType === "Condition")!;
  assert.equal(condition.verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.deepEqual(condition.identifier?.map((identifier) => identifier.value), ["e1::primary-open-angle-glaucoma::right"]);
});

test("all three eyelid families write both-lids OD and OS codes and resolve OU without the false 422", async () => {
  const cases = [
    ["ulcerative_blepharitis", "H01.01A", "H01.01B"],
    ["squamous_blepharitis", "H01.02A", "H01.02B"],
    ["meibomian_gland_dysfunction", "H02.88A", "H02.88B"],
  ] as const;

  for (const [diagnosisKey, right, left] of cases) {
    for (const [laterality, expected] of [["OD", right], ["OS", left]] as const) {
      const fhir = diagnosisPickFhir();
      const result = await handleDiagnosisPickRequest({
        authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
      }, {
        authHeader: "Bearer doctor-1",
        params: { encounterId: "e1" },
        body: { diagnosisKey, action: "confirm", laterality },
      });
      assert.equal(result.status, 200, `${diagnosisKey} ${laterality}: ${JSON.stringify(result.body)}`);
      const condition = (result.body as { condition: Condition }).condition;
      assert.deepEqual(condition.code, {
        coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: expected, display: condition.code?.text }],
        text: condition.code?.text,
      });
    }

    const fhir = diagnosisPickFhir();
    const bilateral = await handleDiagnosisPickRequest({
      authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "e1" },
      body: { diagnosisKey, action: "confirm", laterality: "OU" },
    });
    assert.equal(bilateral.status, 200, `${diagnosisKey} OU: ${JSON.stringify(bilateral.body)}`);
    const condition = (bilateral.body as { condition: Condition }).condition;
    assert.deepEqual(condition.code, {
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/diagnosis-catalog",
        code: diagnosisKey,
        display: condition.code?.text,
      }],
      text: condition.code?.text,
    });
    assert.equal(condition.identifier?.find((identifier) =>
      identifier.system === "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key"
    )?.value, `e1::${diagnosisKey}::bilateral`);
    assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Condition").length, 1);
  }
});

test("allOf mapping triggers require every nested option trigger", () => {
  const trigger = { kind: "allOf" as const, triggers: [
    { kind: "option" as const, field: "binocular", anyOf: ["yes"] },
    { kind: "option" as const, field: "incomitant", anyOf: ["yes"] },
  ] };
  const finding = (components: Array<{ code: string; display: string; value: number | string | boolean }>): FindingInstance => ({
    id: "eom-finding", state: "committed", presence: "present", findingDefinitionId: "finding-def-entrance-eom",
    patientReference: "Patient/p1", encounterReference: "Encounter/e1", laterality: "OU",
    value: { type: "components", components }, sourceType: "manual", recordedAt: "2026-07-22T12:00:00.000Z",
    provenance: { source: "manual", recordedAt: "2026-07-22T12:00:00.000Z" },
  });
  assert.equal(evaluateMappingTrigger(trigger, finding([
    { code: "binocular::yes", display: "binocular", value: true },
    { code: "incomitant::yes", display: "incomitant", value: true },
  ])), true);
  assert.equal(evaluateMappingTrigger(trigger, finding([{ code: "binocular::yes", display: "binocular", value: true }])), false);
  assert.equal(evaluateMappingTrigger(trigger, finding([{ code: "incomitant::yes", display: "incomitant", value: true }])), false);
});

test("EOM binocular plus incomitant proposes diplopia and paralytic strabismus without auto-confirming", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push(testEncounter("eom", "p1"));
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const authenticate = async () => ({ staffReference: "Practitioner/doc", actorRole: "provider" as PracticeRoleId, fhir });
  const base = { patientReference: "Patient/p1", encounterReference: "Encounter/eom", state: "abnormal" as const, eyes: { OD: { primary: "-1" as const } }, nystagmus: { present: false } };
  const firing = await handleEomCaptureRequest({ authenticate, findingDefinitions: () => definitions, now: () => "2026-07-22T12:00:00.000Z" }, { authHeader: "Bearer eom", body: { ...base, diplopia: { present: true, type: "binocular", direction: "horizontal", comitancy: "incomitant", worstGaze: "right", frequency: "intermittent" } } });
  assert.equal(firing.status, 200, JSON.stringify(firing.body));
  const nonFiring = await handleEomCaptureRequest({ authenticate, findingDefinitions: () => definitions, now: () => "2026-07-22T12:01:00.000Z" }, { authHeader: "Bearer eom", body: { ...base, diplopia: { present: true, type: "binocular", direction: "horizontal", comitancy: "comitant", worstGaze: "right", frequency: "intermittent" } } });
  assert.equal(nonFiring.status, 200, JSON.stringify(nonFiring.body));
  const untouchedDiplopia = await handleEomCaptureRequest({ authenticate, findingDefinitions: () => definitions, now: () => "2026-07-22T12:01:30.000Z" }, { authHeader: "Bearer eom", body: { ...base, diplopia: { present: false } } });
  assert.equal(untouchedDiplopia.status, 200, JSON.stringify(untouchedDiplopia.body));
  const candidates = await handleDiagnosisCandidatesRequest({ authenticate, now: () => "2026-07-22T12:02:00.000Z" }, { authHeader: "Bearer eom", params: { encounterId: "eom" } });
  const findings = (candidates.body as { findings: Array<{ candidates: Array<{ diagnosisKey: string }> }> }).findings;
  assert.deepEqual(findings[0]?.candidates.map((row) => row.diagnosisKey), ["diplopia", "paralytic_strabismus"]);
  assert.deepEqual(findings[1]?.candidates, []);
  assert.deepEqual(findings[2]?.candidates, []);
  assert.equal(fhir.resources.some((row) => row.resourceType === "Condition"), false);
});

class MemoryFhir {
  readonly baseUrl = "http://localhost:8103/";
  readonly resources: Resource[] = [];
  readonly writes: Array<{ operation: "create" | "update"; resourceType: string; id: string; headers?: Record<string, string> }> = [];
  readonly searches: Array<{ resourceType: string; params: Record<string, string> }> = [];
  readonly transactions: Array<{ bundle: Bundle; headers?: Record<string, string>; options?: { autoRollbackCreatedEntries?: boolean } }> = [];

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params: { ...params } });
    const resources = this.resources.filter((resource) => resource.resourceType === resourceType).filter((resource) => {
      if (params._tag && !params._tag.split(",").some(token=>resource.meta?.tag?.some(tag=>`${tag.system}|${tag.code}`===token))) return false;
      if (params.identifier && !(resource as Observation).identifier?.some(identifier=>`${identifier.system}|${identifier.value}`===params.identifier)) return false;
      if (resourceType === "Provenance" && params.target && !(resource as Provenance).target.some(target=>target.reference===params.target)) return false;
      if (resourceType === "Basic") {
        const basic = resource as Basic;
        if (params.code && !basic.code?.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code)) return false;
        if (params.identifier && !basic.identifier?.some((identifier) => `${identifier.system}|${identifier.value}` === params.identifier)) return false;
      }
      if (resourceType === "Observation" && params.encounter) return (resource as Observation).encounter?.reference === params.encounter;
      if (resourceType === "Condition" && params.encounter) return (resource as Condition).encounter?.reference === params.encounter;
      if (resourceType === "Condition" && params.subject) return (resource as Condition).subject?.reference === params.subject;
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })) };
  }

  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const existing = this.conditionalResource(resource,headers);
    if (existing) return structuredClone(existing);
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}`;
    const persisted = { ...resource, id, meta: { ...(resource.meta ?? {}), versionId: "1", lastUpdated: "2026-07-11T16:00:00.000Z" } } as T;
    this.resources.push(persisted);
    this.writes.push({ operation: "create", resourceType: resource.resourceType, id, headers });
    return structuredClone(persisted);
  }

  private conditionalResource<T extends Resource>(resource:T,headers?:Record<string,string>):T | undefined {
    const query=headers?.["If-None-Exist"];if(!query)return undefined;
    const params=new URLSearchParams(query);
    const matches=this.resources.filter(candidate=>candidate.resourceType===resource.resourceType && [...params].every(([name,value])=>
      name==="identifier" ? (candidate as Observation).identifier?.some(i=>`${i.system}|${i.value}`===value) :
      name==="_tag" ? candidate.meta?.tag?.some(t=>`${t.system}|${t.code}`===value) : false));
    if(matches.length>1)throw Object.assign(new Error("Conditional create has multiple matches."),{status:412});
    return matches[0] as T | undefined;
  }

  async createWithOutcome<T extends Resource>(resource:T,headers?:Record<string,string>):Promise<{resource:T;created:boolean}> {
    const existing=this.conditionalResource(resource,headers);
    if(existing)return {resource:structuredClone(existing),created:false};
    const saved=await this.create(resource,headers);return {resource:saved,created:true};
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const current = this.resources[index]!;
    const ifMatch = headers?.["If-Match"]?.match(/\"(.+)\"/)?.[1];
    if (ifMatch && ifMatch !== current.meta?.versionId) {
      const error = new Error("FHIR 412 Precondition Failed") as Error & { status?: number };
      error.status = 412;
      throw error;
    }
    const versionId = String(Number(current.meta?.versionId ?? "0") + 1);
    const lastUpdated = new Date(Date.parse("2026-07-11T16:00:00.000Z") + Number(versionId) * 60_000).toISOString();
    const persisted = { ...resource, id, meta: { ...(resource.meta ?? {}), versionId, lastUpdated } } as T;
    this.resources[index] = persisted;
    this.writes.push({ operation: "update", resourceType, id, headers });
    return structuredClone(persisted);
  }

  async executeTransaction(
    bundle: Bundle,
    headers?: Record<string, string>,
    options?: { autoRollbackCreatedEntries?: boolean },
  ): Promise<Bundle> {
    this.transactions.push({ bundle: structuredClone(bundle), headers, options });
    const resourcesBefore = structuredClone(this.resources);
    const writesBefore = structuredClone(this.writes);
    const references = new Map<string, string>();
    try {
      const responseEntries = [];
      for (const entry of bundle.entry ?? []) {
        const request = entry.request;
        if (!request || !entry.resource) throw new Error("Synthetic transaction entry is incomplete.");
        const resource = replaceTransactionReferences(structuredClone(entry.resource), references);
        if (request.method === "POST") {
          const writesAtStart = this.writes.length;
          const persisted = await this.create(resource, {
            ...headers,
            ...(request.ifNoneExist ? { "If-None-Exist": request.ifNoneExist } : {}),
          });
          if (entry.fullUrl && persisted.id) references.set(entry.fullUrl, `${persisted.resourceType}/${persisted.id}`);
          responseEntries.push({
            resource: persisted,
            response: { status: this.writes.length === writesAtStart ? "200 OK" : "201 Created" },
          });
        } else if (request.method === "PUT") {
          const [resourceType, id] = request.url.split("/");
          if (!resourceType || !id || resource.resourceType !== resourceType) {
            throw new Error(`Synthetic transaction PUT mismatch for ${request.url}.`);
          }
          const persisted = await this.update(resource.resourceType, id, resource, {
            ...headers,
            ...(request.ifMatch ? { "If-Match": request.ifMatch } : {}),
          });
          responseEntries.push({ resource: persisted, response: { status: "200 OK" } });
        } else {
          throw new Error(`Synthetic transaction does not support ${request.method}.`);
        }
      }
      return { resourceType: "Bundle", type: "transaction-response", entry: responseEntries };
    } catch (error) {
      this.resources.splice(0, this.resources.length, ...resourcesBefore);
      this.writes.splice(0, this.writes.length, ...writesBefore);
      throw error;
    }
  }
}

function replaceTransactionReferences<T extends Resource>(resource: T, references: ReadonlyMap<string, string>): T {
  return JSON.parse(JSON.stringify(resource), (_key, value) =>
    typeof value === "string" ? references.get(value) ?? value : value
  ) as T;
}

test("real HTTP diagnosis picks persist right-eye evidence, Provenance, isolated tally ordering, and refuted audit state", async (t) => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
    meta: { versionId: "1" },
  } as Encounter);
  const definitions = new FhirFindingDefinitionStore(fhir);
  const cupDiscDefinition = (await definitions.list()).find((row) => row.stableKey === "cup_disc_ratio")!;
  await definitions.save({
    ...cupDiscDefinition,
    diagnosisCandidates: [
      { id: "duplicate-rule", diagnosisKey: "glaucoma_suspect_open_angle_low", trigger: { kind: "always" }, priority: false, origin: "practice", active: true },
      { id: "ohtn-option", diagnosisKey: "ocular_hypertension", trigger: { kind: "always" }, priority: true, origin: "practice", active: true },
    ],
  });
  const routeDefinitions = await definitions.list();

  const authenticate = async (header: string | undefined) => {
    const practitioner = header === "Bearer doctor-1" ? "Practitioner/doctor-1" : header === "Bearer doctor-2" ? "Practitioner/doctor-2" : undefined;
    return practitioner ? { staffReference: practitioner, actorRole: "provider" as PracticeRoleId, fhir } : null;
  };
  const app = express();
  app.use(express.json());
  app.post("/clinical-graph/glaucoma/cup-disc", async (req, res) => {
    const result = await handleCupDiscCaptureRequest({ authenticate, findingDefinitions: () => routeDefinitions }, { authHeader: req.header("authorization"), body: req.body });
    res.status(result.status).json(result.body);
  });
  app.get("/clinical-graph/encounters/:encounterId/diagnosis-candidates", async (req, res) => {
    const result = await handleDiagnosisCandidatesRequest({ authenticate, now: () => "2026-07-11T16:00:00.000Z" }, { authHeader: req.header("authorization"), params: req.params });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/encounters/:encounterId/diagnosis-picks", async (req, res) => {
    const result = await handleDiagnosisPickRequest({ authenticate, now: () => "2026-07-11T16:00:00.000Z" }, { authHeader: req.header("authorization"), params: req.params, body: req.body });
    res.status(result.status).json(result.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  const capture = await post(base, "/clinical-graph/glaucoma/cup-disc", {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    eyes: { OD: { verticalCupDiscRatio: 0.6 } },
  }, "Bearer doctor-1") as { eyes: { OD: { observationReference: string } } };
  const observationReference = capture.eyes.OD.observationReference;
  const initialDoctor1 = await candidates(base, "Bearer doctor-1");
  const cupDisc = initialDoctor1.findings.find((row) => row.observationReference === observationReference)!;
  assert.deepEqual(cupDisc.candidates.map((row) => row.diagnosisKey), ["glaucoma_suspect_open_angle_low", "ocular_hypertension"]);
  assert.equal(cupDisc.candidates.filter((row) => row.diagnosisKey === "glaucoma_suspect_open_angle_low").length, 1);
  assert.equal(cupDisc.candidates[0]?.source, "rule");

  await post(base, "/clinical-graph/encounters/e1/diagnosis-picks", {
    findingInstanceId: observationReference,
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "confirm",
    source: "rule",
  }, "Bearer doctor-1", 200);
  const condition = fhir.resources.find((row): row is Condition => row.resourceType === "Condition")!;
  assert.equal(condition.verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.equal(condition.code?.coding?.[0]?.code, sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"));
  assert.equal(condition.evidence?.[0]?.detail?.[0]?.reference, observationReference);
  assert.equal(fhir.resources.some((row): row is Provenance => row.resourceType === "Provenance" &&
    row.target.some((target) => target.reference === `Condition/${condition.id}`) &&
    row.entity?.some((entity) => entity.what.reference === observationReference)), true);

  for (let index = 0; index < 2; index += 1) {
    await post(base, "/clinical-graph/encounters/e1/diagnosis-picks", {
      findingInstanceId: observationReference,
      diagnosisKey: "ocular_hypertension",
      action: index === 0 ? "possible" : "confirm",
      source: "mapping",
    }, "Bearer doctor-1", 200);
  }
  const reorderedDoctor1 = await candidates(base, "Bearer doctor-1");
  assert.equal(reorderedDoctor1.findings.find((row) => row.observationReference === observationReference)?.candidates[0]?.diagnosisKey, "ocular_hypertension");
  const unchangedDoctor2 = await candidates(base, "Bearer doctor-2");
  assert.equal(unchangedDoctor2.findings.find((row) => row.observationReference === observationReference)?.candidates[0]?.diagnosisKey, "glaucoma_suspect_open_angle_low");
  assert.equal((await new FhirDiagnosisPickTallyStore(fhir).read("Practitioner/doctor-2")), undefined);

  await post(base, "/clinical-graph/encounters/e1/diagnosis-picks", {
    diagnosisKey: "ocular_hypertension",
    action: "discard",
    laterality: "OD",
  }, "Bearer doctor-1", 200);
  const discarded = fhir.resources.find((row): row is Condition => row.resourceType === "Condition" && row.code?.text === "Ocular hypertension")!;
  assert.equal(discarded.verificationStatus?.coding?.[0]?.code, "refuted");
  assert.equal(fhir.resources.filter((row) => row.resourceType === "Basic").some((row) => (row as Basic).code.coding?.some((coding) => coding.system === DX_PICK_TALLY_CODE_SYSTEM && coding.code === DX_PICK_TALLY_CODE)), true);
});

test("OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e-oh3", status: "in-progress", meta: { versionId: "1" },
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p-oh3" },
  } as Encounter);
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "provider" as PracticeRoleId,
    fhir,
  });
  const fieldFor = (stableKey: string) => {
    const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(definition);
    const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
      .find((candidate) => candidate.valueType === "multi-select");
    assert.ok(field?.localCode);
    return { definition, localCode: field.localCode };
  };

  const cornea = fieldFor("ocular-health:anterior:cornea");
  const corneaCapture = await captureCustomSectionFixture({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-07-12T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: cornea.definition.stableKey },
    body: {
      patientReference: "Patient/p-oh3",
      encounterReference: "Encounter/e-oh3",
      eyes: { OD: { state: "abnormal", customFields: [{ code: cornea.localCode, value: ["keratoconus"] }] } },
    },
  });
  assert.equal(corneaCapture.status, 200, JSON.stringify(corneaCapture.body));
  const corneaObservation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation" &&
    parseCurrentFindingEnvelope(resource).status === "valid" &&
    resource.code.coding?.some((coding) => coding.code === `${cornea.definition.stableKey}::${cornea.localCode}::keratoconus`))!;

  const corneaCandidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-oh3" },
  });
  assert.equal(corneaCandidates.status, 200, JSON.stringify(corneaCandidates.body));
  const corneaRow = (corneaCandidates.body as CandidateResponse).findings.find((finding) =>
    finding.findingDefinitionKey === cornea.definition.stableKey);
  assert.deepEqual(corneaRow?.candidates[0]?.supportingFacts, [candidateSupport(corneaObservation)]);
  assert.deepEqual(corneaRow?.candidates.map((candidate) => candidate.diagnosisKey), [
    "keratoconus_stable",
    "keratoconus_unstable",
  ]);
  assert.equal(corneaRow?.candidates[0]?.icd10?.code, "H18.611");

  const confirmedCornea = await handleDiagnosisPickRequest({
    authenticate,
    now: () => "2026-07-12T16:01:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-oh3" },
    body: {
      commandId: randomUUID(),
      supportingFacts: corneaRow!.candidates[0].supportingFacts!.map(({ key, baseline }) => ({ key, baseline })),
      diagnosisKey: "keratoconus_stable",
      action: "confirm",
      source: "mapping",
    },
  });
  assert.equal(confirmedCornea.status, 200, JSON.stringify(confirmedCornea.body));
  const corneaCondition = fhir.resources.find((resource): resource is Condition => resource.resourceType === "Condition")!;
  assert.equal(corneaCondition.code?.coding?.[0]?.code, "H18.611");
  assert.equal((confirmedCornea.body as { link: string }).link, "pending");
  assert.equal(corneaCondition.evidence, undefined);
  assert.deepEqual(fhir.resources.find(resource => resource.resourceType === "Observation" && resource.id === corneaObservation.id), corneaObservation);

  const lids = fieldFor("ocular-health:anterior:lids-lashes");
  const lidsCapture = await captureCustomSectionFixture({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-07-12T16:02:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: lids.definition.stableKey },
    body: {
      patientReference: "Patient/p-oh3",
      encounterReference: "Encounter/e-oh3",
      eyes: {
        OD: { state: "abnormal", customFields: [{ code: lids.localCode, value: ["anterior-blepharitis", "anterior-blepharitis::ulcerative"] }] },
        OS: { state: "abnormal", customFields: [{ code: lids.localCode, value: ["anterior-blepharitis", "anterior-blepharitis::ulcerative"] }] },
      },
    },
  });
  assert.equal(lidsCapture.status, 200, JSON.stringify(lidsCapture.body));
  const lidsObservations = fhir.resources.filter((resource): resource is Observation => resource.resourceType === "Observation" &&
    resource.code.coding?.some((coding) => coding.code?.startsWith(`${lids.definition.stableKey}::`)));
  assert.equal(lidsObservations.length, 4);
  assert.deepEqual(lidsObservations.map(observation => {
    const envelope = parseCurrentFindingEnvelope(observation);
    assert.equal(envelope.status, "valid");
    return envelope.status === "valid" ? `${envelope.key.eye}:${envelope.key.optionCode}` : "invalid";
  }).sort(), ["OD:anterior-blepharitis", "OD:anterior-blepharitis::ulcerative", "OS:anterior-blepharitis", "OS:anterior-blepharitis::ulcerative"]);
  const lidsCandidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-oh3" },
  });
  assert.equal(lidsCandidates.status, 200, JSON.stringify(lidsCandidates.body));
  const lidsRows = (lidsCandidates.body as CandidateResponse).findings.filter((finding) => finding.findingDefinitionKey === lids.definition.stableKey);
  assert.equal(lidsRows.length, 2);
  assert.deepEqual(lidsRows.map((row) => row.candidates.map((candidate) => candidate.diagnosisKey)), [
    ["ulcerative_blepharitis"],
    ["ulcerative_blepharitis"],
  ]);

  for (const row of lidsRows) {
    assert.equal(row.candidates[0].supportingFacts?.length, 1);
    const support = row.candidates[0].supportingFacts![0];
    assert.equal(support.key.optionCode, "anterior-blepharitis::ulcerative");
    assert.deepEqual(support, candidateSupport(lidsObservations.find(observation => `Observation/${observation.id}` === support.baseline.reference)!));
    const result = await handleDiagnosisPickRequest({
      authenticate,
      now: () => "2026-07-12T16:03:00.000Z",
    }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "e-oh3" },
      body: {
        commandId: randomUUID(),
        supportingFacts: [{ key: support.key, baseline: support.baseline }],
        diagnosisKey: "ulcerative_blepharitis",
        action: "confirm",
        source: "mapping",
      },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((result.body as { link: string }).link, "pending");
  }
  assert.deepEqual(fhir.resources.filter((resource): resource is Observation => resource.resourceType === "Observation" &&
    resource.code.coding?.some((coding) => coding.code?.startsWith(`${lids.definition.stableKey}::`))), lidsObservations);
  const blepharitisCodes = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition" &&
    resource.code?.text === "Ulcerative blepharitis")
    .map((condition) => condition.code?.coding?.[0]?.code)
    .sort();
  assert.deepEqual(blepharitisCodes, ["H01.01A", "H01.01B"]);
  assert.equal(fhir.resources.filter(resource => resource.resourceType === "Condition").length, 3);
});

test("I1 complete ocular qualifiers resolve each selected finding to one diagnosis", async () => {
  const pterygiumCases = [
    [{ location: "central" }, "pterygium_central"],
    [{ location: "peripheral", progression: "stationary" }, "pterygium_peripheral_stationary"],
    [{ location: "peripheral", progression: "progressive" }, "pterygium_peripheral_progressive"],
    [{ location: "peripheral", progression: "recurrent" }, "pterygium_recurrent"],
  ] as const;
  for (const [stableKey, option] of [
    ["ocular-health:anterior:conjunctiva", "pterygium"],
    ["ocular-health:anterior:cornea", "pterygium-encroaching"],
  ] as const) {
    for (const [qualifiers, diagnosisKey] of pterygiumCases) {
      assert.deepEqual(await ocularCandidateKeys(stableKey, {
        OD: { selections: [option], findingDetails: { [option]: qualifiers } },
      }), [[diagnosisKey]]);
    }
  }

  for (const [stability, diagnosisKey] of [
    ["stable", "keratoconus_stable"],
    ["unstable", "keratoconus_unstable"],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:cornea", {
      OD: { selections: ["keratoconus"], findingDetails: { keratoconus: { stability } } },
    }), [[diagnosisKey]]);
  }

  for (const [severity, macularEdema, diagnosisKey] of [
    ["mild", "present", "t2_dr_mild_npdr_with_dme"],
    ["mild", "absent", "t2_dr_mild_npdr_without_dme"],
    ["moderate", "present", "t2_dr_moderate_npdr_with_dme"],
    ["moderate", "absent", "t2_dr_moderate_npdr_without_dme"],
    ["severe", "present", "t2_dr_severe_npdr_with_dme"],
    ["severe", "absent", "t2_dr_severe_npdr_without_dme"],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
      OD: {
        selections: ["diabetic-retinopathy-background-npdr"],
        findingDetails: { "diabetic-retinopathy-background-npdr": { severity, "macular-edema": macularEdema } },
      },
    }), [[diagnosisKey]]);
  }

  for (const [severity, diagnosisKey] of [
    ["with-macular-edema", "t2_dr_pdr_with_dme"],
    ["traction-rd-involving-macula", "t2_dr_pdr_trd_involving_macula"],
    ["traction-rd-not-involving-macula", "t2_dr_pdr_trd_not_involving_macula"],
    ["combined-traction-rhegmatogenous-rd", "t2_dr_pdr_combined_trd_rrd"],
    ["stable", "t2_dr_stable_pdr"],
    ["without-macular-edema", "t2_dr_pdr_without_dme"],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
      OD: {
        selections: ["proliferative-diabetic-retinopathy-pdr"],
        findingDetails: { "proliferative-diabetic-retinopathy-pdr": { severity } },
      },
    }), [[diagnosisKey]]);
  }
});

test("I2 absent or partial ocular qualifiers retain the specified safe fallbacks", async () => {
  assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:conjunctiva", {
    OD: { selections: ["pterygium"], findingDetails: { pterygium: { location: "peripheral" } } },
  }), [[
    "pterygium_central",
    "pterygium_peripheral_stationary",
    "pterygium_peripheral_progressive",
    "pterygium_recurrent",
  ]]);

  assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
    OD: {
      selections: ["diabetic-retinopathy-background-npdr"],
      findingDetails: { "diabetic-retinopathy-background-npdr": { severity: "mild" } },
    },
    OS: { selections: ["proliferative-diabetic-retinopathy-pdr"] },
  }), [
    [
      "t2_dr_mild_npdr_with_dme",
      "t2_dr_mild_npdr_without_dme",
      "t2_dr_moderate_npdr_with_dme",
      "t2_dr_moderate_npdr_without_dme",
      "t2_dr_severe_npdr_with_dme",
      "t2_dr_severe_npdr_without_dme",
    ],
    [
      "t2_dr_pdr_with_dme",
      "t2_dr_pdr_trd_involving_macula",
      "t2_dr_pdr_trd_not_involving_macula",
      "t2_dr_pdr_combined_trd_rrd",
      "t2_dr_stable_pdr",
      "t2_dr_pdr_without_dme",
    ],
  ]);
});

test("I3 qualifier triggers are scoped to the option that recorded the shared key", () => {
  const optionATrigger = {
    kind: "qualifier" as const,
    field: "CUSTOM_FINDINGS",
    option: "option-a",
    qualifiers: { location: "peripheral" },
  };
  const finding: FindingInstance = {
    id: "qualified-finding",
    state: "committed",
    presence: "present",
    findingDefinitionId: "qualified-definition",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OD",
    value: { type: "components", components: [
      { code: "OD_CUSTOM_FINDINGS::option-a", display: "Option A", value: true },
      { code: "OD_CUSTOM_FINDINGS::option-b", display: "Option B", value: true },
      { code: "OD_CUSTOM_FINDINGS::option-a::location", display: "Option A location", value: "central" },
      { code: "OD_CUSTOM_FINDINGS::option-b::location", display: "Option B location", value: "peripheral" },
    ] },
    sourceType: "manual",
    recordedAt: "2026-08-04T12:00:00.000Z",
    provenance: { source: "manual", recordedAt: "2026-08-04T12:00:00.000Z" },
  };
  assert.equal(createDiagnosisCandidateSchema.safeParse({ diagnosisKey: "candidate-a", trigger: optionATrigger }).success, true);
  assert.equal(updateDiagnosisCandidateSchema.safeParse({ trigger: optionATrigger }).success, true);
  assert.equal(evaluateMappingTrigger(optionATrigger, finding), false);
  assert.equal(evaluateMappingTrigger({ ...optionATrigger, option: "option-b" }, finding), true);
});

test("I4 ocular records without findingDetails retain specific candidate lists", async () => {
  assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:conjunctiva", {
    OD: { selections: ["pterygium"] },
  }), [[
    "pterygium_central",
    "pterygium_peripheral_stationary",
    "pterygium_peripheral_progressive",
    "pterygium_recurrent",
  ]]);
  assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:cornea", {
    OD: { selections: ["keratoconus"] },
  }), [["keratoconus_stable", "keratoconus_unstable"]]);
  assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
    OD: { selections: ["diabetic-retinopathy-background-npdr"] },
  }), [[
    "t2_dr_mild_npdr_with_dme",
    "t2_dr_mild_npdr_without_dme",
    "t2_dr_moderate_npdr_with_dme",
    "t2_dr_moderate_npdr_without_dme",
    "t2_dr_severe_npdr_with_dme",
    "t2_dr_severe_npdr_without_dme",
  ]]);
});

test("anterior-chamber ruled findings propose only their seeded diagnoses", async () => {
  for (const [option, expected] of [
    ["hyphema", ["hyphema"]],
    ["hypopyon", ["hypopyon"]],
    ["shallow-ac", ["anatomical_narrow_angle"]],
    ["narrow-angle-by-exam", ["anatomical_narrow_angle"]],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:anterior-chamber", {
      OD: { selections: [option] },
    }), [expected], option);
  }
});

test("iris ruled findings propose only their seeded diagnoses", async () => {
  for (const [option, expected] of [
    ["posterior-synechiae", ["posterior_synechiae"]],
    ["neovascularization-rubeosis", ["iris_neovascularization"]],
    ["pseudoexfoliation-material-on-pupil-margin", ["pseudoexfoliation_lens"]],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:iris", {
      OD: { selections: [option] },
    }), [expected], option);
  }
});

test("vitreous ruled findings propose only their seeded diagnoses", async () => {
  for (const [option, expected] of [
    ["vitreous-hemorrhage", ["vitreous_hemorrhage"]],
    ["floaters", ["vitreous_opacities"]],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:vitreous", {
      OD: { selections: [option] },
    }), [expected], option);
  }
});

test("vessels ruled findings propose only their seeded diagnoses", async () => {
  for (const option of [
    "av-nicking",
    "arteriolar-attenuation",
    "sclerotic-copper-silver-wire-changes",
  ]) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:vessels", {
      OD: { selections: [option] },
    }), [["hypertensive_retinopathy"]], option);
  }
  assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:vessels", {
    OD: { selections: ["neovascularization-of-the-disc-nvd"] },
  }), [[
    "t2_dr_pdr_with_dme",
    "t2_dr_pdr_trd_involving_macula",
    "t2_dr_pdr_trd_not_involving_macula",
    "t2_dr_pdr_combined_trd_rrd",
    "t2_dr_stable_pdr",
    "t2_dr_pdr_without_dme",
  ]]);
});

test("palpebral conjunctiva GPC proposes its seeded diagnosis", async () => {
  assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:palpebral-conjunctiva", {
    OD: { selections: ["giant-papillae-gpc"] },
  }), [["giant_papillary_conjunctivitis"]]);
});

test("vessels A/V ratio codes follow the field::option delimiter convention", async () => {
  const definition = (await new FhirFindingDefinitionStore(new MemoryFhir()).list())
    .find((candidate) => candidate.stableKey === "ocular-health:posterior:vessels");
  assert.ok(definition);
  const field = Object.values(definition.valueSchema.fields as Record<string, {
    display?: string;
    localCode?: string;
    options?: Array<{ code: string }>;
  }>).find((candidate) => candidate.display === "A/V ratio");
  assert.ok(field?.localCode);
  assert.deepEqual(field.options?.map((option) => option.code), ["2-3", "1-2", "1-3", "1-4"]);
  for (const option of field.options ?? []) {
    assert.equal(option.code.includes(":"), false);
    assert.equal(`${field.localCode}::${option.code}`.split("::").length, 2);
  }
});

test("active ocular-health diagnosis mappings name active options on their declared fields", () => {
  const violations: string[] = [];
  const inspectTrigger = (
    definitionKey: string,
    fields: Record<string, { active?: boolean; options?: Array<{ code?: string; active?: boolean }> }>,
    trigger: Parameters<typeof evaluateMappingTrigger>[0],
  ): void => {
    if (trigger.kind === "allOf") {
      for (const nested of trigger.triggers) inspectTrigger(definitionKey, fields, nested);
      return;
    }
    const targets = trigger.kind === "option"
      ? trigger.anyOf.map((option) => ({ field: trigger.field, option }))
      : trigger.kind === "qualifier"
        ? [{ field: trigger.field, option: trigger.option }]
        : [];
    for (const target of targets) {
      const field = fields[target.field];
      const option = field?.options?.find((candidate) => candidate.code === target.option);
      if (field?.active !== true || option?.active !== true) {
        violations.push(`${definitionKey}::${target.field}::${target.option}`);
      }
    }
  };

  for (const definition of buildFindingDefinitionSeeds().filter((candidate) =>
    candidate.active && candidate.stableKey.startsWith("ocular-health:")
  )) {
    const fields = definition.valueSchema.fields as Record<
      string,
      { active?: boolean; options?: Array<{ code?: string; active?: boolean }> }
    >;
    for (const candidate of definition.diagnosisCandidates ?? []) {
      if (candidate.active) inspectTrigger(definition.stableKey, fields, candidate.trigger);
    }
  }

  assert.deepEqual(violations, [], `Ocular-health diagnosis triggers name missing or inactive options: ${violations.join(", ")}`);
});

test("diagnosis reachability reports mapping, rule, and visual-field descriptor channels against separate baselines", () => {
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: "2026-09-07T12:00:00.000Z",
    actorReference: "Practitioner/disposition-census",
  };
  const activeLedgerRows = buildDiagnosisCatalogSeeds().filter((row) => row.active);
  const visualFieldDefinition = buildEntranceFindingDefinitions(provenance)
    .find((definition) => definition.stableKey === VISUAL_FIELD_DEFECT_KEY);
  assert.ok(visualFieldDefinition);
  const visualFieldDescriptorOptions = Object.values(visualFieldDefinition.valueSchema.fields as Record<
    string,
    { localCode?: string; options?: Array<{ code: string; active?: boolean }> }
  >).find((field) => field.localCode === VISUAL_FIELD_DESCRIPTOR_FIELD)?.options ?? [];
  const visualFieldDescriptorReachableKeys = new Set(visualFieldDescriptorOptions.flatMap((descriptor) => {
    if (descriptor.active !== true) return [];
    const resolution = visualFieldDescriptorResolution(VISUAL_FIELD_DEFECT_KEY, {
      type: "components",
      components: [{ code: VISUAL_FIELD_DESCRIPTOR_FIELD, display: "Field Defect", value: descriptor.code }],
    });
    return resolution?.diagnosisKey ? [resolution.diagnosisKey] : [];
  }));

  const glaucomaDefinitions = buildGlaucomaFindingDefinitionStubs({ provenance });
  const cupDiscDefinition = glaucomaDefinitions.find((definition) => definition.stableKey === "cup_disc_ratio");
  const iopDefinition = glaucomaDefinitions.find((definition) => definition.stableKey === "intraocular_pressure");
  assert.ok(cupDiscDefinition);
  assert.ok(iopDefinition);
  assertDeclaredInventory(
    "Glaucoma evaluator finding-definition",
    GLAUCOMA_FINDING_DEFINITION_KEYS,
    new Set([cupDiscDefinition.stableKey, iopDefinition.stableKey]),
    GLAUCOMA_RULE_FINDING_KEYS_NOT_YET_EXERCISED,
  );
  const cupDiscEvaluations = [0.5, 0.75].flatMap((ratio, index) => {
    const captured = captureGlaucomaFinding({
      definition: cupDiscDefinition,
      patientReference: "Patient/disposition-census",
      encounterReference: `Encounter/disposition-census-cup-${index}`,
      findingInstanceId: `finding-disposition-census-cup-${index}`,
      laterality: "OD",
      value: { type: "quantity", value: ratio, unit: "ratio", code: "1" },
      recordedAt: provenance.recordedAt,
      provenance,
    });
    return evaluateGlaucomaDiagnosisSuggestions({
      findings: [captured.finding],
      findingDefinitions: glaucomaDefinitions,
      provenance,
    });
  });
  const iopCaptured = captureGlaucomaFinding({
    definition: iopDefinition,
    patientReference: "Patient/disposition-census",
    encounterReference: "Encounter/disposition-census-iop",
    findingInstanceId: "finding-disposition-census-iop",
    laterality: "OD",
    value: { type: "quantity", value: 22, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    recordedAt: provenance.recordedAt,
    provenance,
  });
  const iopEvaluations = evaluateIopDiagnosisSuggestions({
    findings: [iopCaptured.finding],
    findingDefinitions: glaucomaDefinitions,
    provenance,
  });
  const refractionDefinition = buildRefractionFindingDefinitionStub(provenance);
  const refractionFinding = (
    id: string,
    laterality: "OD" | "OS",
    sphere: number,
  ): FindingInstance => ({
    id,
    state: "committed",
    presence: "present",
    findingDefinitionId: refractionDefinition.id,
    patientReference: "Patient/disposition-census",
    encounterReference: "Encounter/disposition-census-refraction",
    laterality,
    value: {
      type: "json",
      value: { blockId: "disposition-census", refractionType: "MANIFEST", sphere, cylinder: -1, add: 2 },
    },
    sourceType: "manual",
    recordedAt: provenance.recordedAt,
    provenance,
  });
  const refractionEvaluations = evaluateRefractiveErrorSuggestions({
    findings: [
      refractionFinding("finding-disposition-census-refraction-od", "OD", -2),
      refractionFinding("finding-disposition-census-refraction-os", "OS", 2),
    ],
    findingDefinitions: [refractionDefinition],
    provenance,
  });
  const catalogRuleDeclaration = catalogKeyForRuleDeclaration();
  const declaredRuleKeys = sortedUnique([
    ...catalogRuleDeclaration.declaredCatalogKeys,
    ...declaredRuleCatalogKeys(catalogRuleDeclaration.resolve),
  ]);
  const exercisedRuleKeys = new Set([
    ...cupDiscEvaluations,
    ...iopEvaluations,
    ...refractionEvaluations,
  ].map((evaluation) => {
    const emittedKey = evaluation.diagnosisDefinition.stableKey;
    const catalogKey = catalogRuleDeclaration.resolve(emittedKey);
    const catalogRow = activeLedgerRows.find((row) => row.stableKey === catalogKey);
    assert.ok(catalogRow, `Rule evaluator emitted a diagnosis absent from the active catalog: ${emittedKey}`);
    return catalogRow.stableKey;
  }));
  assertDeclaredInventory(
    "Rule evaluator catalog",
    declaredRuleKeys,
    exercisedRuleKeys,
    RULE_CATALOG_KEYS_NOT_YET_EXERCISED,
  );
  const activeLedgerKeys = new Set(activeLedgerRows.map((row) => row.stableKey));
  const declaredKeysMissingFromCatalog = declaredRuleKeys.filter((key) => !activeLedgerKeys.has(key));
  assert.deepEqual(
    declaredKeysMissingFromCatalog,
    [],
    `Rule evaluator declarations are absent from the active catalog: ${declaredKeysMissingFromCatalog.join(", ")}`,
  );
  const declaredRuleKeySet = new Set(declaredRuleKeys);
  const mappingReachableKeys = new Set<string>();
  for (const definition of buildFindingDefinitionSeeds().filter((candidate) => candidate.active)) {
    for (const candidate of definition.diagnosisCandidates ?? []) {
      if (!candidate.active) continue;
      if (candidate.diagnosisKey !== undefined) mappingReachableKeys.add(candidate.diagnosisKey);
      if (candidate.familyGroup !== undefined) {
        const mode = FAMILY_RESOLUTION_MODES[candidate.familyGroup];
        if (mode?.mode === "staged") {
          for (const member of mode.members) mappingReachableKeys.add(member.stableKey);
        }
      }
    }
  }
  const reachedBy = (keys: ReadonlySet<string>) => activeLedgerRows.filter((row) => keys.has(row.stableKey)).length;

  assert.deepEqual({
    activeLedgerRows: activeLedgerRows.length,
    mapping: reachedBy(mappingReachableKeys),
    rules: reachedBy(declaredRuleKeySet),
    visualFieldDescriptors: reachedBy(visualFieldDescriptorReachableKeys),
  }, {
    activeLedgerRows: 134,
    mapping: 63,
    rules: 8,
    visualFieldDescriptors: 3,
  });
});

test("ocular-health ledger diagnoses never become more globally unreachable", async () => {
  const ledger = JSON.parse(readFileSync(
    new URL("../../data/code-bindings/ocular-health-phase0-ledger.json", import.meta.url),
    "utf8",
  )) as { diagnosisCodes: Array<{ code: string }> };
  const ledgerCodes = new Set(ledger.diagnosisCodes.map((row) => row.code));
  const ocularCatalogRows = buildDiagnosisCatalogSeeds().filter((row) => {
    const codes = row.icd10 === undefined
      ? []
      : "code" in row.icd10
        ? [row.icd10.code]
        : Object.values(row.icd10.pattern).filter((code): code is string => code !== undefined);
    return row.active && codes.length > 0 && codes.every((code) => ledgerCodes.has(code));
  });
  const reachable = new Set<string>();
  const definitions = await new FhirFindingDefinitionStore(new MemoryFhir()).list();
  for (const definition of definitions.filter((candidate) => candidate.stableKey.startsWith("ocular-health:"))) {
    for (const candidate of definition.diagnosisCandidates ?? []) {
      if (!candidate.active) continue;
      if (candidate.diagnosisKey !== undefined) reachable.add(candidate.diagnosisKey);
      if (candidate.familyGroup !== undefined) {
        const mode = FAMILY_RESOLUTION_MODES[candidate.familyGroup];
        if (mode?.mode === "staged") {
          for (const member of mode.members) reachable.add(member.stableKey);
        }
      }
    }
  }
  const unreachable = ocularCatalogRows.filter((row) => !reachable.has(row.stableKey));

  // Pre-slice: 45 at origin/main a5b6b41869070ea6a97656aefd17907760a7421b; this slice achieved 38.
  // Tighten this ceiling whenever the count falls so unreachable rows may never rise again.
  assert.ok(unreachable.length <= 38, `Unreachable ocular-health ledger rows rose to ${unreachable.length}: ${unreachable.map((row) => row.stableKey).join(", ")}`);
});

test("unspecified ocular diagnosis keys never surface with qualifiers unset or set", async () => {
  const forbidden = new Set([
    "keratoconus_unspecified_stability",
    "t2_dr_unspecified_with_dme",
    "t2_dr_unspecified_without_dme",
  ]);
  const cases = [
    ["ocular-health:anterior:cornea", {
      OD: { selections: ["keratoconus"] },
    }],
    ...(["stable", "unstable"] as const).map((stability) => [
      "ocular-health:anterior:cornea",
      { OD: { selections: ["keratoconus"], findingDetails: { keratoconus: { stability } } } },
    ]),
    ["ocular-health:posterior:fundus", {
      OD: { selections: ["diabetic-retinopathy-background-npdr"] },
    }],
    ...(["mild", "moderate", "severe"] as const).flatMap((severity) =>
      (["present", "absent"] as const).map((macularEdema) => [
        "ocular-health:posterior:fundus",
        { OD: {
          selections: ["diabetic-retinopathy-background-npdr"],
          findingDetails: { "diabetic-retinopathy-background-npdr": { severity, "macular-edema": macularEdema } },
        } },
      ])
    ),
  ] as const;

  for (const [stableKey, eyes] of cases) {
    const proposed = (await ocularCandidateKeys(stableKey, eyes)).flat();
    assert.equal(
      proposed.some((diagnosisKey) => forbidden.has(diagnosisKey)),
      false,
      `${stableKey} proposed an unspecified diagnosis: ${proposed.join(", ")}`,
    );
  }
});

test("I5 qualifier components cannot diagnose or suppress without an active parent option", async () => {
  const trigger = {
    kind: "qualifier" as const,
    field: "CUSTOM_FINDINGS",
    option: "pterygium",
    qualifiers: { location: "central" },
  };
  const finding = (parent: "absent" | "false"): FindingInstance => ({
    id: `qualified-${parent}`,
    state: "committed",
    presence: "present",
    findingDefinitionId: "qualified-definition",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OD",
    value: { type: "components", components: [
      ...(parent === "false"
        ? [{ code: "OD_CUSTOM_FINDINGS::pterygium", display: "Pterygium", value: false }]
        : []),
      { code: "OD_CUSTOM_FINDINGS::pterygium::location", display: "Pterygium location", value: "central" },
    ] },
    sourceType: "manual",
    recordedAt: "2026-08-04T12:00:00.000Z",
    provenance: { source: "manual", recordedAt: "2026-08-04T12:00:00.000Z" },
  });
  for (const parent of ["absent", "false"] as const) {
    assert.equal(evaluateMappingTrigger(trigger, finding(parent)), false, `${parent} parent must block qualifier matching`);
    assert.deepEqual(matchingQualifierGroups(trigger, finding(parent)), [], `${parent} parent must not register a suppression group`);
  }

  for (const parent of ["absent", "false"] as const) {
    const fhir = new MemoryFhir();
  fhir.resources.push(testEncounter("e-qualified", "p-qualified"));
    const definitions = await new FhirFindingDefinitionStore(fhir).list();
    const definition = definitions.find((candidate) => candidate.stableKey === "ocular-health:anterior:conjunctiva");
    assert.ok(definition);
    const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
      .find((candidate) => candidate.valueType === "multi-select");
    assert.ok(field?.localCode);
    const optionCode = `OD_${field.localCode}::pterygium`;
    fhir.resources.push({
      resourceType: "Observation",
      id: `qualifier-with-${parent}-parent`,
      status: "preliminary",
      code: {
        coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code: definition.stableKey }],
        text: definition.display,
      },
      subject: { reference: "Patient/p-qualified" },
      encounter: { reference: "Encounter/e-qualified" },
      effectiveDateTime: "2026-08-04T12:00:00.000Z",
      interpretation: [{ coding: [{ code: "A" }] }],
      extension: [{
        url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality",
        valueCodeableConcept: { coding: [{ code: "OD" }] },
      }],
      component: [
        ...(parent === "false"
          ? [{ code: { coding: [{ code: optionCode }], text: "Pterygium" }, valueBoolean: false }]
          : []),
        {
          code: { coding: [{ code: `${optionCode}::location` }], text: "Pterygium — Location" },
          valueCodeableConcept: { coding: [{ code: "central" }] },
        },
      ],
    } as Observation);
    const authenticate = async () => ({
      staffReference: "Practitioner/doctor-1",
      actorRole: "provider" as PracticeRoleId,
      fhir,
    });
    const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "e-qualified" },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const rows = (result.body as CandidateResponse).findings;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.candidates, [], `${parent} parent must produce no diagnosis candidate`);
  }
});

test("I6 allOf-wrapped option fallbacks are suppressed like bare option fallbacks", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push(testEncounter("e-qualified", "p-qualified"));
  const store = new FhirFindingDefinitionStore(fhir);
  const definition = (await store.list()).find((candidate) => candidate.stableKey === "ocular-health:anterior:conjunctiva");
  assert.ok(definition);
  await store.save({
    ...definition,
    diagnosisCandidates: definition.diagnosisCandidates?.map((candidate) =>
      candidate.trigger.kind === "option" && candidate.trigger.anyOf.includes("pterygium")
        ? { ...candidate, trigger: { kind: "allOf" as const, triggers: [candidate.trigger] } }
        : candidate
    ),
  });
  const definitions = await store.list();
  const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
    .find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "provider" as PracticeRoleId,
    fhir,
  });
  const capture = await captureCustomSectionFixture({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-08-04T12:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: definition.stableKey },
    body: {
      patientReference: "Patient/p-qualified",
      encounterReference: "Encounter/e-qualified",
      eyes: { OD: {
        state: "abnormal",
        customFields: [{ code: field.localCode, value: ["pterygium"] }],
        findingDetails: { pterygium: { location: "central" } },
      } },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-qualified" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    (result.body as CandidateResponse).findings.map((finding) =>
      finding.candidates.map((candidate) => candidate.diagnosisKey)
    ),
    [["pterygium_central"]],
  );
});

test("direct laterality-required picks ask once, then write no fabricated evidence, and evaluators contain no pick call site", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e1", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter);
  const result = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "myopia", action: "confirm" },
  });
  assert.equal(result.status, 422);
  assert.match(String((result.body as { error: string }).error), /requires laterality/);
  const discard = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "myopia", action: "discard" },
  });
  assert.equal(discard.status, 422);
  assert.match(String((discard.body as { error: string }).error), /requires laterality/);
  const explicit = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "myopia", action: "confirm", laterality: "OD" },
  });
  assert.equal(explicit.status, 200);
  const directCondition = (explicit.body as { condition: Condition }).condition;
  assert.equal(directCondition.code?.coding?.[0]?.code, sourcedDiagnosisCode("myopia", "right"));
  assert.equal(directCondition.evidence, undefined);
  for (const file of ["glaucoma-suspect.ts", "refraction-suspect.ts", "diagnosis-mapping.ts"]) {
    const source = readFileSync(new URL(`../src/clinical-graph/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /handleDiagnosisPickRequest|diagnosis-picks/);
  }
});

test("visual-field descriptors derive every approved code while preserving the descriptor through reload", async () => {
  const cases = [
    ["no-defect", "No defect", undefined, undefined],
    ["field-loss-od", "Field loss OD", "vf_other_localized", "H53.451"],
    ["field-loss-os", "Field loss OS", "vf_other_localized", "H53.452"],
    ["bitemporal-hemianopsia", "Bitemporal hemianopsia", "vf_heteronymous_bilateral", "H53.47"],
    ["right-homonymous-hemianopsia", "Right homonymous hemianopsia", "vf_homonymous_bilateral", "H53.461"],
    ["left-homonymous-hemianopsia", "Left homonymous hemianopsia", "vf_homonymous_bilateral", "H53.462"],
    ["superior-right-homonymous-quadrantanopia", "Superior right homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.461"],
    ["inferior-right-homonymous-quadrantanopia", "Inferior right homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.461"],
    ["superior-left-homonymous-quadrantanopia", "Superior left homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.462"],
    ["inferior-left-homonymous-quadrantanopia", "Inferior left homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.462"],
  ] as const;

  for (const [descriptor, display, diagnosisKey, code] of cases) {
    const fhir = new MemoryFhir();
    fhir.resources.push({
      resourceType: "Encounter", id: "vf", status: "in-progress",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
      subject: { reference: "Patient/vf" },
    } as Encounter);
    const definitions = await new FhirFindingDefinitionStore(fhir).list();
    const definition = definitions.find((candidate) => candidate.stableKey === "entrance:visual-field-defect");
    assert.ok(definition, `Missing visual-field definition for ${descriptor}`);
    const authenticate = async () => ({
      staffReference: "Practitioner/doctor-1",
      actorRole: "provider" as PracticeRoleId,
      fhir,
    });
    const capture = await captureCustomSectionFixture({
      authenticate,
      findingDefinitions: () => definitions,
      now: () => "2026-08-05T14:00:00.000Z",
    }, {
      authHeader: "Bearer doctor-1",
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/vf",
        encounterReference: "Encounter/vf",
        customFields: [{ code: "CUSTOM_FIELD_DEFECT", value: descriptor }],
      },
    });
    assert.equal(capture.status, 200, JSON.stringify(capture.body));
    const observationReference = (capture.body as { observationReference: string }).observationReference;
    const observation = fhir.resources.find((resource): resource is Observation =>
      resource.resourceType === "Observation" && `Observation/${resource.id}` === observationReference
    );
    assert.ok(observation);
    const storedDescriptor = observation.component?.find((component) =>
      component.code.coding?.some((coding) => coding.code === "CUSTOM_FIELD_DEFECT")
    )?.valueCodeableConcept?.coding?.[0];
    assert.deepEqual([storedDescriptor?.code, storedDescriptor?.display], [descriptor, display]);

    const history = await handleCustomSectionHistoryRequest({
      authenticate,
      findingDefinitions: () => definitions,
    }, {
      authHeader: "Bearer doctor-1",
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/vf", encounter: "Encounter/vf" },
    });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.deepEqual(
      (history.body as { rows: Array<{ observationReference?: string; values: Array<{ value: unknown }> }> }).rows
        .map((row) => [row.observationReference, row.values[0]?.value]),
      [[observationReference, display]],
    );

    const candidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "vf" },
    });
    assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
    const finding = (candidates.body as CandidateResponse).findings.find((row) =>
      row.observationReference === observationReference
    );
    assert.ok(finding);
    if (!diagnosisKey || !code) {
      assert.deepEqual(finding.candidates, []);
      continue;
    }
    assert.deepEqual(
      finding.candidates.map((candidate) => [candidate.diagnosisKey, candidate.icd10?.code]),
      [[diagnosisKey, code]],
    );
    const pick = await handleDiagnosisPickRequest({ authenticate }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "vf" },
      body: { findingInstanceId: observationReference, diagnosisKey, action: "confirm", source: "mapping" },
    });
    assert.equal(pick.status, 200, JSON.stringify(pick.body));
    assert.equal((pick.body as { condition: Condition }).condition.code?.coding?.[0]?.code, code);
    assert.equal(storedDescriptor?.display, display);
  }
});

test("staged glaucoma visibly suppresses only the visual-field proposal and override never changes glaucoma stage", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "vf", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/vf" },
  } as Encounter);
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const definition = definitions.find((candidate) => candidate.stableKey === "entrance:visual-field-defect");
  assert.ok(definition);
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "provider" as PracticeRoleId,
    fhir,
  });
  const capture = await captureCustomSectionFixture({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-08-05T14:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: definition.stableKey },
    body: {
      patientReference: "Patient/vf",
      encounterReference: "Encounter/vf",
      customFields: [{ code: "CUSTOM_FIELD_DEFECT", value: "field-loss-od" }],
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const observationReference = (capture.body as { observationReference: string }).observationReference;

  const stagedGlaucoma = {
    resourceType: "Condition",
    id: "staged-glaucoma",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.ZZZ2" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    stage: [{ summary: { text: "Operator-entered stage" } }],
  } as Condition;
  fhir.resources.push({
    resourceType: "Condition",
    id: "unstaged-glaucoma",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.021" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
  } as Condition, {
    resourceType: "Condition",
    id: "unconfirmed-staged-glaucoma",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.ZZZ1" }] },
    verificationStatus: { coding: [{ code: "provisional" }] },
  } as Condition, {
    resourceType: "Condition",
    id: "indeterminate-stage-glaucoma",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.ZZZ4" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
  } as Condition, ...(["inactive", "remission", "resolved"] as const).map((clinicalStatus, index) => ({
    resourceType: "Condition",
    id: `${clinicalStatus}-staged-glaucoma`,
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: `H40.ZZZ${index + 1}` }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    clinicalStatus: { coding: [{ code: clinicalStatus }] },
  } as Condition)), {
    resourceType: "Condition",
    id: "other-encounter-stage",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/other" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.ZZZ3" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
  } as Condition);
  const unsuppressed = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "vf" },
  });
  const unsuppressedFinding = (unsuppressed.body as CandidateResponse).findings.find((row) =>
    row.observationReference === observationReference
  );
  assert.deepEqual(unsuppressedFinding?.candidates.map((candidate) => candidate.icd10?.code), ["H53.451"]);
  assert.equal(unsuppressedFinding?.suppression, undefined);

  fhir.resources.push(stagedGlaucoma);
  const stagedBefore = structuredClone(fhir.resources.find((resource) => resource.id === "staged-glaucoma"));
  const writesBefore = fhir.writes.length;

  const candidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "vf" },
  });
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  const finding = (candidates.body as CandidateResponse).findings.find((row) =>
    row.observationReference === observationReference
  );
  assert.ok(finding);
  assert.deepEqual(finding.candidates, []);
  assert.deepEqual(finding.suppressedCandidates?.map((candidate) => candidate.icd10?.code), ["H53.451"]);
  assert.deepEqual(finding.suppression, {
    message: "H53.4x not proposed — the glaucoma stage already carries the field defect.",
    overridable: true,
  });
  assert.deepEqual(fhir.resources.find((resource) => resource.id === "staged-glaucoma"), stagedBefore);
  assert.equal(fhir.writes.length, writesBefore);

  const override = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "vf" },
    body: {
      findingInstanceId: observationReference,
      diagnosisKey: "vf_other_localized",
      action: "confirm",
      source: "mapping",
    },
  });
  assert.equal(override.status, 200, JSON.stringify(override.body));
  assert.equal((override.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.451");
  assert.deepEqual(fhir.resources.find((resource) => resource.id === "staged-glaucoma"), stagedBefore);
});

test("prior-encounter confirmed glaucoma reveals both staged glaucoma families without widening encounter suppression scope", async () => {
  const fhir = diagnosisPickFhir();
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "provider" as PracticeRoleId,
    fhir,
  });
  const beforeHistory = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
  });
  assert.equal(beforeHistory.status, 200, JSON.stringify(beforeHistory.body));
  assert.equal((beforeHistory.body as CandidateResponse).findings.some((finding) =>
    finding.candidates.some((candidate) => candidate.familyGroup !== undefined)
  ), false);

  const confirmedGlaucoma = {
    resourceType: "Condition",
    subject: { reference: "Patient/p1" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.1113" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    clinicalStatus: { coding: [{ code: "active" }] },
  } as Condition;
  fhir.resources.push({
    ...confirmedGlaucoma,
    id: "current-poag",
    encounter: { reference: "Encounter/e1" },
  });
  const currentEncounter = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
  });
  assert.equal((currentEncounter.body as CandidateResponse).findings.some((finding) =>
    finding.candidates.some((candidate) => candidate.familyGroup !== undefined)
  ), false);
  fhir.resources.splice(fhir.resources.findIndex((resource) => resource.id === "current-poag"), 1);
  fhir.resources.push({
    ...confirmedGlaucoma,
    id: "prior-poag",
    encounter: { reference: "Encounter/prior" },
  });
  const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const cupDisc = (result.body as CandidateResponse).findings.find((finding) =>
    finding.observationReference === "Observation/finding-od"
  );
  assert.deepEqual(cupDisc?.candidates.map((candidate) => candidate.diagnosisKey ?? candidate.familyGroup), [
    "glaucoma_suspect_open_angle_low",
    "primary-open-angle-glaucoma",
    "low-tension-glaucoma",
  ]);
  assert.deepEqual(cupDisc?.candidates.slice(1).map((candidate) => ({
    familyGroup: candidate.familyGroup,
    clinicalFamily: candidate.clinicalFamily,
    axisLabel: candidate.axisLabel,
  })), [{
    familyGroup: "primary-open-angle-glaucoma",
    clinicalFamily: "primary-open-angle-glaucoma",
    axisLabel: "Stage",
  }, {
    familyGroup: "low-tension-glaucoma",
    clinicalFamily: "low-tension-glaucoma",
    axisLabel: "Stage",
  }]);
  assert.equal(fhir.searches.some((search) => search.resourceType === "Condition" &&
    search.params.encounter === "Encounter/e1" && search.params.subject === undefined), true);
  assert.equal(fhir.searches.some((search) => search.resourceType === "Condition" &&
    search.params.subject === "Patient/p1" && search.params.encounter === undefined), true);
});

test("posterior plain drusen returns an ordered leaf and staged family while occasional drusen stays descriptive", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "drusen",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter);
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "provider" as PracticeRoleId,
    fhir,
  });
  for (const [stableKey, option] of [
    ["ocular-health:posterior:macula", "drusen"],
    ["ocular-health:posterior:periphery", "occasional-drusen"],
  ] as const) {
    const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(definition);
    const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
      .find((candidate) => candidate.valueType === "multi-select");
    assert.ok(field?.localCode);
    const capture = await captureCustomSectionFixture({
      authenticate,
      findingDefinitions: () => definitions,
      now: () => "2026-08-11T12:00:00.000Z",
    }, {
      authHeader: "Bearer doctor-1",
      params: { stableKey },
      body: {
        patientReference: "Patient/p1",
        encounterReference: "Encounter/drusen",
        eyes: { OD: { state: "abnormal", customFields: [{ code: field.localCode, value: [option] }] } },
      },
    });
    assert.equal(capture.status, 200, JSON.stringify(capture.body));
  }
  const writesBeforeRead = fhir.writes.length;
  const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "drusen" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const findings = (result.body as CandidateResponse).findings;
  const macula = findings.find((finding) => finding.findingDefinitionKey === "ocular-health:posterior:macula");
  assert.deepEqual(macula?.candidates.map((candidate) => candidate.diagnosisKey ?? candidate.familyGroup), [
    "macular_drusen",
    "nonexudative-amd",
  ]);
  const { supportingFacts: maculaSupports, ...maculaFamily } = macula!.candidates[1];
  const maculaObservation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation" &&
    resource.code.coding?.some(coding => coding.code?.startsWith("ocular-health:posterior:macula::")))!;
  assert.deepEqual(maculaSupports, [candidateSupport(maculaObservation)]);
  assert.deepEqual(maculaFamily, {
    familyGroup: "nonexudative-amd",
    clinicalFamily: "nonexudative-amd",
    display: "Nonexudative AMD",
    axisLabel: "Stage",
    members: [
      { stableKey: "dry_amd_early", stageLabel: "Early" },
      { stableKey: "dry_amd_intermediate", stageLabel: "Intermediate" },
      { stableKey: "dry_amd_advanced_atrophic_without_subfoveal", stageLabel: "Advanced atrophic without subfoveal involvement (geographic atrophy)" },
      { stableKey: "dry_amd_advanced_atrophic_with_subfoveal", stageLabel: "Advanced atrophic with subfoveal involvement (geographic atrophy)" },
    ],
    priority: true,
    source: "mapping",
  });
  const periphery = findings.find((finding) => finding.findingDefinitionKey === "ocular-health:posterior:periphery");
  assert.deepEqual(periphery?.candidates, []);
  assert.equal(fhir.writes.length, writesBeforeRead);
  assert.equal(fhir.resources.some((resource) => resource.resourceType === "Condition"), false);

  const picked = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "drusen" },
    body: {
      commandId: randomUUID(),
      supportingFacts: maculaSupports!.map(({ key, baseline }) => ({ key, baseline })),
      diagnosisKey: "dry_amd_early",
      action: "confirm",
      laterality: "OD",
      source: "mapping",
    },
  });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].code?.coding?.[0]?.code, sourcedDiagnosisCode("dry_amd_early", "right"));
  assert.equal((picked.body as { link: string }).link, "pending");
  assert.equal(conditions[0].evidence, undefined);
  assert.deepEqual(fhir.resources.find(resource => resource.resourceType === "Observation" && resource.id === maculaObservation.id), maculaObservation);
});

test("homonymous field-side picks never derive field side from eye laterality", async () => {
  const fhir = diagnosisPickFhir();
  const pick = (laterality: "OD" | "OS" | "OU") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-08-05T12:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "vf_homonymous_bilateral", action: "confirm", laterality },
  });

  const od = await pick("OD");
  const os = await pick("OS");
  const ou = await pick("OU");
  assert.equal(od.status, 200);
  assert.equal(os.status, 200);
  assert.equal(ou.status, 200);
  assert.equal((od.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.469");
  assert.equal((os.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.469");
  assert.equal((ou.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.469");
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Condition").length, 1);
});

test("a concurrent Condition update returns 409 without silently retrying the clinician decision", async () => {
  class ConcurrentUpdateFhir extends MemoryFhir {
    conflictOnConditionUpdate = false;

    override async executeTransaction(
      bundle: Bundle,
      headers?: Record<string, string>,
      options?: { autoRollbackCreatedEntries?: boolean },
    ): Promise<Bundle> {
      if (this.conflictOnConditionUpdate) {
        this.conflictOnConditionUpdate = false;
        const current = this.resources.find((candidate) => candidate.resourceType === "Condition")!;
        current.meta = { ...(current.meta ?? {}), versionId: String(Number(current.meta?.versionId ?? "0") + 1) };
      }
      return super.executeTransaction(bundle, headers, options);
    }

    override async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      if (resourceType === "Condition" && this.conflictOnConditionUpdate) {
        this.conflictOnConditionUpdate = false;
        const current = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id)!;
        current.meta = { ...(current.meta ?? {}), versionId: String(Number(current.meta?.versionId ?? "0") + 1) };
      }
      return super.update(resourceType, id, resource, headers);
    }
  }

  const fhir = new ConcurrentUpdateFhir();
  const seeded = diagnosisPickFhir();
  fhir.resources.push(...seeded.resources);
  const pick = (action: "possible" | "confirm") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      findingInstanceId: "Observation/finding-od",
      diagnosisKey: "glaucoma_suspect_open_angle_low",
      action,
    },
  });

  assert.equal((await pick("possible")).status, 200);
  fhir.conflictOnConditionUpdate = true;
  const result = await pick("confirm");
  assert.equal(result.status, 409);
  assert.match(String((result.body as { error: string }).error), /reload and retry/);
  const condition = fhir.resources.find((resource): resource is Condition => resource.resourceType === "Condition")!;
  assert.equal(condition.verificationStatus?.coding?.[0]?.code, "provisional");
  assert.equal(fhir.writes.filter((write) => write.resourceType === "Condition" && write.operation === "update").length, 0);
});

test("a failed diagnosis pick transaction leaves the Condition and Encounter unchanged", async () => {
  class MidOperationFailureFhir extends MemoryFhir {
    failEncounterWrite = false;

    override async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      if (resourceType === "Encounter" && this.failEncounterWrite) {
        throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
      }
      return super.update(resourceType, id, resource, headers);
    }
  }

  const fhir = new MidOperationFailureFhir();
  fhir.resources.push(...diagnosisPickFhir().resources);
  const pick = (action: "confirm" | "discard") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action, source: "catalog-search" },
  });

  const confirmed = await pick("confirm");
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const condition = (confirmed.body as { condition: Condition }).condition;
  const conditionReference = `Condition/${condition.id}`;
  fhir.failEncounterWrite = true;

  const discarded = await pick("discard");

  assert.equal(discarded.status, 409, JSON.stringify(discarded.body));
  assert.equal((await fhir.read<Condition>("Condition", condition.id!)).verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.equal((await fhir.read<Encounter>("Encounter", "e1")).diagnosis?.some((entry) =>
    entry.condition.reference === conditionReference
  ), true);
});

test("possible, confirm, and discard use atomic transactions with per-resource version preconditions", async () => {
  const fhir = diagnosisPickFhir();
  const encounter = fhir.resources.find((resource): resource is Encounter =>
    resource.resourceType === "Encounter" && resource.id === "e1"
  )!;
  encounter.meta = { versionId: "7" };
  const pick = (action: "possible" | "confirm" | "discard") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action, source: "catalog-search" },
  });

  assert.equal((await pick("possible")).status, 200);
  assert.equal((await pick("confirm")).status, 200);
  assert.equal((await pick("discard")).status, 200);

  assert.equal(fhir.transactions.length, 3);
  assert.deepEqual(fhir.transactions.map(({ bundle, options }) => ({
    resources: bundle.entry?.map((entry) => entry.resource?.resourceType),
    methods: bundle.entry?.map((entry) => entry.request?.method),
    ifMatches: bundle.entry?.map((entry) => entry.request?.ifMatch),
    noClientRollback: options?.autoRollbackCreatedEntries === false,
  })), [{
    resources: ["Condition", "Provenance"],
    methods: ["POST", "POST"],
    ifMatches: [undefined, undefined],
    noClientRollback: true,
  }, {
    resources: ["Condition", "Encounter", "Provenance"],
    methods: ["PUT", "PUT", "POST"],
    ifMatches: ['W/"1"', 'W/"7"', undefined],
    noClientRollback: true,
  }, {
    resources: ["Condition", "Encounter", "Provenance"],
    methods: ["PUT", "PUT", "POST"],
    ifMatches: ['W/"2"', 'W/"8"', undefined],
    noClientRollback: true,
  }]);
  assert.equal(fhir.transactions[0]?.bundle.entry?.[0]?.request?.ifNoneExist,
    "identifier=https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key|e1::presbyopia::none");
  assert.deepEqual(fhir.transactions.map(({ bundle }) =>
    (bundle.entry?.at(-1)?.resource as Provenance).target.some((target) => target.reference === "Encounter/e1")
  ), [false, true, true]);
});

test("direct confirm and discard each send one atomic Condition-and-Encounter transaction with version guards", async () => {
  const fhir = diagnosisPickFhir();
  const encounter = fhir.resources.find((resource): resource is Encounter =>
    resource.resourceType === "Encounter" && resource.id === "e1"
  )!;
  encounter.meta = { versionId: "7" };
  const pick = (action: "confirm" | "discard") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action, source: "catalog-search" },
  });

  const confirmed = await pick("confirm");

  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(fhir.transactions.length, 1);
  const confirmBundle = fhir.transactions[0]!.bundle;
  assert.equal(confirmBundle.type, "transaction");
  assert.deepEqual(confirmBundle.entry?.map((entry) => entry.resource?.resourceType), [
    "Condition", "Encounter", "Provenance",
  ]);
  assert.equal(confirmBundle.entry?.find((entry) => entry.resource?.resourceType === "Encounter")?.request?.ifMatch, 'W/"7"');
  const condition = (confirmed.body as { condition: Condition }).condition;
  const persistedReference = (await fhir.read<Encounter>("Encounter", "e1")).diagnosis?.[0]?.condition.reference;
  assert.equal(persistedReference, `Condition/${condition.id}`);
  assert.doesNotMatch(persistedReference ?? "", /^urn:uuid:/);

  const discarded = await pick("discard");

  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal(fhir.transactions.length, 2);
  const discardBundle = fhir.transactions[1]!.bundle;
  assert.equal(discardBundle.type, "transaction");
  assert.deepEqual(discardBundle.entry?.map((entry) => entry.resource?.resourceType), [
    "Condition", "Encounter", "Provenance",
  ]);
  assert.equal(discardBundle.entry?.find((entry) => entry.resource?.resourceType === "Condition")?.request?.ifMatch, 'W/"1"');
  assert.equal(discardBundle.entry?.find((entry) => entry.resource?.resourceType === "Encounter")?.request?.ifMatch, 'W/"8"');
});

test("laterality-keyed picks keep both eyes distinct, escalate one eye, and discard only its Condition", async () => {
  const fhir = diagnosisPickFhir();
  const pick = (body: Record<string, unknown>) => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, { authHeader: "Bearer doctor-1", params: { encounterId: "e1" }, body });

  const possibleOd = await pick({
    findingInstanceId: "Observation/finding-od",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "possible",
  });
  assert.equal(possibleOd.status, 200);
  assert.equal((possibleOd.body as { condition: Condition }).condition.verificationStatus?.coding?.[0]?.code, "provisional");

  const confirmOd = await pick({
    findingInstanceId: "Observation/finding-od",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "confirm",
  });
  assert.equal(confirmOd.status, 200);
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Condition").length, 1);

  const confirmOs = await pick({
    findingInstanceId: "Observation/finding-os",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "confirm",
  });
  assert.equal(confirmOs.status, 200);
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(conditions.length, 2);
  assert.deepEqual(new Set(conditions.map((condition) => condition.code?.coding?.[0]?.code)), new Set([
    sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"),
    sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "left"),
  ]));
  assert.equal(conditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"))
    ?.evidence?.some((evidence) => evidence.detail?.some((detail) => detail.reference === "Observation/finding-od")), true);
  assert.equal(conditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "left"))
    ?.evidence?.some((evidence) => evidence.detail?.some((detail) => detail.reference === "Observation/finding-os")), true);

  const discardOd = await pick({
    findingInstanceId: "Observation/finding-od",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "discard",
  });
  assert.equal(discardOd.status, 200);
  const discardedConditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(discardedConditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"))
    ?.verificationStatus?.coding?.[0]?.code, "refuted");
  assert.equal(discardedConditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "left"))
    ?.verificationStatus?.coding?.[0]?.code, "confirmed");
});

test("conditional create makes identical same-eye Possible double-submit idempotent", async () => {
  const fhir = diagnosisPickFhir();
  const request = () => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      findingInstanceId: "Observation/finding-od",
      diagnosisKey: "glaucoma_suspect_open_angle_low",
      action: "possible",
    },
  });

  await Promise.all([request(), request()]);
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0]?.verificationStatus?.coding?.[0]?.code, "provisional");
  assert.equal(fhir.writes.filter((write) => write.resourceType === "Condition" && write.operation === "create").length, 1);
  assert.equal(fhir.writes.find((write) => write.resourceType === "Condition")?.headers?.["If-None-Exist"],
    "identifier=https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key|e1::glaucoma_suspect_open_angle_low::right");
});

test("confirmed catalog picks join Encounter.diagnosis once and preserve rank gaps", async () => {
  const fhir = diagnosisPickFhir();
  const encounter = fhir.resources.find((resource): resource is Encounter =>
    resource.resourceType === "Encounter" && resource.id === "e1"
  )!;
  encounter.meta = { versionId: "4" };
  encounter.diagnosis = [{ condition: { reference: "Condition/existing" }, rank: 4 }];
  const request = () => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action: "confirm", source: "catalog-search" },
  });

  const first = await request();
  assert.equal(first.status, 200);
  assert.deepEqual(
    (first.body as { encounter: Encounter }).encounter.diagnosis?.map((diagnosis) => ({
      reference: diagnosis.condition.reference,
      rank: diagnosis.rank,
    })),
    [
      { reference: "Condition/existing", rank: 4 },
      { reference: (first.body as { condition: Condition }).condition.id &&
          `Condition/${(first.body as { condition: Condition }).condition.id}`, rank: 5 },
    ],
  );

  const second = await request();
  assert.equal(second.status, 200);
  assert.equal((second.body as { encounter: Encounter }).encounter.diagnosis?.length, 2);
  assert.equal(fhir.writes.filter((write) => write.resourceType === "Encounter" && write.operation === "update").length, 1);
});

test("three confirmed diagnoses can discard the middle row and submit the remaining exact reorder", async () => {
  const fhir = diagnosisPickFhir();
  const pick = (diagnosisKey: string, action: "confirm" | "discard") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-08-27T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey, action, source: "catalog-search" },
  });

  const first = await pick("presbyopia", "confirm");
  const discarded = await pick("diplopia", "confirm");
  const third = await pick("anisometropia", "confirm");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal(third.status, 200, JSON.stringify(third.body));

  const firstReference = `Condition/${(first.body as { condition: Condition }).condition.id}`;
  const discardedReference = `Condition/${(discarded.body as { condition: Condition }).condition.id}`;
  const thirdReference = `Condition/${(third.body as { condition: Condition }).condition.id}`;
  const discard = await pick("diplopia", "discard");
  assert.equal(discard.status, 200, JSON.stringify(discard.body));

  const afterDiscard = await fhir.read<Encounter>("Encounter", "e1");
  assert.deepEqual(afterDiscard.diagnosis?.map((entry) => ({
    reference: entry.condition.reference,
    rank: entry.rank,
  })), [
    { reference: firstReference, rank: 1 },
    { reference: thirdReference, rank: 3 },
  ]);
  assert.equal(afterDiscard.diagnosis?.some((entry) => entry.condition.reference === discardedReference), false);
  const discardProvenance = [...fhir.resources].reverse().find((resource): resource is Provenance =>
    resource.resourceType === "Provenance" && resource.activity?.text === "discard encounter diagnosis"
  );
  assert.ok(discardProvenance);
  assert.equal(discardProvenance.target.some((target) => target.reference === "Encounter/e1"), true);

  const reordered = await handleDiagnosisOrderRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { conditionReferences: [thirdReference, firstReference] },
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual((reordered.body as { encounter: Encounter }).encounter.diagnosis?.map((entry) => ({
    reference: entry.condition.reference,
    rank: entry.rank,
  })), [
    { reference: firstReference, rank: 2 },
    { reference: thirdReference, rank: 1 },
  ]);
});

test("discard unlink is idempotent and confirm after discard relinks through the existing path", async () => {
  const fhir = diagnosisPickFhir();
  const pick = (action: "confirm" | "discard") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-08-27T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action, source: "catalog-search" },
  });

  const confirmed = await pick("confirm");
  const conditionReference = `Condition/${(confirmed.body as { condition: Condition }).condition.id}`;
  assert.equal((await pick("discard")).status, 200);
  assert.deepEqual((await fhir.read<Encounter>("Encounter", "e1")).diagnosis, []);
  const encounterWritesAfterFirstDiscard = fhir.writes.filter((write) =>
    write.resourceType === "Encounter" && write.operation === "update"
  ).length;

  const repeated = await pick("discard");
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(fhir.writes.filter((write) =>
    write.resourceType === "Encounter" && write.operation === "update"
  ).length, encounterWritesAfterFirstDiscard);
  const repeatedProvenance = [...fhir.resources].reverse().find((resource): resource is Provenance =>
    resource.resourceType === "Provenance" && resource.activity?.text === "discard encounter diagnosis"
  );
  assert.ok(repeatedProvenance);
  assert.equal(repeatedProvenance.target.some((target) => target.reference === "Encounter/e1"), false);

  const reconfirmed = await pick("confirm");
  assert.equal(reconfirmed.status, 200, JSON.stringify(reconfirmed.body));
  assert.deepEqual((reconfirmed.body as { encounter: Encounter }).encounter.diagnosis?.map((entry) => ({
    reference: entry.condition.reference,
    rank: entry.rank,
  })), [{ reference: conditionReference, rank: 1 }]);
});

test("discard returns reload-and-retry after the Encounter unlink exhausts conflict retries", async () => {
  class ConcurrentEncounterUpdateFhir extends MemoryFhir {
    encounterConflictsRemaining = 0;
    transactionInFlight = false;

    override async executeTransaction(
      bundle: Bundle,
      headers?: Record<string, string>,
      options?: { autoRollbackCreatedEntries?: boolean },
    ): Promise<Bundle> {
      if (this.encounterConflictsRemaining > 0) {
        this.encounterConflictsRemaining -= 1;
        const current = this.resources.find((candidate) => candidate.resourceType === "Encounter" && candidate.id === "e1")!;
        current.meta = { ...(current.meta ?? {}), versionId: String(Number(current.meta?.versionId ?? "0") + 1) };
      }
      this.transactionInFlight = true;
      try {
        return await super.executeTransaction(bundle, headers, options);
      } finally {
        this.transactionInFlight = false;
      }
    }

    override async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      if (resourceType === "Encounter" && !this.transactionInFlight && this.encounterConflictsRemaining > 0) {
        this.encounterConflictsRemaining -= 1;
        const current = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id)!;
        current.meta = { ...(current.meta ?? {}), versionId: String(Number(current.meta?.versionId ?? "0") + 1) };
      }
      return super.update(resourceType, id, resource, headers);
    }
  }

  const fhir = new ConcurrentEncounterUpdateFhir();
  fhir.resources.push(...diagnosisPickFhir().resources);
  const pick = (action: "confirm" | "discard") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action, source: "catalog-search" },
  });

  const confirmed = await pick("confirm");
  const conditionReference = `Condition/${(confirmed.body as { condition: Condition }).condition.id}`;
  fhir.encounterConflictsRemaining = 2;
  const discarded = await pick("discard");

  assert.equal(discarded.status, 409, JSON.stringify(discarded.body));
  assert.match(String((discarded.body as { error: string }).error), /reload and retry/);
  const encounter = await fhir.read<Encounter>("Encounter", "e1");
  assert.equal(encounter.diagnosis?.some((entry) => entry.condition.reference === conditionReference), true);

  const retried = await pick("discard");

  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal((await fhir.read<Condition>("Condition", conditionReference.split("/")[1]!)).verificationStatus?.coding?.[0]?.code, "refuted");
  assert.equal((await fhir.read<Encounter>("Encounter", "e1")).diagnosis?.some((entry) =>
    entry.condition.reference === conditionReference
  ), false);
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Condition").length, 1);
});

test("a signed Encounter refuses discard before changing the Condition or Encounter", async () => {
  const fhir = diagnosisPickFhir();
  const pick = (action: "confirm" | "discard") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action, source: "catalog-search" },
  });
  const confirmed = await pick("confirm");
  const condition = (confirmed.body as { condition: Condition }).condition;
  const encounter = fhir.resources.find((resource): resource is Encounter =>
    resource.resourceType === "Encounter" && resource.id === "e1"
  )!;
  encounter.status = "finished";
  const writesBeforeDiscard = fhir.writes.length;

  const discarded = await pick("discard");

  assert.equal(discarded.status, 409, JSON.stringify(discarded.body));
  assert.equal((discarded.body as { reason: string }).reason, "encounter-closed");
  assert.equal(fhir.writes.length, writesBeforeDiscard);
  assert.equal((await fhir.read<Condition>("Condition", condition.id!)).verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.equal((await fhir.read<Encounter>("Encounter", "e1")).diagnosis?.length, 1);
});

test("diagnosis pick Provenance targets the patient", async () => {
  const fhir = diagnosisPickFhir();
  const result = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action: "confirm", source: "catalog-search" },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const provenance = fhir.resources.find((resource): resource is Provenance =>
    resource.resourceType === "Provenance"
  );
  assert.ok(provenance);
  assert.equal(
    provenance.target.some((target) => target.reference === "Patient/p1"),
    true,
  );
});

test("a failed tally side effect never fails a successful explicit diagnosis pick", async () => {
  class TallyFailFhir extends MemoryFhir {
    override async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
      if (resource.resourceType === "Basic" && (resource as Basic).code.coding?.some((coding) => coding.code === DX_PICK_TALLY_CODE)) {
        throw new Error("simulated tally outage");
      }
      return super.create(resource, headers);
    }
  }
  const fhir = new TallyFailFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e1", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter, {
    resourceType: "Observation", id: "finding-1", status: "preliminary",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code: "cup_disc_ratio" }], text: "Cup/Disc" },
    subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-07-11T16:00:00.000Z", valueQuantity: { value: 0.6, unit: "ratio" },
    extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality", valueCodeableConcept: { coding: [{ code: "OD" }] } }],
  } as Observation);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...values) => errors.push(values.map(String).join(" "));
  try {
    const result = await handleDiagnosisPickRequest({
      authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "provider", fhir }),
      now: () => "2026-07-11T16:00:00.000Z",
    }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "e1" },
      body: { findingInstanceId: "finding-1", diagnosisKey: "glaucoma_suspect_open_angle_low", action: "confirm" },
    });
    assert.equal(result.status, 200);
    assert.equal(fhir.resources.some((resource) => resource.resourceType === "Condition"), true);
    assert.equal(errors.some((message) => message.includes("simulated tally outage")), true);
  } finally {
    console.error = originalError;
  }
});

test("dedup keeps rule evidence and the higher-priority mapping when no rule exists", () => {
  const rows = deduplicateDiagnosisCandidates([
    { diagnosisKey: "alpha", display: "Alpha", codingStatus: "verified", priority: true, source: "mapping", order: 0 },
    { diagnosisKey: "alpha", display: "Alpha", codingStatus: "verified", priority: false, source: "rule", order: 9 },
    { diagnosisKey: "beta", display: "Beta", codingStatus: "verified", priority: false, source: "mapping", order: 0 },
    { diagnosisKey: "beta", display: "Beta", codingStatus: "verified", priority: true, source: "mapping", order: 3 },
  ]);
  assert.equal(rows.find((row) => row.diagnosisKey === "alpha")?.source, "rule");
  assert.equal(rows.find((row) => row.diagnosisKey === "beta")?.priority, true);
});

type CandidateResponse = {
  findings: Array<{
    findingDefinitionKey?: string;
    observationReference?: string;
    candidates: Array<{
      diagnosisKey?: string;
      supportingFacts?: Array<{ rowKey: string; key: CurrentFindingKey; baseline: { kind: "canonical"; reference: string; versionId: string } }>;
      familyGroup?: string;
      clinicalFamily?: string;
      display: string;
      axisLabel?: string;
      members?: Array<{ stableKey: string; stageLabel: string }>;
      priority: boolean;
      source: string;
      icd10?: { code?: string };
    }>;
    suppressedCandidates?: Array<{ diagnosisKey: string; source: string; icd10?: { code?: string } }>;
    suppression?: { message: string; overridable: boolean };
  }>;
};

function candidateSupport(observation: Observation) {
  assert.ok(observation);
  const envelope = parseCurrentFindingEnvelope(observation);
  assert.equal(envelope.status, "valid");
  if (envelope.status !== "valid") throw new Error(envelope.reason);
  return { rowKey: `finding:${currentFindingIdentifier(envelope.key).value!}`, key: envelope.key,
    baseline: { kind: "canonical", reference: `Observation/${observation.id}`, versionId: observation.meta!.versionId! } };
}

async function ocularCandidateKeys(
  stableKey: string,
  eyes: Partial<Record<"OD" | "OS", {
    selections: string[];
    findingDetails?: Record<string, Record<string, string>>;
  }>>,
): Promise<string[][]> {
  const fhir = new MemoryFhir();
  fhir.resources.push(testEncounter("e-qualified", "p-qualified"));
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
  assert.ok(definition);
  const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
    .find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "provider" as PracticeRoleId,
    fhir,
  });
  const capture = await captureCustomSectionFixture({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-08-04T12:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey },
    body: {
      patientReference: "Patient/p-qualified",
      encounterReference: "Encounter/e-qualified",
      eyes: Object.fromEntries(Object.entries(eyes).map(([eye, row]) => [eye, {
        state: "abnormal",
        customFields: [{ code: field.localCode, value: row.selections }],
        ...(row.findingDetails ? { findingDetails: row.findingDetails } : {}),
      }])),
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-qualified" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body as CandidateResponse).findings.map((finding) =>
    finding.candidates.map((candidate) => candidate.diagnosisKey)
  );
}

function diagnosisPickFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e1", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter, ...(["OD", "OS"] as const).map((eye) => ({
    resourceType: "Observation",
    id: `finding-${eye.toLowerCase()}`,
    status: "preliminary",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code: "cup_disc_ratio" }], text: "Cup/Disc" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-07-11T16:00:00.000Z",
    valueQuantity: { value: 0.6, unit: "ratio" },
    extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality", valueCodeableConcept: { coding: [{ code: eye }] } }],
  } as Observation)));
  return fhir;
}

function sourcedDiagnosisCode(
  stableKey: string,
  laterality: "right" | "left" | "bilateral" | "unspecifiedEye",
): string {
  const row = buildDiagnosisCatalogSeeds().find((candidate) => candidate.stableKey === stableKey);
  if (!row?.icd10 || "code" in row.icd10) throw new Error(`Diagnosis ${stableKey} has no sourced laterality pattern.`);
  const code = row.icd10.pattern[laterality];
  if (!code || (row.provenance.ledgerRefs?.length ?? 0) < 2) throw new Error(`Diagnosis ${stableKey} is not backed by two ledger sources.`);
  return code;
}

async function candidates(base: string, authorization: string): Promise<CandidateResponse> {
  const response = await fetch(`${base}/clinical-graph/encounters/e1/diagnosis-candidates`, { headers: { Authorization: authorization } });
  const body = await response.json() as CandidateResponse;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function post(base: string, path: string, body: unknown, authorization: string, expected = 200): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}

test("W10 supported pick is a Condition-only step and retains its full response", async () => {
  const fhir = diagnosisPickFhir();
  const observation = canonicalFact();
  fhir.resources.push(observation);
  const result = await handleDiagnosisPickRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) } as any, {
    authHeader: "Bearer doctor", params: { encounterId: "e1" },
    body: { diagnosisKey: "presbyopia", action: "confirm", commandId: "11111111-1111-4111-8111-111111111111", supportingFacts: [{ key: keyFor(), baseline: { kind: "canonical", reference: `Observation/${observation.id}`, versionId: observation.meta!.versionId } }] },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as any;
  assert.equal(body.result, "pick"); assert.equal(body.conditionStep, "applied"); assert.equal(body.link, "pending");
  assert.equal(body.condition.evidence, undefined);
  assert.ok(body.encounter); assert.ok(body.provenanceReference); assert.equal(body.strandedChargesComputed, true);
  assert.equal(fhir.writes.some(w => w.resourceType === "Observation"), false);
  const provenance = fhir.resources.find(r => r.resourceType === "Provenance") as Provenance;
  assert.equal(provenance.entity?.some(e => e.what.reference?.startsWith("Observation/")), false);
});

test("W35 empty stale foreign supports refuse before Condition writes", async (t) => {
  for (const kind of ["empty", "stale", "foreign"] as const) await t.test(kind, async () => {
    const fhir = diagnosisPickFhir(); const observation = canonicalFact(); fhir.resources.push(observation);
    const result = await handleDiagnosisPickRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) } as any, {
      authHeader: "Bearer doctor", params: { encounterId: "e1" }, body: { diagnosisKey: "presbyopia", action: "confirm", commandId: "11111111-1111-4111-8111-111111111111", supportingFacts: kind === "empty" ? [] : [{ key: { ...keyFor(), ...(kind === "foreign" ? { patientId: "other" } : {}) }, baseline: { kind: "canonical", reference: `Observation/${observation.id}`, versionId: kind === "stale" ? "old" : observation.meta!.versionId } }] },
    });
    assert.equal(result.status, 400); assert.equal((result.body as any).result, "invalid"); assert.equal(fhir.writes.length, 0); assert.equal(fhir.transactions.length, 0);
  });
});

test("W30 candidates use current projection and omit superseded snapshot suggestions", async () => {
  const fhir = diagnosisPickFhir();
  const old = snapshot("old", ["nuclear-sclerosis"]); old.effectiveDateTime = "2026-01-01T00:00:00Z";
  const latest = snapshot("latest", []); latest.effectiveDateTime = "2026-01-02T00:00:00Z";
  fhir.resources.push(old, latest);
  const result = await handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const rows = (result.body as any).findings.filter((r: any) => r.findingDefinitionKey === keyFor().stableKey);
  assert.deepEqual(rows.flatMap((r: any) => r.candidates), []);
});

function testEncounter(id: string, patientId: string): Encounter { return { resourceType: "Encounter", id, status: "in-progress", class: { code: "AMB" }, subject: { reference: `Patient/${patientId}` } }; }

test("mixed option definition preserves numeric panel context in current candidates", async () => {
  const fhir = diagnosisPickFhir(); const store = new FhirFindingDefinitionStore(fhir);
  const definition = (await store.list()).find(d => d.stableKey === keyFor().stableKey)!;
  await store.save({ ...definition, valueSchema: { ...definition.valueSchema, fields: { ...(definition.valueSchema.fields as object), numericContext: { localCode: "CUSTOM_CONTEXT", display: "Context", valueType: "number", origin: "practice", active: true, order: 2 } } }, diagnosisCandidates: [
    { id: "mixed-context", diagnosisKey: "presbyopia", trigger: { kind: "allOf", triggers: [ { kind: "option", field: keyFor().fieldCode, anyOf: [keyFor().optionCode] }, { kind: "numeric", field: "CUSTOM_CONTEXT", op: ">", value: 1 } ] }, active: true, origin: "practice" },
  ] });
  const {fieldCode: _field, optionCode: _option, ...panelKey} = keyFor();
  const panel = snapshot("panel", []); panel.identifier = [findingPanelIdentifier(panelKey)]; panel.component = [comp("R10_PANEL_META",JSON.stringify(panelKey)),comp("CUSTOM_CONTEXT", 3)];
  fhir.resources.push(canonicalFact(), panel);
  const result = await handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = (result.body as any).findings.find((r: any) => r.findingDefinitionKey === definition.stableKey);
  assert.equal(row.candidates[0]?.diagnosisKey, "presbyopia");
  assert.equal(row.candidates[0]?.supportingFacts.length, 1);
});

function supportedPick(fhir: MemoryFhir, body: Record<string, unknown> = {}) {
  const fact = fhir.resources.find(r => r.resourceType === "Observation" && r.id === "canonical")!;
  return handleDiagnosisPickRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) } as any, {
    authHeader: "Bearer doctor", params: { encounterId: "e1" }, body: { diagnosisKey: "presbyopia", action: "confirm", commandId: "11111111-1111-4111-8111-111111111111",
      supportingFacts: [{ key: keyFor(), baseline: { kind: "canonical", reference: `Observation/${fact.id}`, versionId: fact.meta!.versionId } }], ...body },
  });
}

test("supported pick validates every support and explicit eye union before all writes", async (t) => {
  for (const kind of ["duplicate", "missing-command", "wrong-command", "eye", "retired", "absent", "signed", "cancelled", "conflict", "legacy", "foreign-home", "wrong-view"] as const) await t.test(kind, async () => {
    const fhir = diagnosisPickFhir(); const fact = canonicalFact();
    if (kind === "retired") fact.status = "entered-in-error";
    if (kind === "absent") fact.valueBoolean = false;
    if (kind === "signed") fact.status = "final";
    if (kind === "cancelled") fact.status = "cancelled";
    if (kind === "foreign-home") fact.extension!.push({ url: SUPPORTS_DIAGNOSIS_URL, valueReference: { reference: "Condition/foreign" } });
    fhir.resources.push(fact);
    if (kind === "conflict") fhir.resources.push(canonicalFact("duplicate-owner"));
    if (kind === "legacy") fhir.resources.push(snapshot());
    const support = { key: keyFor(), baseline: { kind: "canonical", reference: "Observation/canonical", versionId: fact.meta!.versionId } };
    const body = kind === "duplicate" ? { supportingFacts: [support, support] } : kind === "missing-command" ? { commandId: undefined } : kind === "wrong-command" ? { commandId: "11111111-1111-1111-8111-111111111111" } : kind === "eye" ? { laterality: "OS" } : kind === "wrong-view" ? { findingInstanceId: "definition:foreign:OD" } : {};
    const result = await supportedPick(fhir, body);
    assert.equal(result.status, kind === "legacy" ? 409 : kind === "signed" || kind === "cancelled" ? 422 : 400, JSON.stringify(result.body));
    assert.equal(result.body.result, "invalid"); assert.equal(fhir.writes.length, 0); assert.equal(fhir.transactions.length, 0);
  });
});

test("supported bilateral pick unions eyes, then discard remains a Condition step without a link", async () => {
  const fhir = diagnosisPickFhir(); fhir.resources.push(canonicalFact(), canonicalFact("canonical-os", "OS"));
  const supportingFacts = ["OD", "OS"].map(eye => ({ key: keyFor(eye as "OD" | "OS"), baseline: { kind: "canonical", reference: eye === "OD" ? "Observation/canonical" : "Observation/canonical-os", versionId: "v1" } }));
  const applied = await supportedPick(fhir, { diagnosisKey: "cataract_nuclear_sclerosis", supportingFacts, laterality: "OU" });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal((applied.body as any).condition.code.coding[0].code, sourcedDiagnosisCode("cataract_nuclear_sclerosis", "bilateral"));
  assert.equal((applied.body as any).condition.evidence, undefined);
  const discarded = await supportedPick(fhir, { diagnosisKey: "cataract_nuclear_sclerosis", supportingFacts, action: "discard" });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal((discarded.body as any).conditionStep, "applied"); assert.equal((discarded.body as any).link, "not-applicable");
});

test("projected no-id pick without supports performs only the Condition step", async () => {
  const fhir = diagnosisPickFhir(); fhir.resources.push(canonicalFact());
  const result = await handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  const row = (result.body as any).findings.find((r: any) => r.findingDefinitionKey === keyFor().stableKey);
  assert.equal(row.observationReference, undefined); assert.equal(row.contributors[0].reference, "Observation/canonical");
  const picked = await supportedPick(fhir, { supportingFacts: undefined, commandId: undefined, findingInstanceId: row.findingInstanceId });
  assert.equal(picked.status, 200, JSON.stringify(picked.body)); assert.equal((picked.body as any).link, "not-applicable");
  assert.equal((picked.body as any).condition.evidence, undefined);
});

test("pick reports failed and unconfirmed Condition steps without pretending load failure", async (t) => {
  for (const cause of [403, undefined]) await t.test(String(cause), async () => {
    const fhir = diagnosisPickFhir(); fhir.resources.push(canonicalFact());
    fhir.executeTransaction = async () => { throw Object.assign(new Error("synthetic transaction failure"), { status: cause }); };
    const result = await supportedPick(fhir);
    assert.equal(result.status, cause ?? 502); assert.equal(result.body.result, "pick");
    assert.equal((result.body as any).conditionStep, cause ? "failed" : "unconfirmed"); assert.equal((result.body as any).link, "pending");
  });
});

test("W29 Cup/Disc measurement pick retains Observation evidence and Provenance entity", async () => {
  const fhir = diagnosisPickFhir();
  const result = await handleDiagnosisPickRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) } as any, {
    authHeader: "Bearer doctor", params: { encounterId: "e1" }, body: { diagnosisKey: "glaucoma_suspect_open_angle_low", action: "confirm", findingInstanceId: "finding-od" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal((result.body as any).link, "not-applicable");
  assert.equal((result.body as any).condition.evidence[0].detail[0].reference, "Observation/finding-od");
  assert.equal((fhir.resources.find(r => r.resourceType === "Provenance") as Provenance).entity?.[0].what.reference, "Observation/finding-od");
});

test("pick finds an existing diagnosis on page two instead of creating another", async () => {
  const fhir = diagnosisPickFhir();
  const first = await handleDiagnosisPickRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) } as any, { authHeader: "Bearer doctor", params: { encounterId: "e1" }, body: { diagnosisKey: "presbyopia", action: "possible" } });
  const condition = (first.body as any).condition;
  const search = fhir.search.bind(fhir);
  fhir.search = async (type: any, params: any) => type === "Condition" ? { resourceType: "Bundle", type: "searchset", entry: [], link: [{ relation: "next", url: "Condition?cursor=2" }] } : search(type, params);
  (fhir as any).searchUrl = async () => ({ resourceType: "Bundle", type: "searchset", entry: [{ resource: condition }] });
  const picked = await handleDiagnosisPickRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) } as any, { authHeader: "Bearer doctor", params: { encounterId: "e1" }, body: { diagnosisKey: "presbyopia", action: "confirm" } });
  assert.equal(picked.status, 200, JSON.stringify(picked.body)); assert.equal((picked.body as any).condition.id, condition.id);
  assert.equal(fhir.resources.filter(r => r.resourceType === "Condition").length, 1);
});

test("option candidates recursively collect trigger supports and union duplicate diagnosis supports", async () => {
  const fhir = diagnosisPickFhir(); const store = new FhirFindingDefinitionStore(fhir);
  const definition = (await store.list()).find(d => d.stableKey === keyFor().stableKey)!;
  await store.save({ ...definition, diagnosisCandidates: [
    { id: "nuclear", diagnosisKey: "presbyopia", trigger: { kind: "allOf", triggers: [{ kind: "option", field: keyFor().fieldCode, anyOf: ["nuclear-sclerosis"] }, { kind: "qualifier", field: keyFor().fieldCode, option: "nuclear-sclerosis", qualifiers: { grade: "2+" } }] }, active: true, origin: "practice" },
    { id: "cortical", diagnosisKey: "presbyopia", trigger: { kind: "option", field: keyFor().fieldCode, anyOf: ["cortical-cataract"] }, active: true, origin: "practice" },
    { id: "always", diagnosisKey: "ocular_hypertension", trigger: { kind: "always" }, active: true, origin: "practice" },
    { id: "abnormal", diagnosisKey: "glaucoma_suspect_open_angle_low", trigger: { kind: "abnormal" }, active: true, origin: "practice" },
  ] });
  const nuclear = canonicalFact(); nuclear.component!.push({ code: { coding: [{ code: `${keyFor().fieldCode}::nuclear-sclerosis::grade` }] }, valueCodeableConcept: { coding: [{ code: "2+" }] } });
  const cortical = canonicalFact("cortical"); const key = keyFor("OD", "cortical-cataract");
  cortical.identifier = [currentFindingIdentifier(key)]; cortical.code.coding![0].code = `${key.stableKey}::${key.fieldCode}::${key.optionCode}`;
  cortical.component = [comp("R10_CURRENT_META", JSON.stringify(key))];
  fhir.resources.push(nuclear, cortical);
  const get = () => handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider" as const, fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  const result = await get(); assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = (result.body as any).findings.find((r: any) => r.findingDefinitionKey === definition.stableKey);
  assert.equal(row.candidates.length, 3);
  for (const candidate of row.candidates) assert.deepEqual(candidate.supportingFacts.map((f: any) => f.key.optionCode).sort(), ["cortical-cataract", "nuclear-sclerosis"]);
  assert.equal(new Set(row.candidates[0].supportingFacts.map((f: any) => f.rowKey)).size, 2);
  fhir.resources.push(snapshot("legacy-other", [], "OS"));
  const preRebuild = await get();
  const legacyRow = (preRebuild.body as any).findings.find((r: any) => r.findingDefinitionKey === definition.stableKey);
  assert.equal(legacyRow.candidates.every((c: any) => c.supportingFacts === undefined), true);
  assert.equal(legacyRow.linkable, false);
});

test("§3.7 option-trigger supports exclude unrelated present options without diagnosis deduplication", async () => {
  const fhir = diagnosisPickFhir(); const store = new FhirFindingDefinitionStore(fhir);
  const definition = (await store.list()).find(d => d.stableKey === keyFor().stableKey)!;
  await store.save({ ...definition, diagnosisCandidates: [
    { id: "nuclear-only", diagnosisKey: "presbyopia", trigger: { kind: "option", field: keyFor().fieldCode, anyOf: ["nuclear-sclerosis"] }, active: true, origin: "practice" },
  ] });
  const cortical = canonicalFact("cortical"); const key = keyFor("OD", "cortical-cataract");
  cortical.identifier = [currentFindingIdentifier(key)]; cortical.code.coding![0].code = `${key.stableKey}::${key.fieldCode}::${key.optionCode}`;
  cortical.component = [comp("R10_CURRENT_META", JSON.stringify(key))];
  fhir.resources.push(canonicalFact(), cortical);
  const result = await handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider" as const, fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = (result.body as any).findings.find((r: any) => r.findingDefinitionKey === definition.stableKey);
  assert.equal(row.candidates.length, 1);
  assert.equal(row.candidates[0].diagnosisKey, "presbyopia");
  assert.deepEqual(row.candidates[0].supportingFacts.map((f: any) => f.key.optionCode), ["nuclear-sclerosis"]);
});

test("mixed panel context uses its unique owner and refuses a second owner regardless of time", async () => {
  const fhir = diagnosisPickFhir(); const store = new FhirFindingDefinitionStore(fhir);
  const definition = (await store.list()).find(d => d.stableKey === keyFor().stableKey)!;
  await store.save({ ...definition, valueSchema: { ...definition.valueSchema, fields: { ...(definition.valueSchema.fields as object), numericContext: { localCode: "CUSTOM_CONTEXT", display: "Context", valueType: "number", origin: "practice", active: true, order: 2 } } }, diagnosisCandidates: [
    { id: "numeric-context", diagnosisKey: "presbyopia", trigger: { kind: "numeric", field: "CUSTOM_CONTEXT", op: ">", value: 1 }, active: true, origin: "practice" },
  ] });
  const {fieldCode: _field, optionCode: _option, ...panelKey} = keyFor();
  const panel = (id: string, time: string, value: number) => ({ ...snapshot(id, []), effectiveDateTime: time, identifier: [findingPanelIdentifier(panelKey)], component: [comp("R10_PANEL_META",JSON.stringify(panelKey)),comp("CUSTOM_CONTEXT", value)] });
  fhir.resources.push(canonicalFact(), panel("new-panel", "2026-01-02T00:00:00Z", 3));
  const get = () => handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider" as const, fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  const result = await get(); assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = (result.body as any).findings.find((r: any) => r.findingDefinitionKey === definition.stableKey);
  assert.equal(row.candidates[0].diagnosisKey, "presbyopia"); assert.equal(row.candidates[0].supportingFacts, undefined); assert.equal(row.linkable, false); assert.equal(row.candidates[0].linkable, false);
  assert.equal(row.contributors.some((c: any) => c.reference === "Observation/new-panel"), true);
  assert.equal(row.contributors.some((c: any) => c.reference === "Observation/old-panel"), false);
  fhir.resources.push(panel("conflicting-panel", "2026-01-01T00:00:00Z", 0));
  const refused = await get(); assert.equal(refused.status, 502); assert.equal((refused.body as any).result, "unavailable");
  const pick = await supportedPick(fhir); assert.equal(pick.status, 502); assert.equal(fhir.transactions.length, 0);
});

test("applied Condition remains reported when the visit-status side effect fails", async () => {
  const fhir = diagnosisPickFhir();
  const result = await handleDiagnosisPickRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }), diagnosisVisitStatusStore: { upsert: async () => { throw new Error("Synthetic status-store outage"); } } } as any, {
    authHeader: "Bearer doctor", params: { encounterId: "e1" }, body: { diagnosisKey: "presbyopia", action: "confirm", status: "new" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal((result.body as any).conditionStep, "applied");
  assert.ok((result.body as any).condition.id); assert.match((result.body as any).error, /visit status/i);
});

test("transaction conflict is a failed pick step with its HTTP cause", async () => {
  const fhir = diagnosisPickFhir(); fhir.resources.push(canonicalFact());
  fhir.executeTransaction = async () => { throw Object.assign(new Error("synthetic conflict"), { status: 409 }); };
  const result = await supportedPick(fhir); assert.equal(result.status, 409); assert.equal(result.body.result, "pick");
  assert.equal((result.body as any).conditionStep, "failed"); assert.equal((result.body as any).link, "pending");
});

test("candidates consume page-two encounter observations and patient diagnosis history", async () => {
  const fhir = diagnosisPickFhir(); const search = fhir.search.bind(fhir);
  const history: Condition = { resourceType: "Condition", id: "history", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/prior" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: sourcedDiagnosisCode("poag_severe", "right") }] },
    verificationStatus: { coding: [{ code: "confirmed" }] }, clinicalStatus: { coding: [{ code: "active" }] } };
  fhir.search = async (type: any, params: any) => type === "Observation" || type === "Condition" && params.subject
    ? { resourceType: "Bundle", type: "searchset", entry: [], link: [{ relation: "next", url: `${type}?cursor=second` }] } : search(type, params);
  (fhir as any).searchUrl = async (_url: string, type: string) => ({ resourceType: "Bundle", type: "searchset", entry: (type === "Condition" ? [history] : fhir.resources.filter(r => r.resourceType === "Observation")).map(resource => ({ resource })) });
  const result = await handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = (result.body as any).findings.find((r: any) => r.observationReference === "Observation/finding-od");
  assert.deepEqual(row.candidates.filter((c: any) => c.familyGroup).map((c: any) => c.familyGroup), ["primary-open-angle-glaucoma", "low-tension-glaucoma"]);
  assert.equal(row.candidates.every((c: any) => c.supportingFacts === undefined), true);
});

test("candidate history pagination errors are unavailable rather than empty candidates", async () => {
  const fhir = diagnosisPickFhir(); const search = fhir.search.bind(fhir);
  fhir.search = async (type: any, params: any) => type === "Condition" && params.subject
    ? { resourceType: "Bundle", type: "searchset", entry: [], link: [{ relation: "next", url: "https://foreign.invalid/fhir/R4/Condition?cursor=second" }] } : search(type, params);
  const result = await handleDiagnosisCandidatesRequest({ authenticate: async () => ({ staffReference: "Practitioner/doctor", actorRole: "provider", fhir }) }, { authHeader: "Bearer doctor", params: { encounterId: "e1" } });
  assert.equal(result.status, 502); assert.equal((result.body as any).result, "unavailable"); assert.equal((result.body as any).kind, "upstream");
});
