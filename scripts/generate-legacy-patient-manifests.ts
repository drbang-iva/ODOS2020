#!/usr/bin/env tsx
import { resolve } from "node:path";
import {
  generatePatientImportManifests,
  isDirectExecution,
  parseGeneratorCliArguments,
  shellArgument,
} from "./legacy-import-manifest-generator.js";

export function parsePatientManifestGeneratorArguments(args: readonly string[]): {
  readonly patientExportPath: string;
  readonly ehrPeoplePath: string;
  readonly outputDirectory: string;
} {
  const parsed = parseGeneratorCliArguments(args, {
    required: ["--patients", "--ehr-people", "--output"],
  });
  return {
    patientExportPath: resolve(parsed["--patients"]!),
    ehrPeoplePath: resolve(parsed["--ehr-people"]!),
    outputDirectory: resolve(parsed["--output"]!),
  };
}

if (isDirectExecution(import.meta.url, process.argv[1]!)) {
  try {
    const result = generatePatientImportManifests(
      parsePatientManifestGeneratorArguments(process.argv.slice(2)),
    );
    console.log(
      `Generated ${result.manifests.length} patient manifests with `
      + `${result.classifiedJunkRows} approved junk source rows.`,
    );
    for (const entry of result.manifests) {
      console.log(
        `npm run import-legacy-patient-m2a -- ${
          entry.importArguments.map(shellArgument).join(" ")
        }`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
