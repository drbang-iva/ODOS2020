import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_M2A_STATE_DIR =
  process.env.ODOS_M2A_STATE_DIR?.trim() || join(homedir(), ".odos", "legacy-import-m2a");

export type ImportAction = "created" | "updated" | "skipped" | "conflict";
export type GrantAction = "added" | "skipped" | "conflict";

export interface ImportLedgerOptions {
  readonly databasePath?: string;
  readonly stateDirectory?: string;
  readonly now?: () => string;
}

export class ImportLedger {
  readonly databasePath: string;
  readonly stateDirectory: string;
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(options: ImportLedgerOptions = {}) {
    this.stateDirectory = options.stateDirectory ?? DEFAULT_M2A_STATE_DIR;
    this.databasePath = options.databasePath ?? join(this.stateDirectory, "legacy-import.sqlite");
    this.now = options.now ?? (() => new Date().toISOString());
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.stateDirectory, 0o700);
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.installSchema();
  }

  startRun(runId = `m2a-${randomUUID()}`): string {
    const result = this.database.prepare(`
      INSERT INTO runs (run_id, started_at, status)
      VALUES (?, ?, 'running')
      ON CONFLICT (run_id) DO NOTHING
    `).run(runId, this.now());
    if (result.changes !== 1) {
      throw new Error(`Import run ${runId} already exists; use a new run id.`);
    }
    return runId;
  }

  resumePatientImportedRun(runId: string): void {
    const row = this.database.prepare(`
      SELECT status
      FROM runs
      WHERE run_id = ?
    `).get(runId) as { status: string } | undefined;
    if (!row) throw new Error(`Import run ${runId} is not present in the ledger.`);
    if (row.status !== "patient-imported") {
      throw new Error(
        `Import run ${runId} has status ${row.status}; expected patient-imported.`,
      );
    }
  }

  finishRun(runId: string, status: "patient-imported" | "completed" | "failed"): void {
    const result = this.database.prepare(`
      UPDATE runs
      SET completed_at = ?, status = ?
      WHERE run_id = ?
    `).run(this.now(), status, runId);
    if (result.changes !== 1) {
      throw new Error(`Import run ${runId} is not present in the ledger.`);
    }
  }

  recordResourceAction(input: {
    readonly runId: string;
    readonly sourceKey: string;
    readonly resourceType: string;
    readonly resourceReference?: string;
    readonly action: ImportAction;
    readonly reason: string;
  }): void {
    this.database.prepare(`
      INSERT INTO resource_actions (
        run_id, source_key, resource_type, resource_reference, action, reason, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.sourceKey,
      input.resourceType,
      input.resourceReference ?? null,
      input.action,
      input.reason,
      this.now(),
    );
  }

  recordJunkRejection(input: {
    readonly runId: string;
    readonly sourceSystem: string;
    readonly sourceKey: string;
    readonly reason: string;
  }): void {
    this.database.prepare(`
      INSERT INTO junk_rejections (
        run_id, source_system, source_key, reason, rejected_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.sourceSystem,
      input.sourceKey,
      input.reason,
      this.now(),
    );
  }

  recordAccessGrant(input: {
    readonly runId: string;
    readonly subjectReference: string;
    readonly membershipReference: string;
    readonly parameters: readonly {
      readonly name: string;
      readonly value: string;
    }[];
    readonly action: GrantAction;
  }): void {
    this.database.prepare(`
      INSERT INTO access_grants (
        run_id, subject_reference, membership_reference, parameters_json, action, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.subjectReference,
      input.membershipReference,
      JSON.stringify(input.parameters),
      input.action,
      this.now(),
    );
  }

  recordAmbiguity(input: {
    readonly sourceKind: string;
    readonly sourceKey: string;
    readonly ambiguityType: string;
    readonly details: Readonly<Record<string, unknown>>;
  }): void {
    this.database.prepare(`
      INSERT INTO ambiguity_queue (
        source_kind, source_key, ambiguity_type, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_kind, source_key, ambiguity_type) DO UPDATE SET
        details_json = excluded.details_json
    `).run(
      input.sourceKind,
      input.sourceKey,
      input.ambiguityType,
      JSON.stringify(input.details),
      this.now(),
    );
  }

  recordAdjudication(input: {
    readonly sourceKind: string;
    readonly sourceKey: string;
    readonly decision: "keep" | "exclude" | "mark-as-test";
    readonly decidedBy: string;
    readonly note?: string;
  }): void {
    this.database.prepare(`
      INSERT INTO adjudications (
        source_kind, source_key, decision, decided_by, decided_at, note
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_kind, source_key) DO UPDATE SET
        decision = excluded.decision,
        decided_by = excluded.decided_by,
        decided_at = excluded.decided_at,
        note = excluded.note
    `).run(
      input.sourceKind,
      input.sourceKey,
      input.decision,
      input.decidedBy,
      this.now(),
      input.note ?? null,
    );
  }

  readAdjudication(
    sourceKind: string,
    sourceKey: string,
  ): {
    decision: "keep" | "exclude" | "mark-as-test";
    decidedBy: string;
    decidedAt: string;
    note?: string;
  } | undefined {
    const row = this.database.prepare(`
      SELECT decision, decided_by, decided_at, note
      FROM adjudications
      WHERE source_kind = ? AND source_key = ?
    `).get(sourceKind, sourceKey) as {
      decision: "keep" | "exclude" | "mark-as-test";
      decided_by: string;
      decided_at: string;
      note: string | null;
    } | undefined;
    return row
      ? {
          decision: row.decision,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at,
          ...(row.note ? { note: row.note } : {}),
        }
      : undefined;
  }

  renderReport(runId: string): string {
    const run = this.database.prepare(`
      SELECT run_id, started_at, completed_at, status
      FROM runs
      WHERE run_id = ?
    `).get(runId) as {
      run_id: string;
      started_at: string;
      completed_at: string | null;
      status: string;
    } | undefined;
    if (!run) throw new Error(`Import run ${runId} is not present in the ledger.`);

    const resourceActions = this.database.prepare(`
      SELECT source_key, resource_type, resource_reference, action, reason
      FROM resource_actions
      WHERE run_id = ?
      ORDER BY action_id
    `).all(runId) as Array<{
      source_key: string;
      resource_type: string;
      resource_reference: string | null;
      action: string;
      reason: string;
    }>;
    const rejections = this.database.prepare(`
      SELECT source_system, source_key, reason
      FROM junk_rejections
      WHERE run_id = ?
      ORDER BY rejection_id
    `).all(runId) as Array<{
      source_system: string;
      source_key: string;
      reason: string;
    }>;
    const grants = this.database.prepare(`
      SELECT subject_reference, membership_reference, parameters_json, action
      FROM access_grants
      WHERE run_id = ?
      ORDER BY grant_id
    `).all(runId) as Array<{
      subject_reference: string;
      membership_reference: string;
      parameters_json: string;
      action: string;
    }>;

    return [
      `# Legacy import M2a run ${run.run_id}`,
      "",
      `- Status: ${run.status}`,
      `- Started: ${run.started_at}`,
      `- Completed: ${run.completed_at ?? "pending"}`,
      `- Resource actions: ${resourceActions.length}`,
      `- Junk rejections: ${rejections.length}`,
      `- Access grants: ${grants.length}`,
      "",
      "## Resource actions",
      "",
      "| Source key | Resource | Reference | Action | Reason |",
      "|---|---|---|---|---|",
      ...resourceActions.map((row) =>
        `| ${cell(row.source_key)} | ${cell(row.resource_type)} | ${cell(row.resource_reference ?? "")} | ${cell(row.action)} | ${cell(row.reason)} |`
      ),
      "",
      "## Junk-row rejections",
      "",
      "| Source | Source key | Reason |",
      "|---|---|---|",
      ...rejections.map((row) =>
        `| ${cell(row.source_system)} | ${cell(row.source_key)} | ${cell(row.reason)} |`
      ),
      "",
      "## Access grants",
      "",
      "| Subject | Membership | Parameters | Action |",
      "|---|---|---|---|",
      ...grants.map((row) =>
        `| ${cell(row.subject_reference)} | ${cell(row.membership_reference)} | ${cell(row.parameters_json)} | ${cell(row.action)} |`
      ),
      "",
    ].join("\n");
  }

  writeReport(runId: string): string {
    const reportDirectory = join(this.stateDirectory, "reports");
    mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
    const reportPath = join(reportDirectory, `${runId}.md`);
    writeFileSync(reportPath, this.renderReport(runId), { mode: 0o600 });
    return reportPath;
  }

  close(): void {
    this.database.close();
  }

  private installSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('running', 'patient-imported', 'completed', 'failed'))
      );

      CREATE TABLE IF NOT EXISTS resource_actions (
        action_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        source_key TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_reference TEXT,
        action TEXT NOT NULL
          CHECK (action IN ('created', 'updated', 'skipped', 'conflict')),
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS junk_rejections (
        rejection_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        source_system TEXT NOT NULL,
        source_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        rejected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS access_grants (
        grant_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        subject_reference TEXT NOT NULL,
        membership_reference TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        action TEXT NOT NULL
          CHECK (action IN ('added', 'skipped', 'conflict')),
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ambiguity_queue (
        ambiguity_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_kind TEXT NOT NULL,
        source_key TEXT NOT NULL,
        ambiguity_type TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open'
          CHECK (state IN ('open', 'resolved')),
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (source_kind, source_key, ambiguity_type)
      );

      CREATE TABLE IF NOT EXISTS adjudications (
        source_kind TEXT NOT NULL,
        source_key TEXT NOT NULL,
        decision TEXT NOT NULL
          CHECK (decision IN ('keep', 'exclude', 'mark-as-test')),
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        note TEXT,
        PRIMARY KEY (source_kind, source_key)
      );
    `);
  }
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
