import type pg from 'pg';
import type {
  CreateEquipmentInput,
  UpdateEquipmentInput,
  ListEquipmentInput,
  CreateReadingInput,
  ListReadingsInput,
  ReviewReadingInput,
} from './schemas.js';
import type { DomainEventBus } from '../../events/bus.js';
import { buildEvent, type ActorContext } from '../../events/builder.js';

export interface EquipmentRow {
  id: string;
  practice_id: string;
  name: string;
  manufacturer: string;
  model: string;
  device_category: string;
  integration_type: string;
  connection_config: Record<string, unknown>;
  location: string | null;
  data_types: string[];
  parser_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeviceReadingRow {
  id: string;
  practice_id: string;
  equipment_id: string;
  patient_id: string | null;
  matched_by: string | null;
  reading_type: string;
  structured_data: Record<string, unknown>;
  raw_data_ref: string | null;
  source_type: string;
  confidence: number | null;
  needs_review: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  captured_at: string;
  created_at: string;
}

export class EquipmentService {
  constructor(
    private pool: pg.Pool,
    private eventBus: DomainEventBus,
  ) {}

  // --- EQUIPMENT CRUD ---

  async list(practiceId: string, input: ListEquipmentInput): Promise<EquipmentRow[]> {
    const conditions: string[] = ['practice_id = $1'];
    const values: unknown[] = [practiceId];
    let idx = 2;

    if (!input.includeInactive) {
      conditions.push('is_active = true');
    }
    if (input.deviceCategory) {
      conditions.push(`device_category = $${idx++}`);
      values.push(input.deviceCategory);
    }
    if (input.integrationType) {
      conditions.push(`integration_type = $${idx++}`);
      values.push(input.integrationType);
    }

    const result = await this.pool.query(
      `SELECT * FROM equipment_registry
       WHERE ${conditions.join(' AND ')}
       ORDER BY device_category, name`,
      values,
    );
    return result.rows;
  }

