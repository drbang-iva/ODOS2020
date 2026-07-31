import { z } from "zod";
import type { ImportLedger } from "./import-ledger.js";

const legacyVisitBulkFileChartSchema = z.object({
  chartKey: z.string().trim().min(1),
  manifestPath: z.string().trim().min(1),
  appointmentsPath: z.string().trim().min(1),
  examsPath: z.string().trim().min(1),
}).strict();

export const legacyVisitBulkManifestSchema = z.object({
  charts: z.array(legacyVisitBulkFileChartSchema).min(1),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, chart] of value.charts.entries()) {
    if (keys.has(chart.chartKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["charts", index, "chartKey"],
        message: "Bulk chart keys must be unique.",
      });
    }
    keys.add(chart.chartKey);
  }
});

export type LegacyVisitBulkFileChart = z.infer<typeof legacyVisitBulkFileChartSchema>;

export interface LegacyVisitBulkChart {
  readonly chartKey: string;
}

export interface LegacyVisitBulkChartResult {
  readonly chartKey: string;
  readonly runId: string;
  readonly status: "completed" | "conflict" | "failed";
  readonly reportPath: string;
  readonly error?: string;
}

export async function runLegacyVisitBulk<T extends LegacyVisitBulkChart>(input: {
  readonly ledger: ImportLedger;
  readonly runId: string;
  readonly charts: readonly T[];
  readonly runChart: (
    chart: T,
    runId: string,
  ) => Promise<{ readonly conflicts?: number }>;
}): Promise<{
  readonly runId: string;
  readonly reportPath: string;
  readonly charts: readonly LegacyVisitBulkChartResult[];
}> {
  input.ledger.startRun(input.runId);
  const results: LegacyVisitBulkChartResult[] = [];

  for (const [index, chart] of input.charts.entries()) {
    const chartRunId = `${input.runId}-chart-${String(index + 1).padStart(2, "0")}`;
    input.ledger.startRun(chartRunId);
    try {
      const result = await input.runChart(chart, chartRunId);
      const status = (result.conflicts ?? 0) > 0 ? "conflict" : "completed";
      input.ledger.finishRun(chartRunId, status === "completed" ? "completed" : "failed");
      input.ledger.recordResourceAction({
        runId: input.runId,
        sourceKey: chart.chartKey,
        resourceType: "Patient",
        action: status === "completed" ? "skipped" : "conflict",
        reason: status === "completed"
          ? `bulk-chart-completed:${chartRunId}`
          : `bulk-chart-conflict:${chartRunId}`,
      });
      results.push({
        chartKey: chart.chartKey,
        runId: chartRunId,
        status,
        reportPath: input.ledger.writeReport(chartRunId),
      });
    } catch (error) {
      input.ledger.finishRun(chartRunId, "failed");
      input.ledger.recordResourceAction({
        runId: input.runId,
        sourceKey: chart.chartKey,
        resourceType: "Patient",
        action: "conflict",
        reason: `bulk-chart-failed:${chartRunId}`,
      });
      results.push({
        chartKey: chart.chartKey,
        runId: chartRunId,
        status: "failed",
        reportPath: input.ledger.writeReport(chartRunId),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  input.ledger.finishRun(
    input.runId,
    results.every((result) => result.status === "completed") ? "completed" : "failed",
  );
  return {
    runId: input.runId,
    charts: results,
    reportPath: input.ledger.writeReport(input.runId),
  };
}
