import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_M2A_STATE_DIR =
  process.env.ODOS_M2A_STATE_DIR?.trim() || join(homedir(), ".odos", "legacy-import-m2a");

export type ImportAction = "created" | "updated" | "skipped" | "conflict";
export type ImportResourceType =
  | "Patient"
  | "AccessPolicy"
  | "ProjectMembership"
  | "Practitioner"
  | "Appointment"
  | "Encounter";
export type GrantAction = "added" | "skipped" | "conflict";
export type AdjudicationDecision = "keep" | "exclude" | "mark-as-test";

export interface CaptureAllocation {
  readonly visitDaySourceKey: string;
  readonly exSrNo: string;
  readonly appointmentSourceKey: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly note?: string;
}

export interface ImportAmbiguity {
  readonly sourceKind: string;
  readonly sourceKey: string;
  readonly ambiguityType: string;
  readonly state: "open" | "resolved";
  readonly details: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

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
    readonly resourceType: ImportResourceType;
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
        details_json = excluded.details_json,
        state = CASE
          WHEN ambiguity_queue.details_json <> excluded.details_json THEN 'open'
          ELSE ambiguity_queue.state
        END,
        resolved_at = CASE
          WHEN ambiguity_queue.details_json <> excluded.details_json THEN NULL
          ELSE ambiguity_queue.resolved_at
        END
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
    readonly decision: AdjudicationDecision;
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
    decision: AdjudicationDecision;
    decidedBy: string;
    decidedAt: string;
    note?: string;
  } | undefined {
    const row = this.database.prepare(`
      SELECT decision, decided_by, decided_at, note
      FROM adjudications
      WHERE source_kind = ? AND source_key = ?
    `).get(sourceKind, sourceKey) as {
      decision: AdjudicationDecision;
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

  recordCaptureAllocation(input: {
    readonly visitDaySourceKey: string;
    readonly exSrNo: string;
    readonly appointmentSourceKey: string;
    readonly decidedBy: string;
    readonly note?: string;
  }): void {
    this.database.prepare(`
      INSERT INTO capture_allocations (
        visit_day_source_key, ex_sr_no, appointment_source_key, decided_by, decided_at, note
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (visit_day_source_key, ex_sr_no) DO UPDATE SET
        appointment_source_key = excluded.appointment_source_key,
        decided_by = excluded.decided_by,
        decided_at = excluded.decided_at,
        note = excluded.note
    `).run(
      input.visitDaySourceKey,
      input.exSrNo,
      input.appointmentSourceKey,
      input.decidedBy,
      this.now(),
      input.note ?? null,
    );
  }

  readCaptureAllocation(
    visitDaySourceKey: string,
    exSrNo: string,
  ): CaptureAllocation | undefined {
    const row = this.database.prepare(`
      SELECT
        visit_day_source_key,
        ex_sr_no,
        appointment_source_key,
        decided_by,
        decided_at,
        note
      FROM capture_allocations
      WHERE visit_day_source_key = ? AND ex_sr_no = ?
    `).get(visitDaySourceKey, exSrNo) as {
      visit_day_source_key: string;
      ex_sr_no: string;
      appointment_source_key: string;
      decided_by: string;
      decided_at: string;
      note: string | null;
    } | undefined;
    return row ? captureAllocation(row) : undefined;
  }

  listCaptureAllocations(visitDaySourceKey: string): CaptureAllocation[] {
    const rows = this.database.prepare(`
      SELECT
        visit_day_source_key,
        ex_sr_no,
        appointment_source_key,
        decided_by,
        decided_at,
        note
      FROM capture_allocations
      WHERE visit_day_source_key = ?
      ORDER BY ex_sr_no
    `).all(visitDaySourceKey) as Array<{
      visit_day_source_key: string;
      ex_sr_no: string;
      appointment_source_key: string;
      decided_by: string;
      decided_at: string;
      note: string | null;
    }>;
    return rows.map(captureAllocation);
  }

  listAmbiguities(input: {
    readonly sourceKind?: string;
    readonly sourceKey?: string;
    readonly state?: "open" | "resolved";
  } = {}): ImportAmbiguity[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.sourceKind) {
      clauses.push("source_kind = ?");
      values.push(input.sourceKind);
    }
    if (input.sourceKey) {
      clauses.push("source_key = ?");
      values.push(input.sourceKey);
    }
    if (input.state) {
      clauses.push("state = ?");
      values.push(input.state);
    }
    const rows = this.database.prepare(`
      SELECT
        source_kind,
        source_key,
        ambiguity_type,
        state,
        details_json,
        created_at,
        resolved_at
      FROM ambiguity_queue
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY ambiguity_id
    `).all(...values) as Array<{
      source_kind: string;
      source_key: string;
      ambiguity_type: string;
      state: "open" | "resolved";
      details_json: string;
      created_at: string;
      resolved_at: string | null;
    }>;
    return rows.map((row) => ({
      sourceKind: row.source_kind,
      sourceKey: row.source_key,
      ambiguityType: row.ambiguity_type,
      state: row.state,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      createdAt: row.created_at,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    }));
  }

  resolveAmbiguity(
    sourceKind: string,
    sourceKey: string,
    ambiguityType: string,
  ): void {
    this.database.prepare(`
      UPDATE ambiguity_queue
      SET state = 'resolved', resolved_at = ?
      WHERE source_kind = ? AND source_key = ? AND ambiguity_type = ?
    `).run(this.now(), sourceKind, sourceKey, ambiguityType);
  }

  listRunSourceKeys(runId: string): string[] {
    const rows = this.database.prepare(`
      SELECT source_key
      FROM resource_actions
      WHERE run_id = ?
      UNION
      SELECT source_key
      FROM junk_rejections
      WHERE run_id = ?
      ORDER BY source_key
    `).all(runId, runId) as Array<{ source_key: string }>;
    return rows.map((row) => row.source_key);
  }

  listPatientRunIds(patientSourceKey: string): string[] {
    const rows = this.database.prepare(`
      SELECT run_id, MAX(action_id) AS latest_action_id
      FROM resource_actions
      WHERE resource_type = 'Patient' AND source_key = ?
      GROUP BY run_id
      ORDER BY latest_action_id DESC
    `).all(patientSourceKey) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
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
      SELECT source_key, resource_type, resource_reference, action, reason, recorded_at
      FROM resource_actions
      WHERE run_id = ?
      ORDER BY action_id
    `).all(runId) as Array<{
      source_key: string;
      resource_type: string;
      resource_reference: string | null;
      action: string;
      reason: string;
      recorded_at: string;
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
    const sourceKeys = new Set([
      ...resourceActions.map((row) => row.source_key),
      ...rejections.map((row) => row.source_key),
    ]);
    const ambiguities = this.listAmbiguities().filter((row) =>
      sourceKeys.has(row.sourceKey)
      || (
        Array.isArray(row.details.appointmentSourceKeys)
        && row.details.appointmentSourceKeys.some(
          (sourceKey) => typeof sourceKey === "string" && sourceKeys.has(sourceKey),
        )
      )
    );
    for (const ambiguity of ambiguities) sourceKeys.add(ambiguity.sourceKey);
    const adjudications = sourceKeys.size === 0
      ? []
      : this.database.prepare(`
          SELECT source_kind, source_key, decision, decided_by, decided_at, note
          FROM adjudications
          ORDER BY decided_at, source_kind, source_key
        `).all().filter((value) =>
          sourceKeys.has((value as { source_key: string }).source_key)
        ) as Array<{
          source_kind: string;
          source_key: string;
          decision: AdjudicationDecision;
          decided_by: string;
          decided_at: string;
          note: string | null;
        }>;
    const allocations = [...sourceKeys].flatMap((sourceKey) =>
      this.listCaptureAllocations(sourceKey)
    );
    const patientActions = resourceActions.filter((row) => row.resource_type === "Patient");
    const visitActions = resourceActions.filter((row) =>
      row.resource_type === "Appointment" || row.resource_type === "Encounter"
    );
    const otherActions = resourceActions.filter((row) =>
      row.resource_type !== "Patient"
      && row.resource_type !== "Appointment"
      && row.resource_type !== "Encounter"
    );

    return [
      `# Legacy import run ${run.run_id}`,
      "",
      `- Status: ${run.status}`,
      `- Started: ${run.started_at}`,
      `- Completed: ${run.completed_at ?? "pending"}`,
      `- Resource actions: ${resourceActions.length}`,
      `- Junk rejections: ${rejections.length}`,
      `- Access grants: ${grants.length}`,
      `- Open decisions: ${ambiguities.filter((row) => row.state === "open").length}`,
      "",
      "## Patient roll-up",
      "",
      "| Patient source key | Reference | Status | Detail |",
      "|---|---|---|---|",
      ...patientActions.map((row) =>
        `| ${cell(row.source_key)} | ${cell(row.resource_reference ?? "")} | ${cell(reportAction(row))} | ${cell(row.reason)} |`
      ),
      "",
      "## Appointments and Encounters",
      "",
      "| Source key | Resource | Reference | Outcome | Reason | Recorded |",
      "|---|---|---|---|---|---|",
      ...visitActions.map((row) =>
        `| ${cell(row.source_key)} | ${cell(row.resource_type)} | ${cell(row.resource_reference ?? "")} | ${cell(reportAction(row))} | ${cell(row.reason)} | ${cell(row.recorded_at)} |`
      ),
      "",
      "## Other resource actions",
      "",
      "| Source key | Resource | Reference | Outcome | Reason |",
      "|---|---|---|---|---|",
      ...otherActions.map((row) =>
        `| ${cell(row.source_key)} | ${cell(row.resource_type)} | ${cell(row.resource_reference ?? "")} | ${cell(reportAction(row))} | ${cell(row.reason)} |`
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
      "## Ambiguity queue",
      "",
      "| Source kind | Source key | Ambiguity | State | Details |",
      "|---|---|---|---|---|",
      ...ambiguities.map((row) =>
        `| ${cell(row.sourceKind)} | ${cell(row.sourceKey)} | ${cell(row.ambiguityType)} | ${cell(row.state.toUpperCase())} | ${cell(JSON.stringify(row.details))} |`
      ),
      "",
      "## Capture allocations",
      "",
      "| Visit day | Capture | Appointment source key | Decided by | Decided at | Note |",
      "|---|---|---|---|---|---|",
      ...allocations.map((row) =>
        `| ${cell(row.visitDaySourceKey)} | ${cell(row.exSrNo)} | ${cell(row.appointmentSourceKey)} | ${cell(row.decidedBy)} | ${cell(row.decidedAt)} | ${cell(row.note ?? "")} |`
      ),
      "",
      "## Adjudications",
      "",
      "| Source kind | Source key | Decision | Decided by | Decided at | Note |",
      "|---|---|---|---|---|---|",
      ...adjudications.map((row) =>
        `| ${cell(row.source_kind)} | ${cell(row.source_key)} | ${cell(row.decision.toUpperCase())} | ${cell(row.decided_by)} | ${cell(row.decided_at)} | ${cell(row.note ?? "")} |`
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

      CREATE TABLE IF NOT EXISTS capture_allocations (
        visit_day_source_key TEXT NOT NULL,
        ex_sr_no TEXT NOT NULL,
        appointment_source_key TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        note TEXT,
        PRIMARY KEY (visit_day_source_key, ex_sr_no)
      );
    `);
  }
}

function captureAllocation(row: {
  visit_day_source_key: string;
  ex_sr_no: string;
  appointment_source_key: string;
  decided_by: string;
  decided_at: string;
  note: string | null;
}): CaptureAllocation {
  return {
    visitDaySourceKey: row.visit_day_source_key,
    exSrNo: row.ex_sr_no,
    appointmentSourceKey: row.appointment_source_key,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    ...(row.note ? { note: row.note } : {}),
  };
}

function reportAction(row: {
  resource_type: string;
  action: string;
  reason: string;
}): string {
  return row.resource_type === "Encounter" && row.reason === "excluded-by-adjudication"
    ? "EXCLUDED"
    : row.action;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
