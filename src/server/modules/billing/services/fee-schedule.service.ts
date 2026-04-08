import type pg from 'pg';
import type {
  CreateFeeScheduleInput as ParsedCreateFeeScheduleInput,
  UpdateFeeScheduleInput,
  FeeScheduleItemInput,
  UpdateFeeScheduleItemInput,
} from '../schemas.js';

/**
 * Service-level input shape: defaults from Zod are optional at the call site
 * since the service is sometimes invoked directly (tests, scripts) without
 * going through the schema parser.
 */
type CreateFeeScheduleInput = Omit<ParsedCreateFeeScheduleInput, 'isDefault'> & {
  isDefault?: boolean;
};

export interface FeeScheduleRow {
  id: string;
  practice_id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  is_active: boolean;
  effective_date: string;
  end_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeeScheduleItemRow {
  id: string;
  fee_schedule_id: string;
  cpt_code: string;
  modifier: string | null;
  description: string | null;
  amount_cents: number;
  created_at: string;
  updated_at: string;
}

export class FeeScheduleService {
  constructor(private pool: pg.Pool) {}

  // --- FEE SCHEDULES ---

  async list(practiceId: string, includeInactive = false): Promise<FeeScheduleRow[]> {
    const where = includeInactive
      ? 'practice_id = $1'
      : 'practice_id = $1 AND is_active = true';
    const result = await this.pool.query(
      `SELECT * FROM fee_schedules WHERE ${where} ORDER BY is_default DESC, name`,
      [practiceId],
    );
    return result.rows;
  }

  async get(practiceId: string, scheduleId: string): Promise<FeeScheduleRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM fee_schedules WHERE id = $1 AND practice_id = $2',
      [scheduleId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  /** Get the practice's default fee schedule, or null if none set. */
  async getDefault(practiceId: string): Promise<FeeScheduleRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM fee_schedules
       WHERE practice_id = $1 AND is_default = true AND is_active = true
       LIMIT 1`,
      [practiceId],
    );
    return result.rows[0] ?? null;
  }

  async create(practiceId: string, input: CreateFeeScheduleInput): Promise<FeeScheduleRow> {
    const isDefault = input.isDefault ?? false;

    // If marking as default, unset any existing default
    if (isDefault) {
      await this.pool.query(
        `UPDATE fee_schedules SET is_default = false WHERE practice_id = $1 AND is_default = true`,
        [practiceId],
      );
    }

    const result = await this.pool.query(
      `INSERT INTO fee_schedules (
        practice_id, name, description, is_default, effective_date, end_date
      ) VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6)
      RETURNING *`,
      [
        practiceId,
        input.name,
        input.description ?? null,
        isDefault,
        input.effectiveDate ?? null,
        input.endDate ?? null,
      ],
    );
    return result.rows[0];
  }

  async update(
    practiceId: string,
    scheduleId: string,
    input: UpdateFeeScheduleInput,
  ): Promise<FeeScheduleRow> {
    // If marking as default, unset existing
    if (input.isDefault) {
      await this.pool.query(
        `UPDATE fee_schedules SET is_default = false
         WHERE practice_id = $1 AND is_default = true AND id != $2`,
        [practiceId, scheduleId],
      );
    }

    const fieldMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      isDefault: 'is_default',
      effectiveDate: 'effective_date',
      endDate: 'end_date',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 1) {
      const existing = await this.get(practiceId, scheduleId);
      if (!existing) throw new Error('Fee schedule not found');
      return existing;
    }

    values.push(scheduleId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE fee_schedules SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Fee schedule not found');
    return result.rows[0];
  }

  async deactivate(practiceId: string, scheduleId: string): Promise<FeeScheduleRow> {
    const result = await this.pool.query(
      `UPDATE fee_schedules SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND practice_id = $2 RETURNING *`,
      [scheduleId, practiceId],
    );
    if (result.rows.length === 0) throw new Error('Fee schedule not found');
    return result.rows[0];
  }

  // --- FEE SCHEDULE ITEMS ---

  async listItems(scheduleId: string): Promise<FeeScheduleItemRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM fee_schedule_items WHERE fee_schedule_id = $1
       ORDER BY cpt_code, modifier NULLS FIRST`,
      [scheduleId],
    );
    return result.rows;
  }

  async addItem(
    practiceId: string,
    scheduleId: string,
    input: FeeScheduleItemInput,
  ): Promise<FeeScheduleItemRow> {
    // Verify schedule belongs to practice
    const schedule = await this.get(practiceId, scheduleId);
    if (!schedule) throw new Error('Fee schedule not found');

    const result = await this.pool.query(
      `INSERT INTO fee_schedule_items (
        fee_schedule_id, cpt_code, modifier, description, amount_cents
      ) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [scheduleId, input.cptCode, input.modifier ?? null, input.description ?? null, input.amountCents],
    );
    return result.rows[0];
  }

  async updateItem(
    practiceId: string,
    scheduleId: string,
    itemId: string,
    input: UpdateFeeScheduleItemInput,
  ): Promise<FeeScheduleItemRow> {
    const schedule = await this.get(practiceId, scheduleId);
    if (!schedule) throw new Error('Fee schedule not found');

    const fieldMap: Record<string, string> = {
      modifier: 'modifier',
      description: 'description',
      amountCents: 'amount_cents',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 1) {
      const existing = await this.pool.query(
        'SELECT * FROM fee_schedule_items WHERE id = $1 AND fee_schedule_id = $2',
        [itemId, scheduleId],
      );
      if (existing.rows.length === 0) throw new Error('Fee schedule item not found');
      return existing.rows[0];
    }

    values.push(itemId);
    const idParam = idx++;
    values.push(scheduleId);
    const scheduleParam = idx++;

    const result = await this.pool.query(
      `UPDATE fee_schedule_items SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND fee_schedule_id = $${scheduleParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Fee schedule item not found');
    return result.rows[0];
  }

  async deleteItem(practiceId: string, scheduleId: string, itemId: string): Promise<void> {
    const schedule = await this.get(practiceId, scheduleId);
    if (!schedule) throw new Error('Fee schedule not found');

    const result = await this.pool.query(
      'DELETE FROM fee_schedule_items WHERE id = $1 AND fee_schedule_id = $2',
      [itemId, scheduleId],
    );
    if (result.rowCount === 0) throw new Error('Fee schedule item not found');
  }

  /** Look up a price for a CPT+modifier in a specific schedule. Returns null if not found. */
  async lookupPrice(
    scheduleId: string,
    cptCode: string,
    modifier?: string,
  ): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT amount_cents FROM fee_schedule_items
       WHERE fee_schedule_id = $1 AND cpt_code = $2
         AND ($3::text IS NULL AND modifier IS NULL OR modifier = $3)
       LIMIT 1`,
      [scheduleId, cptCode, modifier ?? null],
    );
    return result.rows[0]?.amount_cents ?? null;
  }
}
