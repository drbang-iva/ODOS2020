#!/usr/bin/env tsx
import { resolve } from "node:path";
import {
  generatePatientImportManifests,
  isDirectExecution,
  parseExpectedChartCount,
  parseGeneratorCliArguments,
  shellArgument,
} from "./legacy-import-manifest-generator.js";

export function parsePatientManifestGeneratorArguments(args: readonly string[]): {
  readonly patientExportPath: string;
  readonly ehrPeoplePath: string;
  readonly outputDirectory: string;
  readonly expectedChartCount: number;
} {
  const parsed = parseGeneratorCliArguments(args, {
    required: ["--patients", "--ehr-people", "--expected-charts", "--output"],
  });
  return {
    patientExportPath: resolve(parsed["--patients"]!),
    ehrPeoplePath: resolve(parsed["--ehr-people"]!),
    expectedChartCount: parseExpectedChartCount(parsed["--expected-charts"]!),
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
