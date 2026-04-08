import type pg from 'pg';
import type {
  CreateLibraryItemInput,
  UpdateLibraryItemInput,
  CreateBodyAreaInput,
  UpdateBodyAreaInput,
  CreateAppointmentTypeInput,
  UpdateAppointmentTypeInput,
  CloneFromLibraryInput,
} from './schemas.js';

export interface LibraryItemRow {
  id: string;
  standard_name: string;
  category: string;
  subcategory: string | null;
  typical_duration_minutes: number;
  cpt_codes: string[];
  equipment_tags: string[];
  provider_scope: string[];
  service_lines: string[];
  body_area_modifiers_available: boolean;
  consent_required: boolean;
  is_billable: boolean;
  default_color: string;
  created_at: string;
}

export interface BodyAreaRow {
  id: string;
  practice_id: string | null;
  name: string;
  short_code: string;
  duration_adjustment_minutes: number;
  additional_equipment_tags: string[];
  additional_consent: boolean;
  is_system: boolean;
  created_at: string;
}

export interface AppointmentTypeRow {
  id: string;
  practice_id: string;
  service_line_id: string;
  name: string;
  short_name: string;
  display_name: string | null;
  color: string;
  duration_blocks: number;
  default_reason: string | null;
  is_active: boolean;
  sort_order: number;
  library_id: string | null;
  service_line_ids: string[];
  body_area_modifier_ids: string[];
  equipment_tags: string[];
  provider_scope: string[];
  is_custom: boolean;
  price_cents: number | null;
  cpt_codes: string[];
  requires_consultation: boolean;
  series_enabled: boolean;
  series_count: number | null;
  online_bookable: boolean;
  photo_required: boolean;
  created_at: string;
}

export class CatalogService {
  constructor(private pool: pg.Pool) {}

  // --- TREATMENT LIBRARY ---

