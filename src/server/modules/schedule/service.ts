import type pg from 'pg';
import type {
  CreateAppointmentInput,
  UpdateAppointmentInput,
  ListPatientAppointmentsInput,
} from './schemas.js';
import type { DomainEventBus } from '../../events/bus.js';
import { buildEvent, type ActorContext } from '../../events/builder.js';

export interface TimeSlot {
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  durationBlocks: number;
}

export interface AppointmentRow {
  id: string;
  practice_id: string;
  patient_id: string;
  provider_id: string;
  appointment_type_id: string;
  service_line_id: string;
  start_time: string;
  duration_blocks: number;
  status: string;
  chief_complaint: string | null;
  notes: string | null;
  cancelled_reason: string | null;
  cancelled_at: string | null;
  checked_in_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface GridSlot {
  time: string;
  appointment: AppointmentRow | null;
}

// Valid status transitions: current → allowed next states
const STATUS_TRANSITIONS: Record<string, string[]> = {
  scheduled: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
};

export class ScheduleService {
  constructor(
    private pool: pg.Pool,
    private eventBus: DomainEventBus,
  ) {}

  /**
   * NOTE: Phase 2 core treats provider schedule times as UTC. The `practice.timezone`
   * column exists but is not yet used for slot generation — full TZ-aware scheduling
   * is Phase 2.5 (requires date-fns-tz wall-clock conversion). For now, schedule
   * `08:00` means 08:00 UTC, not 08:00 local time.
   */
  async getAvailableSlots(
    practiceId: string,
    providerId: string,
    date: string,
    appointmentTypeId: string,
  ): Promise<TimeSlot[]> {
    // 1. Get practice block size
    const practiceResult = await this.pool.query(
      'SELECT schedule_block_minutes FROM practices WHERE id = $1',
      [practiceId],
    );
    if (practiceResult.rows.length === 0) throw new Error('Practice not found');
    const blockMinutes = practiceResult.rows[0].schedule_block_minutes;

    // 2. Get appointment type duration
    const typeResult = await this.pool.query(
      'SELECT duration_blocks FROM appointment_types WHERE id = $1 AND practice_id = $2',
      [appointmentTypeId, practiceId],
    );
    if (typeResult.rows.length === 0) throw new Error('Appointment type not found');
    const durationBlocks = typeResult.rows[0].duration_blocks;

    // 3. Determine working windows for the date
    const windows = await this.getWorkingWindows(providerId, date);
    if (windows.length === 0) return [];

    // 4. Get existing appointments for this provider on this date
    const existingResult = await this.pool.query(
      `SELECT start_time, duration_blocks FROM appointments
       WHERE provider_id = $1
         AND start_time >= ($2::date)::timestamptz
         AND start_time < (($2::date) + interval '1 day')::timestamptz
         AND status NOT IN ('cancelled')`,
      [providerId, date],
    );

    // 5. Generate slots and filter out conflicts
    const slots: TimeSlot[] = [];
    const slotDurationMs = durationBlocks * blockMinutes * 60 * 1000;
    const blockMs = blockMinutes * 60 * 1000;

    for (const window of windows) {
      const windowStart = new Date(`${date}T${window.start}Z`).getTime();
      const windowEnd = new Date(`${date}T${window.end}Z`).getTime();

      let cursor = windowStart;
      while (cursor + slotDurationMs <= windowEnd) {
        const hasConflict = existingResult.rows.some((appt) => {
          const apptStart = new Date(appt.start_time).getTime();
          const apptEnd = apptStart + appt.duration_blocks * blockMs;
          return cursor < apptEnd && cursor + slotDurationMs > apptStart;
        });

        if (!hasConflict) {
          slots.push({
            startTime: new Date(cursor).toISOString(),
            endTime: new Date(cursor + slotDurationMs).toISOString(),
            durationBlocks,
          });
        }

        cursor += blockMs;
      }
    }

    return slots;
  }

