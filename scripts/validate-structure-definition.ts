#!/usr/bin/env tsx
import { readFileSync } from "node:fs";

const REQUIRED_SLICES = [
  "oauth_metadata",
  "risk_class",
  "phi_boundary",
  "launch_mode",
  "network_egress",
  "external_services_required",
  "baa_required",
  "image_analysis_prohibited",
  "allowedJurisdictions",
  "prohibitedStates",
  "scope_request_canonical",
];

const REQUIRED_OAUTH_SLICES = [
  "client_type",
  "token_endpoint_auth_method",
  "jwks_uri",
  "redirect_uris",
  "launch_uri",
  "default_scope",
  "allowed_origin",
];

export function validateSmartClientAppStructureDefinition(path: string): string[] {
  const issues: string[] = [];
  const resource = JSON.parse(readFileSync(path, "utf8")) as {
    resourceType?: string;
    url?: string;
    type?: string;
    baseDefinition?: string;
    context?: Array<{ type?: string; expression?: string }>;
    differential?: { element?: Array<{ id?: string; sliceName?: string; fixedBoolean?: boolean; fixedUri?: string }> };
  };
  if (resource.resourceType !== "StructureDefinition") issues.push("resourceType must be StructureDefinition");
  if (resource.url !== "https://osod.dev/fhir/StructureDefinition/smart-client-app") issues.push("unexpected url");
  if (resource.type !== "Extension") issues.push("type must be Extension");
  if (resource.baseDefinition !== "http://hl7.org/fhir/StructureDefinition/Extension") issues.push("baseDefinition must be the FHIR R4 Extension base");
  const contexts = new Set(resource.context?.map((context) => context.expression));
  if (!contexts.has("Endpoint")) issues.push("Endpoint context is required");
  if (!contexts.has("Device")) issues.push("Device context is required");
  const sliceNames = new Set(resource.differential?.element?.map((element) => element.sliceName).filter(Boolean));
  for (const slice of REQUIRED_SLICES) {
    if (!sliceNames.has(slice)) issues.push(`missing extension slice ${slice}`);
  }
  for (const slice of REQUIRED_OAUTH_SLICES) {
    if (!sliceNames.has(slice)) issues.push(`missing oauth_metadata slice ${slice}`);
  }
  const imageFixed = resource.differential?.element?.some(
    (element) => element.id === "Extension.extension:image_analysis_prohibited.valueBoolean" && element.fixedBoolean === true,
  );
  if (!imageFixed) issues.push("image_analysis_prohibited must fix valueBoolean true");
  const fixedUrl = resource.differential?.element?.some(
    (element) =>
      element.id === "Extension.url" &&
      element.fixedUri === "https://osod.dev/fhir/StructureDefinition/smart-client-app",
  );
  if (!fixedUrl) issues.push("Extension.url fixedUri is required");
  return issues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx scripts/validate-structure-definition.ts data/canonical-extensions/smart-client-app.json");
    process.exitCode = 2;
  } else {
    const issues = validateSmartClientAppStructureDefinition(path);
    if (issues.length) {
      console.error(issues.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`${path}: FHIR R4 StructureDefinition shape accepted`);
    }
  }
}
