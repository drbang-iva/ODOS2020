#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import {
  applyDecisionFile,
  listPendingDecisions,
  runInteractiveAdjudication,
} from "../mcp/src/legacy-import/adjudication-loop.js";
import {
  DEFAULT_M2A_STATE_DIR,
  ImportLedger,
} from "../mcp/src/legacy-import/import-ledger.js";

export async function runAdjudicationCli(input: {
  readonly stateDirectory: string;
  readonly runId?: string;
  readonly patientSourceKey?: string;
  readonly decisionsPath?: string;
  readonly decidedBy?: string;
  readonly prompt?: (question: string) => Promise<string>;
}): Promise<{
  readonly recorded: number;
  readonly previouslyDecided: number;
  readonly asked: number;
  readonly pending: number;
}> {
  const ledger = new ImportLedger({ stateDirectory: input.stateDirectory });
  try {
    let recorded = 0;
    let previouslyDecided = 0;
    let asked = 0;
    if (input.decisionsPath) {
      const result = applyDecisionFile(
        ledger,
        JSON.parse(readFileSync(input.decisionsPath, "utf8")),
      );
      recorded = result.recorded;
      previouslyDecided = result.previouslyDecided;
    } else {
      if (!input.decidedBy) throw new Error("--decided-by is required for interactive mode.");
      if (!input.prompt) {
        throw new Error("Interactive adjudication requires a TTY; use --decisions for replay.");
      }
      const result = await runInteractiveAdjudication({
        ledger,
        decidedBy: input.decidedBy,
        runId: input.runId,
        patientSourceKey: input.patientSourceKey,
        prompt: input.prompt,
      });
      recorded = result.recorded;
      asked = result.asked;
    }
    const pending = listPendingDecisions(ledger, {
      runId: input.runId,
      patientSourceKey: input.patientSourceKey,
    }).length;
    if (input.runId) ledger.writeReport(input.runId);
    return { recorded, previouslyDecided, asked, pending };
  } finally {
    ledger.close();
  }
}

function cliArguments(args: readonly string[]): {
  stateDirectory: string;
  runId?: string;
  patientSourceKey?: string;
  decisionsPath?: string;
  decidedBy?: string;
} {
  const runId = optionalArgument(args, "--run-id");
  const patientSourceKey = optionalArgument(args, "--patient");
  if (!runId && !patientSourceKey) {
    throw new Error("Choose --run-id or --patient.");
  }
  if (runId && patientSourceKey) {
    throw new Error("Choose either --run-id or --patient, not both.");
  }
  const decisionsPath = optionalArgument(args, "--decisions");
  return {
    stateDirectory: resolve(optionalArgument(args, "--state-dir") ?? DEFAULT_M2A_STATE_DIR),
    ...(runId ? { runId } : {}),
    ...(patientSourceKey ? { patientSourceKey } : {}),
    ...(decisionsPath ? { decisionsPath: resolve(decisionsPath) } : {}),
    ...(optionalArgument(args, "--decided-by")
      ? { decidedBy: optionalArgument(args, "--decided-by") }
      : {}),
  };
}

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let readline: ReturnType<typeof createInterface> | undefined;
  try {
    const args = cliArguments(process.argv.slice(2));
    if (!args.decisionsPath && process.stdin.isTTY && process.stdout.isTTY) {
      readline = createInterface({ input: process.stdin, output: process.stdout });
    }
    const result = await runAdjudicationCli({
      ...args,
      ...(readline ? { prompt: (question: string) => readline!.question(question) } : {}),
    });
    console.log(
      `M2B2 decisions recorded=${result.recorded} prior=${result.previouslyDecided} `
      + `asked=${result.asked} pending=${result.pending}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    readline?.close();
  }
}