  async get(practiceId: string, equipmentId: string): Promise<EquipmentRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM equipment_registry WHERE id = $1 AND practice_id = $2',
      [equipmentId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async create(
    practiceId: string,
    input: CreateEquipmentInput,
    actor: ActorContext,
  ): Promise<EquipmentRow> {
    const result = await this.pool.query(
      `INSERT INTO equipment_registry (
        practice_id, name, manufacturer, model,
        device_category, integration_type, connection_config,
        location, data_types, parser_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        practiceId,
        input.name,
        input.manufacturer,
        input.model,
        input.deviceCategory,
        input.integrationType,
        JSON.stringify(input.connectionConfig),
        input.location ?? null,
        input.dataTypes,
        input.parserId ?? null,
      ],
    );
    const row = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'equipment.registered',
        entityType: 'equipment',
        entityId: row.id,
        payload: {
          name: row.name,
          deviceCategory: row.device_category,
          integrationType: row.integration_type,
        },
        newState: row,
      }),
    );

    return row;
  }

  async update(
    practiceId: string,
    equipmentId: string,
    input: UpdateEquipmentInput,
    actor: ActorContext,
  ): Promise<EquipmentRow> {
    const before = await this.get(practiceId, equipmentId);
    if (!before) throw new Error('Equipment not found');

    const fieldMap: Record<string, string> = {
      name: 'name',
      manufacturer: 'manufacturer',
      model: 'model',
      deviceCategory: 'device_category',
      integrationType: 'integration_type',
      connectionConfig: 'connection_config',
      location: 'location',
      dataTypes: 'data_types',
      parserId: 'parser_id',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(key === 'connectionConfig' ? JSON.stringify(value) : value);
    }

    if (setClauses.length === 1) {
      // Nothing to update — return the snapshot; skip emitting
      return before;
    }

    values.push(equipmentId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE equipment_registry SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Equipment not found');
    const after = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'equipment.updated',
        entityType: 'equipment',
        entityId: equipmentId,
        payload: { changes: input },
        previousState: before,
        newState: after,
      }),
    );

    return after;
  }

  async deactivate(
    practiceId: string,
    equipmentId: string,
    actor: ActorContext,
  ): Promise<EquipmentRow> {
    const before = await this.get(practiceId, equipmentId);
    if (!before) throw new Error('Equipment not found');

    const result = await this.pool.query(
      `UPDATE equipment_registry SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND practice_id = $2
       RETURNING *`,
      [equipmentId, practiceId],
    );
    if (result.rows.length === 0) throw new Error('Equipment not found');
    const after = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'equipment.deactivated',
        entityType: 'equipment',
        entityId: equipmentId,
        payload: {},
        previousState: before,
        newState: after,
      }),
    );

    return after;
  }

  // --- DEVICE READINGS ---

  async listReadings(
    practiceId: string,
    input: ListReadingsInput,
  ): Promise<{ readings: DeviceReadingRow[]; total: number }> {
    const conditions: string[] = ['practice_id = $1'];
    const values: unknown[] = [practiceId];
    let idx = 2;

    if (input.patientId) {
      conditions.push(`patient_id = $${idx++}`);
      values.push(input.patientId);
    }
    if (input.equipmentId) {
      conditions.push(`equipment_id = $${idx++}`);
      values.push(input.equipmentId);
    }
    if (input.readingType) {
      conditions.push(`reading_type = $${idx++}`);
      values.push(input.readingType);
    }
    if (input.needsReview !== undefined) {
      conditions.push(`needs_review = $${idx++}`);
      values.push(input.needsReview);
    }
    if (input.startDate) {
      conditions.push(`captured_at >= $${idx++}`);
      values.push(input.startDate);
    }
    if (input.endDate) {
      conditions.push(`captured_at <= $${idx++}`);
      values.push(input.endDate);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int as total FROM device_readings WHERE ${where}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(input.limit);
    const limitParam = idx++;
    values.push(input.offset);
    const offsetParam = idx++;

    const result = await this.pool.query(
      `SELECT * FROM device_readings WHERE ${where}
       ORDER BY captured_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    return { readings: result.rows, total };
  }

  async getReading(practiceId: string, readingId: string): Promise<DeviceReadingRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM device_readings WHERE id = $1 AND practice_id = $2',
      [readingId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Create a device reading manually. Used for:
   * - Testing/seed data
   * - Manual entry when a device has no automated integration
   * - AI extraction from raw data
   *
   * Parser-driven writes (DICOM/folder watch/serial) will also call this path.
   */
  async createReading(
    practiceId: string,
    input: CreateReadingInput,
    actor: ActorContext,
  ): Promise<DeviceReadingRow> {
    // Verify equipment belongs to this practice
    const equipment = await this.get(practiceId, input.equipmentId);
    if (!equipment) throw new Error('Equipment not found');

    const result = await this.pool.query(
      `INSERT INTO device_readings (
        practice_id, equipment_id, patient_id, matched_by, reading_type,
        structured_data, raw_data_ref, source_type, confidence, needs_review,
        captured_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        practiceId,
        input.equipmentId,
        input.patientId ?? null,
        input.matchedBy ?? null,
        input.readingType,
        JSON.stringify(input.structuredData),
        input.rawDataRef ?? null,
        input.sourceType,
        input.confidence ?? null,
        input.needsReview,
        input.capturedAt,
      ],
    );
    const row = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'device.reading_received',
        entityType: 'device_reading',
        entityId: row.id,
        payload: {
          equipmentId: row.equipment_id,
          readingType: row.reading_type,
        },
        newState: row,
      }),
    );

    // If the reading came in already matched to a patient, also emit the match event.
    // This gives the audit trail a clean "received → matched" pair for parser-driven
    // writes that already knew the patient (e.g., via DICOM MWL).
    if (row.patient_id && row.matched_by) {
      await this.eventBus.emit(
        buildEvent(actor, {
          type: 'device.reading_matched',
          entityType: 'device_reading',
          entityId: row.id,
          payload: { patientId: row.patient_id, matchedBy: row.matched_by },
          newState: row,
        }),
      );
    }

    return row;
  }

  /**
   * Mark a reading as reviewed. Optionally update patient assignment or
   * structured data (for corrections during review).
   */
  async reviewReading(
    practiceId: string,
    readingId: string,
    input: ReviewReadingInput,
    actor: ActorContext,
  ): Promise<DeviceReadingRow> {
    const before = await this.getReading(practiceId, readingId);
    if (!before) throw new Error('Reading not found');

    const setClauses: string[] = [
      'needs_review = false',
      'reviewed_by = $1',
      'reviewed_at = NOW()',
    ];
    const values: unknown[] = [actor.userId];
    let idx = 2;

    if (input.patientId !== undefined) {
      setClauses.push(`patient_id = $${idx++}`);
      values.push(input.patientId);
      setClauses.push(`matched_by = 'manual'`);
    }
    if (input.structuredData !== undefined) {
      setClauses.push(`structured_data = $${idx++}`);
      values.push(JSON.stringify(input.structuredData));
    }

    values.push(readingId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE device_readings SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Reading not found');
    const after = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'device.reading_reviewed',
        entityType: 'device_reading',
        entityId: readingId,
        payload: { reviewedBy: actor.userId },
        previousState: before,
        newState: after,
      }),
    );

    // If the review also assigned/changed the patient, emit a match event too.
    if (input.patientId !== undefined && input.patientId !== before.patient_id) {
      await this.eventBus.emit(
        buildEvent(actor, {
          type: 'device.reading_matched',
          entityType: 'device_reading',
          entityId: readingId,
          payload: { patientId: input.patientId, matchedBy: 'manual' },
          previousState: before,
          newState: after,
        }),
      );
    }

    return after;
  }
}
