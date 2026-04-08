import type pg from 'pg';
import type { SearchAuditInput } from './schemas.js';

export interface AuditEventRow {
  id: string;
  practice_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_type: string;
  model_name: string | null;
  confidence: number | null;
  ip_address: string | null;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class AuditService {
  constructor(private pool: pg.Pool) {}

  /** Search audit events scoped to a practice. Supports filtering + pagination. */
  async search(
    practiceId: string,
    input: SearchAuditInput,
  ): Promise<{ events: AuditEventRow[]; total: number }> {
    const conditions: string[] = ['practice_id = $1'];
    const values: unknown[] = [practiceId];
    let idx = 2;

    if (input.entityType) {
      conditions.push(`entity_type = $${idx++}`);
      values.push(input.entityType);
    }
    if (input.entityId) {
      conditions.push(`entity_id = $${idx++}`);
      values.push(input.entityId);
    }
    if (input.actorId) {
      conditions.push(`actor_id = $${idx++}`);
      values.push(input.actorId);
    }
    if (input.actorType) {
      conditions.push(`actor_type = $${idx++}`);
      values.push(input.actorType);
    }
    if (input.action) {
      conditions.push(`action = $${idx++}`);
      values.push(input.action);
    }
    if (input.startDate) {
      conditions.push(`created_at >= $${idx++}`);
      values.push(input.startDate);
    }
    if (input.endDate) {
      conditions.push(`created_at <= $${idx++}`);
      values.push(input.endDate);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int as total FROM audit_events WHERE ${where}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(input.limit);
    const limitParam = idx++;
    values.push(input.offset);
    const offsetParam = idx++;

    const result = await this.pool.query(
      `SELECT * FROM audit_events WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    return { events: result.rows, total };
  }

  /** Get all events for a specific entity (e.g., a patient's full history). */
  async getEntityHistory(
    practiceId: string,
    entityType: string,
    entityId: string,
  ): Promise<AuditEventRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM audit_events
       WHERE practice_id = $1 AND entity_type = $2 AND entity_id = $3
       ORDER BY created_at DESC`,
      [practiceId, entityType, entityId],
    );
    return result.rows;
  }
}