  async getScheduleGrid(
    practiceId: string,
    providerId: string,
    date: string,
  ): Promise<{ slots: GridSlot[]; workingHours: { start: string; end: string }[] }> {
    const practiceResult = await this.pool.query(
      'SELECT schedule_block_minutes FROM practices WHERE id = $1',
      [practiceId],
    );
    if (practiceResult.rows.length === 0) throw new Error('Practice not found');
    const blockMinutes = practiceResult.rows[0].schedule_block_minutes;

    const windows = await this.getWorkingWindows(providerId, date);
    if (windows.length === 0) return { slots: [], workingHours: [] };

    const apptResult = await this.pool.query(
      `SELECT * FROM appointments
       WHERE provider_id = $1
         AND start_time >= ($2::date)::timestamptz
         AND start_time < (($2::date) + interval '1 day')::timestamptz
         AND status NOT IN ('cancelled')
       ORDER BY start_time`,
      [providerId, date],
    );
    const appointments: AppointmentRow[] = apptResult.rows;

    const slots: GridSlot[] = [];
    const blockMs = blockMinutes * 60 * 1000;

    for (const window of windows) {
      const windowStart = new Date(`${date}T${window.start}Z`).getTime();
      const windowEnd = new Date(`${date}T${window.end}Z`).getTime();
      let cursor = windowStart;

      while (cursor < windowEnd) {
        const appt = appointments.find((a) => {
          const apptStart = new Date(a.start_time).getTime();
          const apptEnd = apptStart + a.duration_blocks * blockMs;
          return cursor >= apptStart && cursor < apptEnd;
        }) ?? null;

        slots.push({
          time: new Date(cursor).toISOString(),
          appointment: appt,
        });

        cursor += blockMs;
      }
    }

    return { slots, workingHours: windows };
  }

  async createAppointment(
    practiceId: string,
    actor: ActorContext,
    input: CreateAppointmentInput,
  ): Promise<AppointmentRow> {
    const typeResult = await this.pool.query(
      'SELECT duration_blocks FROM appointment_types WHERE id = $1 AND practice_id = $2',
      [input.appointmentTypeId, practiceId],
    );
    if (typeResult.rows.length === 0) throw new Error('Appointment type not found');
    const durationBlocks = typeResult.rows[0].duration_blocks;

    const conflict = await this.checkConflict(
      practiceId,
      input.providerId,
      input.startTime,
      durationBlocks,
      null,
    );
    if (conflict) throw new Error('Time slot conflicts with existing appointment');

    const result = await this.pool.query(
      `INSERT INTO appointments (
        practice_id, patient_id, provider_id, appointment_type_id,
        service_line_id, start_time, duration_blocks,
        chief_complaint, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        practiceId,
        input.patientId,
        input.providerId,
        input.appointmentTypeId,
        input.serviceLineId,
        input.startTime,
        durationBlocks,
        input.chiefComplaint ?? null,
        input.notes ?? null,
        actor.userId,
      ],
    );
    const row = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'appointment.scheduled',
        entityType: 'appointment',
        entityId: row.id,
        payload: {
          patientId: row.patient_id,
          providerId: row.provider_id,
          startTime: row.start_time instanceof Date
            ? row.start_time.toISOString()
            : String(row.start_time),
        },
        newState: row,
      }),
    );

    return row;
  }

  async updateAppointment(
    practiceId: string,
    appointmentId: string,
    input: UpdateAppointmentInput,
    actor: ActorContext,
  ): Promise<AppointmentRow> {
    const existing = await this.pool.query(
      'SELECT * FROM appointments WHERE id = $1 AND practice_id = $2',
      [appointmentId, practiceId],
    );
    if (existing.rows.length === 0) throw new Error('Appointment not found');
    const appt = existing.rows[0];

    if (appt.status === 'cancelled' || appt.status === 'completed') {
      throw new Error(`Cannot update ${appt.status} appointment`);
    }

    const newStartTime = input.startTime ?? appt.start_time;
    const newProviderId = input.providerId ?? appt.provider_id;

    let durationBlocks = appt.duration_blocks;
    if (input.appointmentTypeId) {
      const typeResult = await this.pool.query(
        'SELECT duration_blocks FROM appointment_types WHERE id = $1 AND practice_id = $2',
        [input.appointmentTypeId, practiceId],
      );
      if (typeResult.rows.length === 0) throw new Error('Appointment type not found');
      durationBlocks = typeResult.rows[0].duration_blocks;
    }

    if (input.startTime || input.providerId || input.appointmentTypeId) {
      const conflict = await this.checkConflict(
        practiceId,
        newProviderId,
        typeof newStartTime === 'string' ? newStartTime : new Date(newStartTime).toISOString(),
        durationBlocks,
        appointmentId,
      );
      if (conflict) throw new Error('Time slot conflicts with existing appointment');
    }

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (input.startTime !== undefined) {
      setClauses.push(`start_time = $${idx++}`);
      values.push(input.startTime);
    }
    if (input.providerId !== undefined) {
      setClauses.push(`provider_id = $${idx++}`);
      values.push(input.providerId);
    }
    if (input.appointmentTypeId !== undefined) {
      setClauses.push(`appointment_type_id = $${idx++}`);
      values.push(input.appointmentTypeId);
      setClauses.push(`duration_blocks = $${idx++}`);
      values.push(durationBlocks);
    }
    if (input.chiefComplaint !== undefined) {
      setClauses.push(`chief_complaint = $${idx++}`);
      values.push(input.chiefComplaint);
    }
    if (input.notes !== undefined) {
      setClauses.push(`notes = $${idx++}`);
      values.push(input.notes);
    }

    values.push(appointmentId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE appointments SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    const after = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'appointment.updated',
        entityType: 'appointment',
        entityId: appointmentId,
        payload: { changes: input },
        previousState: appt,
        newState: after,
      }),
    );

    return after;
  }

  async cancelAppointment(
    practiceId: string,
    appointmentId: string,
    reason: string,
    actor: ActorContext,
  ): Promise<AppointmentRow> {
    const existing = await this.pool.query(
      'SELECT * FROM appointments WHERE id = $1 AND practice_id = $2',
      [appointmentId, practiceId],
    );
    if (existing.rows.length === 0) throw new Error('Appointment not found');
    const before = existing.rows[0];
    if (before.status === 'cancelled') throw new Error('Appointment already cancelled');
    if (before.status === 'completed') throw new Error('Cannot cancel completed appointment');

    const result = await this.pool.query(
      `UPDATE appointments
       SET status = 'cancelled', cancelled_reason = $1, cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND practice_id = $3
       RETURNING *`,
      [reason, appointmentId, practiceId],
    );
    const after = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'appointment.cancelled',
        entityType: 'appointment',
        entityId: appointmentId,
        payload: { reason },
        previousState: before,
        newState: after,
      }),
    );

    return after;
  }

  async transitionStatus(
    practiceId: string,
    appointmentId: string,
    newStatus: string,
    actor: ActorContext,
  ): Promise<AppointmentRow> {
    const existing = await this.pool.query(
      'SELECT * FROM appointments WHERE id = $1 AND practice_id = $2',
      [appointmentId, practiceId],
    );
    if (existing.rows.length === 0) throw new Error('Appointment not found');
    const before = existing.rows[0];

    const currentStatus = before.status;
    const allowed = STATUS_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Cannot transition from ${currentStatus} to ${newStatus}`);
    }