  async listLibrary(filters?: { category?: string; serviceLine?: string }): Promise<LibraryItemRow[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filters?.category) {
      conditions.push(`category = $${idx++}`);
      values.push(filters.category);
    }
    if (filters?.serviceLine) {
      conditions.push(`$${idx++} = ANY(service_lines)`);
      values.push(filters.serviceLine);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM treatment_library ${where} ORDER BY category, standard_name`,
      values,
    );
    return result.rows;
  }

  async getLibraryItem(id: string): Promise<LibraryItemRow | null> {
    const result = await this.pool.query('SELECT * FROM treatment_library WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async createLibraryItem(input: CreateLibraryItemInput): Promise<LibraryItemRow> {
    const result = await this.pool.query(
      `INSERT INTO treatment_library (
        standard_name, category, subcategory, typical_duration_minutes,
        cpt_codes, equipment_tags, provider_scope, service_lines,
        body_area_modifiers_available, consent_required, is_billable, default_color
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        input.standardName, input.category, input.subcategory ?? null, input.typicalDurationMinutes,
        input.cptCodes, input.equipmentTags, input.providerScope, input.serviceLines,
        input.bodyAreaModifiersAvailable, input.consentRequired, input.isBillable, input.defaultColor,
      ],
    );
    return result.rows[0];
  }

  async updateLibraryItem(id: string, input: UpdateLibraryItemInput): Promise<LibraryItemRow> {
    const fieldMap: Record<string, string> = {
      standardName: 'standard_name',
      category: 'category',
      subcategory: 'subcategory',
      typicalDurationMinutes: 'typical_duration_minutes',
      cptCodes: 'cpt_codes',
      equipmentTags: 'equipment_tags',
      providerScope: 'provider_scope',
      serviceLines: 'service_lines',
      bodyAreaModifiersAvailable: 'body_area_modifiers_available',
      consentRequired: 'consent_required',
      isBillable: 'is_billable',
      defaultColor: 'default_color',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 0) {
      const existing = await this.getLibraryItem(id);
      if (!existing) throw new Error('Library item not found');
      return existing;
    }

    values.push(id);

    const result = await this.pool.query(
      `UPDATE treatment_library SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Library item not found');
    return result.rows[0];
  }

  async deleteLibraryItem(id: string): Promise<void> {
    const result = await this.pool.query('DELETE FROM treatment_library WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new Error('Library item not found');
  }

  // --- BODY AREA MODIFIERS ---

  async listBodyAreas(practiceId: string | null): Promise<BodyAreaRow[]> {
    // Returns system modifiers (practice_id IS NULL) plus practice-specific
    const result = await this.pool.query(
      `SELECT * FROM body_area_modifiers
       WHERE practice_id IS NULL OR practice_id = $1
       ORDER BY name`,
      [practiceId],
    );
    return result.rows;
  }

  async getBodyArea(id: string): Promise<BodyAreaRow | null> {
    const result = await this.pool.query('SELECT * FROM body_area_modifiers WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async createBodyArea(practiceId: string, input: CreateBodyAreaInput): Promise<BodyAreaRow> {
    const result = await this.pool.query(
      `INSERT INTO body_area_modifiers (
        practice_id, name, short_code, duration_adjustment_minutes,
        additional_equipment_tags, additional_consent, is_system
      ) VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *`,
      [
        practiceId, input.name, input.shortCode, input.durationAdjustmentMinutes,
        input.additionalEquipmentTags, input.additionalConsent,
      ],
    );
    return result.rows[0];
  }

  async updateBodyArea(
    practiceId: string,
    id: string,
    input: UpdateBodyAreaInput,
  ): Promise<BodyAreaRow> {
    const existing = await this.getBodyArea(id);
    if (!existing) throw new Error('Body area not found');
    if (existing.is_system) throw new Error('Cannot modify system body area');
    if (existing.practice_id !== practiceId) throw new Error('Body area not found');

    const fieldMap: Record<string, string> = {
      name: 'name',
      shortCode: 'short_code',
      durationAdjustmentMinutes: 'duration_adjustment_minutes',
      additionalEquipmentTags: 'additional_equipment_tags',
      additionalConsent: 'additional_consent',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 0) return existing;

    values.push(id);

    const result = await this.pool.query(
      `UPDATE body_area_modifiers SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return result.rows[0];
  }

  async deleteBodyArea(practiceId: string, id: string): Promise<void> {
    const existing = await this.getBodyArea(id);
    if (!existing) throw new Error('Body area not found');
    if (existing.is_system) throw new Error('Cannot delete system body area');
    if (existing.practice_id !== practiceId) throw new Error('Body area not found');

    await this.pool.query('DELETE FROM body_area_modifiers WHERE id = $1', [id]);
  }

  // --- APPOINTMENT TYPES ---

  async listAppointmentTypes(practiceId: string, includeInactive = false): Promise<AppointmentTypeRow[]> {
    const where = includeInactive
      ? 'practice_id = $1'
      : 'practice_id = $1 AND is_active = true';
    const result = await this.pool.query(
      `SELECT * FROM appointment_types WHERE ${where} ORDER BY sort_order, name`,
      [practiceId],
    );
    return result.rows;
  }

  async getAppointmentType(practiceId: string, id: string): Promise<AppointmentTypeRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM appointment_types WHERE id = $1 AND practice_id = $2',
      [id, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async createAppointmentType(
    practiceId: string,
    input: CreateAppointmentTypeInput,
  ): Promise<AppointmentTypeRow> {
    const serviceLineIds = input.serviceLineIds.length > 0 ? input.serviceLineIds : [input.serviceLineId];
    const result = await this.pool.query(
      `INSERT INTO appointment_types (
        practice_id, service_line_id, name, short_name, color, duration_blocks,
        default_reason, sort_order, library_id, display_name, service_line_ids,
        body_area_modifier_ids, equipment_tags, provider_scope, is_custom,
        price_cents, cpt_codes, requires_consultation, series_enabled, series_count,
        online_bookable, photo_required
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22
      ) RETURNING *`,
      [
        practiceId, input.serviceLineId, input.name, input.shortName, input.color, input.durationBlocks,
        input.defaultReason ?? null, input.sortOrder, input.libraryId ?? null,
        input.displayName ?? input.name, serviceLineIds,
        input.bodyAreaModifierIds, input.equipmentTags, input.providerScope, input.isCustom,
        input.priceCents ?? null, input.cptCodes, input.requiresConsultation,
        input.seriesEnabled, input.seriesCount ?? null,
        input.onlineBookable, input.photoRequired,
      ],
    );
    return result.rows[0];
  }

  async cloneFromLibrary(
    practiceId: string,
    input: CloneFromLibraryInput,
  ): Promise<AppointmentTypeRow> {
    const lib = await this.getLibraryItem(input.libraryId);
    if (!lib) throw new Error('Library item not found');

    const result = await this.pool.query(
      `INSERT INTO appointment_types (
        practice_id, service_line_id, name, short_name, color, duration_blocks,
        library_id, display_name, service_line_ids, body_area_modifier_ids,
        equipment_tags, provider_scope, is_custom, price_cents, cpt_codes
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, false, $13, $14
      ) RETURNING *`,
      [
        practiceId, input.serviceLineId, lib.standard_name, input.shortName,
        input.color ?? lib.default_color, input.durationBlocks,
        input.libraryId, input.displayName ?? lib.standard_name, [input.serviceLineId],
        input.bodyAreaModifierIds, lib.equipment_tags, lib.provider_scope,
        input.priceCents ?? null, lib.cpt_codes,
      ],
    );
    return result.rows[0];
  }

  async updateAppointmentType(
    practiceId: string,
    id: string,
    input: UpdateAppointmentTypeInput,
  ): Promise<AppointmentTypeRow> {
    const fieldMap: Record<string, string> = {
      name: 'name',
      shortName: 'short_name',
      displayName: 'display_name',
      color: 'color',
      durationBlocks: 'duration_blocks',
      defaultReason: 'default_reason',
      sortOrder: 'sort_order',
      libraryId: 'library_id',
      serviceLineIds: 'service_line_ids',
      bodyAreaModifierIds: 'body_area_modifier_ids',
      equipmentTags: 'equipment_tags',
      providerScope: 'provider_scope',
      isCustom: 'is_custom',
      priceCents: 'price_cents',
      cptCodes: 'cpt_codes',
      requiresConsultation: 'requires_consultation',
      seriesEnabled: 'series_enabled',
      seriesCount: 'series_count',
      onlineBookable: 'online_bookable',
      photoRequired: 'photo_required',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 0) {
      const existing = await this.getAppointmentType(practiceId, id);
      if (!existing) throw new Error('Appointment type not found');
      return existing;
    }

    values.push(id);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE appointment_types SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Appointment type not found');
    return result.rows[0];
  }

  async deactivateAppointmentType(practiceId: string, id: string): Promise<AppointmentTypeRow> {
    const result = await this.pool.query(
      `UPDATE appointment_types SET is_active = false
       WHERE id = $1 AND practice_id = $2 RETURNING *`,
      [id, practiceId],
    );
    if (result.rows.length === 0) throw new Error('Appointment type not found');
    return result.rows[0];
  }
}
