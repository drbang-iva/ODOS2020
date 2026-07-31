#!/usr/bin/env tsx
import { resolve } from "node:path";
import {
  generateVisitImportManifests,
  isDirectExecution,
  parseExpectedChartCount,
  parseGeneratorCliArguments,
  resolveSetupStatePath,
  shellArgument,
} from "./legacy-import-manifest-generator.js";

export function parseVisitManifestGeneratorArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): {
  readonly appointmentsExportPath: string;
  readonly examsTsvPath: string;
  readonly patientReferencesPath: string;
  readonly visitTypeMapPath: string;
  readonly setupStatePath: string;
  readonly outputDirectory: string;
  readonly expectedChartCount: number;
} {
  const parsed = parseGeneratorCliArguments(args, {
    required: [
      "--appointments",
      "--exams",
      "--patient-references",
      "--visit-type-map",
      "--expected-charts",
      "--output",
    ],
    optional: ["--setup-state"],
  });
  return {
    appointmentsExportPath: resolve(parsed["--appointments"]!),
    examsTsvPath: resolve(parsed["--exams"]!),
    patientReferencesPath: resolve(parsed["--patient-references"]!),
    visitTypeMapPath: resolve(parsed["--visit-type-map"]!),
    expectedChartCount: parseExpectedChartCount(parsed["--expected-charts"]!),
    setupStatePath: resolveSetupStatePath(
      parsed["--setup-state"],
      environment,
    ),
    outputDirectory: resolve(parsed["--output"]!),
  };
}

if (isDirectExecution(import.meta.url, process.argv[1]!)) {
  try {
    const result = generateVisitImportManifests(
      parseVisitManifestGeneratorArguments(process.argv.slice(2)),
    );
    console.log(
      `Generated ${result.charts.length} visit manifests, appointment slices, and exam slices; `
      + `source appointments=${result.sourceAppointmentRows}, `
      + `target appointments=${result.targetAppointmentRows}, target exams=${result.targetExamRows}.`,
    );
    console.log(
      `Source appointment rows by office: ${
        Object.entries(result.sourceAppointmentRowsByOffice)
          .map(([officeNumber, count]) => `${officeNumber}=${count}`)
          .join(", ")
      }.`,
    );
    console.log(`Mapped target appt_type values: ${result.visitTypes.join(", ") || "(none)"}.`);
    console.log(
      `npm run import-legacy-bulk-m2b2 -- --bulk-manifest ${
        shellArgument(result.bulkManifestPath)
      }`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