    const extraSets: string[] = [];
    if (newStatus === 'checked_in') extraSets.push('checked_in_at = NOW()');
    if (newStatus === 'cancelled') extraSets.push("cancelled_at = NOW()");

    const setClause = [`status = $1`, `updated_at = NOW()`, ...extraSets].join(', ');

    const result = await this.pool.query(
      `UPDATE appointments SET ${setClause}
       WHERE id = $2 AND practice_id = $3
       RETURNING *`,
      [newStatus, appointmentId, practiceId],
    );
    const after = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'appointment.status_changed',
        entityType: 'appointment',
        entityId: appointmentId,
        payload: { oldStatus: currentStatus, newStatus },
        previousState: before,
        newState: after,
      }),
    );

    return after;
  }

  async getAppointment(
    practiceId: string,
    appointmentId: string,
  ): Promise<AppointmentRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM appointments WHERE id = $1 AND practice_id = $2',
      [appointmentId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * List all appointments for a patient with optional filters.
   *
   * - `window: 'upcoming'` returns only future appointments (start_time >= now), soonest first.
   * - `window: 'past'` returns appointments with start_time < now, most recent first.
   * - Omit `window` for all history (most recent first).
   * - `includeCancelled` defaults to false; cancelled appointments are hidden unless opted in.
   * - Pagination via `limit` (max 500) and `offset`.
   *
   * Results are scoped to practice_id so one practice can never see another's appointments.
   */
  async listAppointmentsForPatient(
    practiceId: string,
    patientId: string,
    input: ListPatientAppointmentsInput,
  ): Promise<{ appointments: AppointmentRow[]; total: number }> {
    const conditions: string[] = ['practice_id = $1', 'patient_id = $2'];
    const values: unknown[] = [practiceId, patientId];
    let idx = 3;

    if (!input.includeCancelled) {
      conditions.push(`status != 'cancelled'`);
    }
    if (input.status) {
      conditions.push(`status = $${idx++}`);
      values.push(input.status);
    }
    if (input.providerId) {
      conditions.push(`provider_id = $${idx++}`);
      values.push(input.providerId);
    }
    if (input.startDate) {
      conditions.push(`start_time >= ($${idx++}::date)::timestamptz`);
      values.push(input.startDate);
    }
    if (input.endDate) {
      // endDate is inclusive: include everything up to end of that day
      conditions.push(`start_time < (($${idx++}::date) + interval '1 day')::timestamptz`);
      values.push(input.endDate);
    }
    if (input.window === 'upcoming') {
      conditions.push(`start_time >= NOW()`);
    } else if (input.window === 'past') {
      conditions.push(`start_time < NOW()`);
    }

    const where = conditions.join(' AND ');
    // Upcoming queries sort soonest-first; everything else sorts newest-first
    const orderBy =
      input.window === 'upcoming' ? 'start_time ASC' : 'start_time DESC';

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM appointments WHERE ${where}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(input.limit);
    const limitParam = idx++;
    values.push(input.offset);
    const offsetParam = idx++;

    const result = await this.pool.query(
      `SELECT * FROM appointments WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    return { appointments: result.rows, total };
  }

  /**
   * Return the single next upcoming non-cancelled appointment for a patient,
   * or null if none exists. Useful for the patient chart "next appointment"
   * card and for recall/reminder workflows.
   */
  async getNextAppointmentForPatient(
    practiceId: string,
    patientId: string,
  ): Promise<AppointmentRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM appointments
       WHERE practice_id = $1
         AND patient_id = $2
         AND status NOT IN ('cancelled', 'no_show', 'completed')
         AND start_time >= NOW()
       ORDER BY start_time ASC
       LIMIT 1`,
      [practiceId, patientId],
    );
    return result.rows[0] ?? null;
  }

  /** Get the provider's working windows for a given date, applying any overrides. */
  private async getWorkingWindows(
    providerId: string,
    date: string,
  ): Promise<{ start: string; end: string }[]> {
    const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();

    const overrideResult = await this.pool.query(
      `SELECT override_type, start_time, end_time FROM schedule_overrides
       WHERE provider_id = $1 AND override_date = $2`,
      [providerId, date],
    );

    const override = overrideResult.rows[0];
    if (override) {
      if (override.override_type === 'blocked') return [];
      return [{ start: override.start_time, end: override.end_time }];
    }

    const scheduleResult = await this.pool.query(
      `SELECT start_time, end_time FROM provider_schedules
       WHERE provider_id = $1 AND day_of_week = $2 AND is_active = true
       ORDER BY start_time`,
      [providerId, dayOfWeek],
    );

    return scheduleResult.rows.map((r) => ({ start: r.start_time, end: r.end_time }));
  }

  private async checkConflict(
    practiceId: string,
    providerId: string,
    startTime: string,
    durationBlocks: number,
    excludeAppointmentId: string | null,
  ): Promise<boolean> {
    const practiceResult = await this.pool.query(
      'SELECT schedule_block_minutes FROM practices WHERE id = $1',
      [practiceId],
    );
    const blockMinutes = practiceResult.rows[0].schedule_block_minutes;
    const durationMinutes = durationBlocks * blockMinutes;

    let query = `
      SELECT id FROM appointments
      WHERE provider_id = $1
        AND status NOT IN ('cancelled')
        AND start_time < ($2::timestamptz + ($3 || ' minutes')::interval)
        AND ($2::timestamptz) < (start_time + (duration_blocks * $4 || ' minutes')::interval)
    `;
    const params: unknown[] = [providerId, startTime, durationMinutes, blockMinutes];

    if (excludeAppointmentId) {
      query += ` AND id != $5`;
      params.push(excludeAppointmentId);
    }

    const result = await this.pool.query(query, params);
    return result.rows.length > 0;
  }
}
