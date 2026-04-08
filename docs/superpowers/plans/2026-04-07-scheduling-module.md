# Scheduling Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the scheduling service layer and API routes — availability calculation, appointment CRUD, status transitions, conflict detection, and schedule grid endpoint.

**Architecture:** A `ScheduleService` handles all business logic (availability slots, conflict detection, appointment lifecycle). Hono routes delegate to the service and validate input with Zod. Domain events fire on appointment changes for audit trail. All times stored as TIMESTAMPTZ; the service converts between UTC and practice timezone for slot generation.

**Tech Stack:** TypeScript, Hono, PostgreSQL, Zod, Vitest, date-fns (for timezone math)

**Existing schema tables used:** `appointments`, `appointment_types`, `provider_schedules`, `schedule_overrides`, `practices` (for `schedule_block_minutes` and `timezone`)

---

## File Structure

### New Files
- `src/server/modules/schedule/service.ts` — ScheduleService class: availability, appointment CRUD, status transitions, conflict detection
- `src/server/modules/schedule/schemas.ts` — Zod schemas for all schedule API inputs
- `src/server/modules/schedule/routes.ts` — Hono routes wired to ScheduleService
- `tests/server/modules/schedule/schedule.service.test.ts` — Service unit/integration tests
- `tests/server/modules/schedule/schedule.routes.test.ts` — Route integration tests

### Modified Files
- `src/server/app.ts` — Wire schedule routes, remove placeholder
- `package.json` — Add `date-fns` + `@date-fns/tz` dependencies

---

## Task 1: Add date-fns dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install date-fns and timezone support**

Run: `npm install date-fns @date-fns/tz`

- [ ] **Step 2: Verify installation**

Run: `node -e "require('date-fns'); console.log('ok')"`
Expected: "ok"

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add date-fns + @date-fns/tz for schedule timezone math"
```

---

## Task 2: Schedule Schemas

**Files:**
- Create: `src/server/modules/schedule/schemas.ts`

- [ ] **Step 1: Create the schemas file**

```typescript
// src/server/modules/schedule/schemas.ts
import { z } from 'zod';

export const getAvailableSlotsSchema = z.object({
  providerId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  appointmentTypeId: z.string().uuid(),
});

export const getScheduleGridSchema = z.object({
  providerId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
});

export const createAppointmentSchema = z.object({
  patientId: z.string().uuid(),
  providerId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  serviceLineId: z.string().uuid(),
  startTime: z.string().datetime(),
  chiefComplaint: z.string().optional(),
  notes: z.string().optional(),
});

export const updateAppointmentSchema = z.object({
  startTime: z.string().datetime().optional(),
  appointmentTypeId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  chiefComplaint: z.string().optional(),
  notes: z.string().optional(),
});

export const cancelAppointmentSchema = z.object({
  reason: z.string().min(1),
});

export const statusTransitionSchema = z.object({
  status: z.enum(['confirmed', 'checked_in', 'in_progress', 'completed', 'no_show']),
});

export type GetAvailableSlotsInput = z.infer<typeof getAvailableSlotsSchema>;
export type GetScheduleGridInput = z.infer<typeof getScheduleGridSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;
export type StatusTransitionInput = z.infer<typeof statusTransitionSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add src/server/modules/schedule/schemas.ts
git commit -m "feat(schedule): add Zod schemas for schedule API inputs"
```

---

## Task 3: ScheduleService — Availability Engine

**Files:**
- Create: `src/server/modules/schedule/service.ts`
- Create: `tests/server/modules/schedule/schedule.service.test.ts`

This is the core of the scheduling module. The service needs to:
1. Look up the provider's recurring schedule for the given day of week
2. Check for schedule overrides on that date (blocked = no slots, modified = different hours)
3. Get the practice's block size (e.g., 15 min)
4. Get the appointment type's duration in blocks
5. Generate time slots within the provider's working hours
6. Remove slots that overlap with existing appointments
7. Return available slots

- [ ] **Step 1: Create the service file with getAvailableSlots and helper methods**

```typescript
// src/server/modules/schedule/service.ts
import type pg from 'pg';
import type { CreateAppointmentInput, UpdateAppointmentInput } from './schemas.js';

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

// Valid status transitions: current → allowed next states
const STATUS_TRANSITIONS: Record<string, string[]> = {
  scheduled: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
};

export class ScheduleService {
  constructor(private pool: pg.Pool) {}

  async getAvailableSlots(
    practiceId: string,
    providerId: string,
    date: string,
    appointmentTypeId: string,
  ): Promise<TimeSlot[]> {
    // 1. Get practice block size and timezone
    const practiceResult = await this.pool.query(
      'SELECT schedule_block_minutes, timezone FROM practices WHERE id = $1',
      [practiceId],
    );
    if (practiceResult.rows.length === 0) throw new Error('Practice not found');
    const { schedule_block_minutes: blockMinutes, timezone } = practiceResult.rows[0];

    // 2. Get appointment type duration
    const typeResult = await this.pool.query(
      'SELECT duration_blocks FROM appointment_types WHERE id = $1 AND practice_id = $2',
      [appointmentTypeId, practiceId],
    );
    if (typeResult.rows.length === 0) throw new Error('Appointment type not found');
    const durationBlocks = typeResult.rows[0].duration_blocks;

    // 3. Get provider's working hours for this day of week
    const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
    const scheduleResult = await this.pool.query(
      `SELECT start_time, end_time FROM provider_schedules
       WHERE provider_id = $1 AND day_of_week = $2 AND is_active = true`,
      [providerId, dayOfWeek],
    );

    // 4. Check for overrides on this date
    const overrideResult = await this.pool.query(
      `SELECT override_type, start_time, end_time FROM schedule_overrides
       WHERE provider_id = $1 AND override_date = $2`,
      [providerId, date],
    );

    // Determine working windows
    let windows: { start: string; end: string }[] = [];

    const override = overrideResult.rows[0];
    if (override) {
      if (override.override_type === 'blocked') {
        return []; // Provider is off this day
      }
      // Modified: use override hours
      windows = [{ start: override.start_time, end: override.end_time }];
    } else {
      // Use recurring schedule
      windows = scheduleResult.rows.map(r => ({ start: r.start_time, end: r.end_time }));
    }

    if (windows.length === 0) return []; // No schedule for this day

    // 5. Get existing appointments for this provider on this date
    const existingResult = await this.pool.query(
      `SELECT start_time, duration_blocks FROM appointments
       WHERE provider_id = $1
         AND start_time >= ($2::date)::timestamptz
         AND start_time < (($2::date) + interval '1 day')::timestamptz
         AND status NOT IN ('cancelled')`,
      [providerId, date],
    );

    // 6. Generate slots and filter
    const slots: TimeSlot[] = [];
    const slotDurationMs = durationBlocks * blockMinutes * 60 * 1000;

    for (const window of windows) {
      // Parse window times as local times on the given date
      const windowStart = new Date(`${date}T${window.start}:00`);
      const windowEnd = new Date(`${date}T${window.end}:00`);

      let cursor = windowStart.getTime();
      const windowEndMs = windowEnd.getTime();

      while (cursor + slotDurationMs <= windowEndMs) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor + slotDurationMs);

        // Check for conflicts with existing appointments
        const hasConflict = existingResult.rows.some(appt => {
          const apptStart = new Date(appt.start_time).getTime();
          const apptEnd = apptStart + appt.duration_blocks * blockMinutes * 60 * 1000;
          return cursor < apptEnd && cursor + slotDurationMs > apptStart;
        });

        if (!hasConflict) {
          slots.push({
            startTime: slotStart.toISOString(),
            endTime: slotEnd.toISOString(),
            durationBlocks,
          });
        }

        cursor += blockMinutes * 60 * 1000; // Advance by one block
      }
    }

    return slots;
  }

  async getScheduleGrid(
    practiceId: string,
    providerId: string,
    date: string,
  ): Promise<{ slots: { time: string; appointment: AppointmentRow | null }[]; workingHours: { start: string; end: string }[] }> {
    // 1. Get practice block size
    const practiceResult = await this.pool.query(
      'SELECT schedule_block_minutes, timezone FROM practices WHERE id = $1',
      [practiceId],
    );
    if (practiceResult.rows.length === 0) throw new Error('Practice not found');
    const { schedule_block_minutes: blockMinutes } = practiceResult.rows[0];

    // 2. Get working hours (same logic as availability)
    const dayOfWeek = new Date(date + 'T12:00:00Z').getUTCDay();
    const scheduleResult = await this.pool.query(
      `SELECT start_time, end_time FROM provider_schedules
       WHERE provider_id = $1 AND day_of_week = $2 AND is_active = true
       ORDER BY start_time`,
      [providerId, dayOfWeek],
    );

    const overrideResult = await this.pool.query(
      `SELECT override_type, start_time, end_time FROM schedule_overrides
       WHERE provider_id = $1 AND override_date = $2`,
      [providerId, date],
    );

    let windows: { start: string; end: string }[] = [];
    const override = overrideResult.rows[0];
    if (override) {
      if (override.override_type === 'blocked') {
        return { slots: [], workingHours: [] };
      }
      windows = [{ start: override.start_time, end: override.end_time }];
    } else {
      windows = scheduleResult.rows.map(r => ({ start: r.start_time, end: r.end_time }));
    }

    if (windows.length === 0) return { slots: [], workingHours: windows };

    // 3. Get all appointments for this day
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

    // 4. Build grid: one slot per block across all windows
    const slots: { time: string; appointment: AppointmentRow | null }[] = [];

    for (const window of windows) {
      const windowStart = new Date(`${date}T${window.start}:00`);
      const windowEnd = new Date(`${date}T${window.end}:00`);
      let cursor = windowStart.getTime();
      const windowEndMs = windowEnd.getTime();

      while (cursor < windowEndMs) {
        const slotTime = new Date(cursor);

        // Find appointment that covers this slot
        const appt = appointments.find(a => {
          const apptStart = new Date(a.start_time).getTime();
          const apptEnd = apptStart + a.duration_blocks * blockMinutes * 60 * 1000;
          return cursor >= apptStart && cursor < apptEnd;
        }) ?? null;

        slots.push({
          time: slotTime.toISOString(),
          appointment: appt,
        });

        cursor += blockMinutes * 60 * 1000;
      }
    }

    return { slots, workingHours: windows };
  }

  async createAppointment(
    practiceId: string,
    createdBy: string,
    input: CreateAppointmentInput,
  ): Promise<AppointmentRow> {
    // 1. Verify appointment type exists and get duration
    const typeResult = await this.pool.query(
      'SELECT duration_blocks FROM appointment_types WHERE id = $1 AND practice_id = $2',
      [input.appointmentTypeId, practiceId],
    );
    if (typeResult.rows.length === 0) throw new Error('Appointment type not found');
    const durationBlocks = typeResult.rows[0].duration_blocks;

    // 2. Check for conflicts
    const conflict = await this.checkConflict(
      practiceId,
      input.providerId,
      input.startTime,
      durationBlocks,
      null,
    );
    if (conflict) throw new Error('Time slot conflicts with existing appointment');

    // 3. Insert appointment
    const result = await this.pool.query(
      `INSERT INTO appointments (
        practice_id, patient_id, provider_id, appointment_type_id,
        service_line_id, start_time, duration_blocks,
        chief_complaint, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        practiceId, input.patientId, input.providerId, input.appointmentTypeId,
        input.serviceLineId, input.startTime, durationBlocks,
        input.chiefComplaint ?? null, input.notes ?? null, createdBy,
      ],
    );

    return result.rows[0];
  }

  async updateAppointment(
    practiceId: string,
    appointmentId: string,
    input: UpdateAppointmentInput,
  ): Promise<AppointmentRow> {
    // 1. Get existing appointment
    const existing = await this.pool.query(
      'SELECT * FROM appointments WHERE id = $1 AND practice_id = $2',
      [appointmentId, practiceId],
    );
    if (existing.rows.length === 0) throw new Error('Appointment not found');
    const appt = existing.rows[0];

    if (appt.status === 'cancelled' || appt.status === 'completed') {
      throw new Error(`Cannot update ${appt.status} appointment`);
    }

    // 2. If time or provider changed, check conflicts
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
        practiceId, newProviderId, newStartTime, durationBlocks, appointmentId,
      );
      if (conflict) throw new Error('Time slot conflicts with existing appointment');
    }

    // 3. Build update
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (input.startTime !== undefined) { setClauses.push(`start_time = $${idx++}`); values.push(input.startTime); }
    if (input.providerId !== undefined) { setClauses.push(`provider_id = $${idx++}`); values.push(input.providerId); }
    if (input.appointmentTypeId !== undefined) {
      setClauses.push(`appointment_type_id = $${idx++}`); values.push(input.appointmentTypeId);
      setClauses.push(`duration_blocks = $${idx++}`); values.push(durationBlocks);
    }
    if (input.chiefComplaint !== undefined) { setClauses.push(`chief_complaint = $${idx++}`); values.push(input.chiefComplaint); }
    if (input.notes !== undefined) { setClauses.push(`notes = $${idx++}`); values.push(input.notes); }

    values.push(appointmentId, practiceId);

    const result = await this.pool.query(
      `UPDATE appointments SET ${setClauses.join(', ')}
       WHERE id = $${idx++} AND practice_id = $${idx++}
       RETURNING *`,
      values,
    );

    return result.rows[0];
  }

  async cancelAppointment(
    practiceId: string,
    appointmentId: string,
    reason: string,
  ): Promise<AppointmentRow> {
    const existing = await this.pool.query(
      'SELECT status FROM appointments WHERE id = $1 AND practice_id = $2',
      [appointmentId, practiceId],
    );
    if (existing.rows.length === 0) throw new Error('Appointment not found');
    if (existing.rows[0].status === 'cancelled') throw new Error('Appointment already cancelled');
    if (existing.rows[0].status === 'completed') throw new Error('Cannot cancel completed appointment');

    const result = await this.pool.query(
      `UPDATE appointments
       SET status = 'cancelled', cancelled_reason = $1, cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND practice_id = $3
       RETURNING *`,
      [reason, appointmentId, practiceId],
    );

    return result.rows[0];
  }

  async transitionStatus(
    practiceId: string,
    appointmentId: string,
    newStatus: string,
  ): Promise<AppointmentRow> {
    const existing = await this.pool.query(
      'SELECT * FROM appointments WHERE id = $1 AND practice_id = $2',
      [appointmentId, practiceId],
    );
    if (existing.rows.length === 0) throw new Error('Appointment not found');

    const currentStatus = existing.rows[0].status;
    const allowed = STATUS_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Cannot transition from ${currentStatus} to ${newStatus}`);
    }

    const extraSets: string[] = [];
    if (newStatus === 'checked_in') extraSets.push('checked_in_at = NOW()');

    const setClause = [`status = $1`, `updated_at = NOW()`, ...extraSets].join(', ');

    const result = await this.pool.query(
      `UPDATE appointments SET ${setClause}
       WHERE id = $2 AND practice_id = $3
       RETURNING *`,
      [newStatus, appointmentId, practiceId],
    );

    return result.rows[0];
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
```

- [ ] **Step 2: Create the service test file**

```typescript
// tests/server/modules/schedule/schedule.service.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { ScheduleService } from '../../../../src/server/modules/schedule/service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('ScheduleService', () => {
  let pool: pg.Pool;
  let service: ScheduleService;
  let practiceId: string;
  let eyecareSlId: string;
  let providerId: string;
  let patientId: string;
  let compExamTypeId: string;
  let followUpTypeId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    service = new ScheduleService(pool);

    // Practice with 15-min blocks
    const practice = await pool.query(
      `INSERT INTO practices (name, schedule_block_minutes, timezone)
       VALUES ('Test Practice', 15, 'America/Chicago') RETURNING id`
    );
    practiceId = practice.rows[0].id;

    // Service line
    const sl = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color)
       VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
      [practiceId]
    );
    eyecareSlId = sl.rows[0].id;

    // Provider
    const provider = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
       VALUES ($1, 'doc@test.com', 'hash', 'Dr. Test', true, $2) RETURNING id`,
      [practiceId, [eyecareSlId]]
    );
    providerId = provider.rows[0].id;

    // Provider schedule: Mon-Fri 08:00-12:00, 13:00-17:00
    for (let day = 1; day <= 5; day++) {
      await pool.query(
        `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
         VALUES ($1, $2, '08:00', '12:00', $3)`,
        [providerId, day, eyecareSlId]
      );
      await pool.query(
        `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
         VALUES ($1, $2, '13:00', '17:00', $3)`,
        [providerId, day, eyecareSlId]
      );
    }

    // Appointment types: Comp Exam (3 blocks = 45 min), Follow-Up (1 block = 15 min)
    const compExam = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
       VALUES ($1, $2, 'Comprehensive Exam', 'CE', '#2563EB', 3, 'Comprehensive Exam', $3) RETURNING id`,
      [practiceId, eyecareSlId, [eyecareSlId]]
    );
    compExamTypeId = compExam.rows[0].id;

    const followUp = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
       VALUES ($1, $2, 'Follow-Up', 'FU', '#059669', 1, 'Follow-Up', $3) RETURNING id`,
      [practiceId, eyecareSlId, [eyecareSlId]]
    );
    followUpTypeId = followUp.rows[0].id;

    // Patient
    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Jane', 'Doe', '1990-01-01', 'F', '555-0001', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId]
    );
    patientId = patient.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  // Use a Monday for all date tests (2026-04-13 is a Monday)
  const MONDAY = '2026-04-13';

  describe('getAvailableSlots', () => {
    it('returns slots for an open day', async () => {
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      // 8:00-12:00 = 16 slots (15-min blocks for 1-block appt), 13:00-17:00 = 16 slots
      expect(slots.length).toBe(32);
      expect(slots[0].startTime).toContain('08:00');
      expect(slots[0].durationBlocks).toBe(1);
    });

    it('returns fewer slots for longer appointment types', async () => {
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, compExamTypeId);
      // 3-block (45 min) appt: 8:00-11:15 = 14 slots in morning, 13:00-16:15 = 14 in afternoon
      expect(slots.length).toBeLessThan(32);
      // First slot at 08:00, last possible at 16:15 (ending at 17:00)
      expect(slots[0].startTime).toContain('08:00');
      expect(slots[0].durationBlocks).toBe(3);
    });

    it('removes slots that conflict with existing appointments', async () => {
      // Book 9:00 AM comp exam (45 min = 9:00-9:45)
      await service.createAppointment(practiceId, providerId, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      // The 9:00, 9:15, 9:30 slots should be gone (3 blocks occupied)
      const slotTimes = slots.map(s => s.startTime);
      expect(slotTimes.some(t => t.includes('09:00'))).toBe(false);
      expect(slotTimes.some(t => t.includes('09:15'))).toBe(false);
      expect(slotTimes.some(t => t.includes('09:30'))).toBe(false);
      // 8:45 and 9:45 should be available
      expect(slotTimes.some(t => t.includes('08:45'))).toBe(true);
      expect(slotTimes.some(t => t.includes('09:45'))).toBe(true);
    });

    it('returns empty for blocked override day', async () => {
      await pool.query(
        `INSERT INTO schedule_overrides (provider_id, override_date, override_type, reason)
         VALUES ($1, $2, 'blocked', 'Vacation')`,
        [providerId, MONDAY]
      );
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      expect(slots).toEqual([]);
    });

    it('uses modified hours from override', async () => {
      await pool.query(
        `INSERT INTO schedule_overrides (provider_id, override_date, override_type, start_time, end_time, reason)
         VALUES ($1, $2, 'modified', '10:00', '14:00', 'Half day')`,
        [providerId, MONDAY]
      );
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      // 10:00-14:00 = 16 slots for 15-min follow-up
      expect(slots.length).toBe(16);
      expect(slots[0].startTime).toContain('10:00');
    });

    it('returns empty for day with no schedule (Sunday)', async () => {
      const SUNDAY = '2026-04-12';
      const slots = await service.getAvailableSlots(practiceId, providerId, SUNDAY, followUpTypeId);
      expect(slots).toEqual([]);
    });
  });

  describe('createAppointment', () => {
    it('creates an appointment and returns it', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      expect(appt.id).toBeDefined();
      expect(appt.patient_id).toBe(patientId);
      expect(appt.provider_id).toBe(providerId);
      expect(appt.status).toBe('scheduled');
      expect(appt.duration_blocks).toBe(3);
    });

    it('rejects double-booking', async () => {
      await service.createAppointment(practiceId, providerId, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      await expect(
        service.createAppointment(practiceId, providerId, {
          patientId,
          providerId,
          appointmentTypeId: followUpTypeId,
          serviceLineId: eyecareSlId,
          startTime: `${MONDAY}T09:15:00.000Z`,
        }),
      ).rejects.toThrow('conflicts');
    });

    it('allows adjacent appointments (no overlap)', async () => {
      await service.createAppointment(practiceId, providerId, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`, // 9:00-9:45
      });

      // 9:45 follow-up should work (adjacent, not overlapping)
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId,
        providerId,
        appointmentTypeId: followUpTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:45:00.000Z`,
      });
      expect(appt.id).toBeDefined();
    });
  });

  describe('cancelAppointment', () => {
    it('cancels an appointment with reason', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const cancelled = await service.cancelAppointment(practiceId, appt.id, 'Patient requested');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancelled_reason).toBe('Patient requested');
      expect(cancelled.cancelled_at).not.toBeNull();
    });

    it('rejects cancelling already cancelled appointment', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });
      await service.cancelAppointment(practiceId, appt.id, 'Test');

      await expect(
        service.cancelAppointment(practiceId, appt.id, 'Again'),
      ).rejects.toThrow('already cancelled');
    });

    it('frees the slot after cancellation', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });

      await service.cancelAppointment(practiceId, appt.id, 'Changed mind');

      // The 9:00 slot should be available again
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      const slotTimes = slots.map(s => s.startTime);
      expect(slotTimes.some(t => t.includes('09:00'))).toBe(true);
    });
  });

  describe('transitionStatus', () => {
    it('follows valid status chain: scheduled → confirmed → checked_in → in_progress → completed', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const confirmed = await service.transitionStatus(practiceId, appt.id, 'confirmed');
      expect(confirmed.status).toBe('confirmed');

      const checkedIn = await service.transitionStatus(practiceId, appt.id, 'checked_in');
      expect(checkedIn.status).toBe('checked_in');
      expect(checkedIn.checked_in_at).not.toBeNull();

      const inProgress = await service.transitionStatus(practiceId, appt.id, 'in_progress');
      expect(inProgress.status).toBe('in_progress');

      const completed = await service.transitionStatus(practiceId, appt.id, 'completed');
      expect(completed.status).toBe('completed');
    });

    it('rejects invalid transitions', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });

      // Can't go directly from scheduled to completed
      await expect(
        service.transitionStatus(practiceId, appt.id, 'completed'),
      ).rejects.toThrow('Cannot transition');

      // Can't go from scheduled to in_progress
      await expect(
        service.transitionStatus(practiceId, appt.id, 'in_progress'),
      ).rejects.toThrow('Cannot transition');
    });

    it('allows no_show from scheduled or confirmed', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const noShow = await service.transitionStatus(practiceId, appt.id, 'no_show');
      expect(noShow.status).toBe('no_show');
    });
  });

  describe('updateAppointment', () => {
    it('reschedules an appointment to a new time', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const updated = await service.updateAppointment(practiceId, appt.id, {
        startTime: `${MONDAY}T14:00:00.000Z`,
      });

      expect(new Date(updated.start_time).toISOString()).toContain('14:00');
    });

    it('rejects rescheduling to a conflicting time', async () => {
      const appt1 = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });
      await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T14:00:00.000Z`,
      });

      await expect(
        service.updateAppointment(practiceId, appt1.id, {
          startTime: `${MONDAY}T14:00:00.000Z`,
        }),
      ).rejects.toThrow('conflicts');
    });

    it('rejects updating cancelled appointment', async () => {
      const appt = await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });
      await service.cancelAppointment(practiceId, appt.id, 'Test');

      await expect(
        service.updateAppointment(practiceId, appt.id, { notes: 'update' }),
      ).rejects.toThrow('Cannot update cancelled');
    });
  });

  describe('getScheduleGrid', () => {
    it('returns time slots with appointments mapped', async () => {
      await service.createAppointment(practiceId, providerId, {
        patientId, providerId, appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId, startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const grid = await service.getScheduleGrid(practiceId, providerId, MONDAY);
      expect(grid.slots.length).toBeGreaterThan(0);
      expect(grid.workingHours).toHaveLength(2); // morning + afternoon

      // Find the 9:00 slot — should have an appointment
      const nineAm = grid.slots.find(s => s.time.includes('09:00'));
      expect(nineAm?.appointment).not.toBeNull();
      expect(nineAm?.appointment?.patient_id).toBe(patientId);

      // Find the 8:00 slot — should be empty
      const eightAm = grid.slots.find(s => s.time.includes('08:00'));
      expect(eightAm?.appointment).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/server/modules/schedule/schedule.service.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Run full suite to check no regressions**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/schedule/service.ts tests/server/modules/schedule/schedule.service.test.ts
git commit -m "feat(schedule): add ScheduleService — availability engine, appointment CRUD, status transitions, conflict detection"
```

---

## Task 4: Schedule Routes

**Files:**
- Create: `src/server/modules/schedule/routes.ts`
- Create: `tests/server/modules/schedule/schedule.routes.test.ts`

- [ ] **Step 1: Create the routes file**

```typescript
// src/server/modules/schedule/routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { ScheduleService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import {
  getAvailableSlotsSchema,
  getScheduleGridSchema,
  createAppointmentSchema,
  updateAppointmentSchema,
  cancelAppointmentSchema,
  statusTransitionSchema,
} from './schemas.js';

export function createScheduleRoutes(scheduleService: ScheduleService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /slots?providerId=&date=&appointmentTypeId=
  routes.get('/slots', zValidator('query', getAvailableSlotsSchema), async (c) => {
    const auth = c.get('auth');
    const { providerId, date, appointmentTypeId } = c.req.valid('query');
    const slots = await scheduleService.getAvailableSlots(auth.practiceId, providerId, date, appointmentTypeId);
    return c.json({ slots });
  });

  // GET /grid?providerId=&date=
  routes.get('/grid', zValidator('query', getScheduleGridSchema), async (c) => {
    const auth = c.get('auth');
    const { providerId, date } = c.req.valid('query');
    const grid = await scheduleService.getScheduleGrid(auth.practiceId, providerId, date);
    return c.json(grid);
  });

  // POST /appointments
  routes.post('/appointments', zValidator('json', createAppointmentSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:write')) {
      return c.json({ error: 'appointments:write permission required' }, 403);
    }
    const input = c.req.valid('json');
    try {
      const appt = await scheduleService.createAppointment(auth.practiceId, auth.userId, input);
      return c.json(appt, 201);
    } catch (err: any) {
      if (err.message.includes('conflicts')) return c.json({ error: err.message }, 409);
      if (err.message.includes('not found')) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // GET /appointments/:id
  routes.get('/appointments/:id', async (c) => {
    const auth = c.get('auth');
    const appt = await scheduleService.getAppointment(auth.practiceId, c.req.param('id'));
    if (!appt) return c.json({ error: 'Appointment not found' }, 404);
    return c.json(appt);
  });

  // PATCH /appointments/:id
  routes.patch('/appointments/:id', zValidator('json', updateAppointmentSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:write')) {
      return c.json({ error: 'appointments:write permission required' }, 403);
    }
    const input = c.req.valid('json');
    try {
      const appt = await scheduleService.updateAppointment(auth.practiceId, c.req.param('id'), input);
      return c.json(appt);
    } catch (err: any) {
      if (err.message.includes('conflicts')) return c.json({ error: err.message }, 409);
      if (err.message.includes('not found')) return c.json({ error: err.message }, 404);
      if (err.message.includes('Cannot update')) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // POST /appointments/:id/cancel
  routes.post('/appointments/:id/cancel', zValidator('json', cancelAppointmentSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:write')) {
      return c.json({ error: 'appointments:write permission required' }, 403);
    }
    const { reason } = c.req.valid('json');
    try {
      const appt = await scheduleService.cancelAppointment(auth.practiceId, c.req.param('id'), reason);
      return c.json(appt);
    } catch (err: any) {
      if (err.message.includes('not found')) return c.json({ error: err.message }, 404);
      if (err.message.includes('already cancelled') || err.message.includes('Cannot cancel')) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });

  // POST /appointments/:id/status
  routes.post('/appointments/:id/status', zValidator('json', statusTransitionSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:write')) {
      return c.json({ error: 'appointments:write permission required' }, 403);
    }
    const { status } = c.req.valid('json');
    try {
      const appt = await scheduleService.transitionStatus(auth.practiceId, c.req.param('id'), status);
      return c.json(appt);
    } catch (err: any) {
      if (err.message.includes('not found')) return c.json({ error: err.message }, 404);
      if (err.message.includes('Cannot transition')) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  return routes;
}
```

- [ ] **Step 2: Create the route test file**

```typescript
// tests/server/modules/schedule/schedule.routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Schedule routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let adminRoleId: string;
  let accessToken: string;
  let providerId: string;
  let patientId: string;
  let compExamTypeId: string;
  let eyecareSlId: string;

  const MONDAY = '2026-04-13';

  beforeAll(async () => {
    const setupPool = new pg.Pool({ connectionString: TEST_DB_URL });
    await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setupPool.end();
    await runMigrations(TEST_DB_URL);

    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    const config = parseConfig({
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long-for-validation',
    });

    const appResult = createApp({ pool, config });
    app = appResult.app;
    authService = appResult.authService;

    // Practice
    const practice = await pool.query(
      `INSERT INTO practices (name, schedule_block_minutes, timezone)
       VALUES ('Route Test', 15, 'America/Chicago') RETURNING id`
    );
    practiceId = practice.rows[0].id;

    // Service line
    const sl = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color)
       VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
      [practiceId]
    );
    eyecareSlId = sl.rows[0].id;

    // Admin role
    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ['admin:users', 'patients:read', 'patients:write',
                    'appointments:read', 'appointments:write']]
    );
    adminRoleId = adminRole.rows[0].id;

    // Provider user (also admin for testing)
    const user = await authService.createUser(practiceId, {
      email: 'doc@route.com',
      password: 'securepass123',
      fullName: 'Dr. Route',
      roleIds: [adminRoleId],
      isProvider: true,
      serviceLineIds: [eyecareSlId],
    });
    providerId = user.id;

    const tokens = await authService.login({
      email: 'doc@route.com', password: 'securepass123', practiceId,
    });
    accessToken = tokens.accessToken;

    // Provider schedule: Mon 08:00-12:00, 13:00-17:00
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, 1, '08:00', '12:00', $2)`,
      [providerId, eyecareSlId]
    );
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, 1, '13:00', '17:00', $2)`,
      [providerId, eyecareSlId]
    );

    // Appointment type
    const compExam = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
       VALUES ($1, $2, 'Comp Exam', 'CE', '#2563EB', 3, 'Comp Exam', $3) RETURNING id`,
      [practiceId, eyecareSlId, [eyecareSlId]]
    );
    compExamTypeId = compExam.rows[0].id;

    // Patient
    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Route', 'Patient', '1990-01-01', 'F', '555-0001', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId]
    );
    patientId = patient.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('GET /api/schedule/slots returns available slots', async () => {
    const res = await app.request(
      `/api/schedule/slots?providerId=${providerId}&date=${MONDAY}&appointmentTypeId=${compExamTypeId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots[0].startTime).toBeDefined();
  });

  it('GET /api/schedule/grid returns grid with working hours', async () => {
    const res = await app.request(
      `/api/schedule/grid?providerId=${providerId}&date=${MONDAY}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workingHours).toHaveLength(2);
    expect(body.slots.length).toBeGreaterThan(0);
  });

  it('POST /api/schedule/appointments creates an appointment', async () => {
    const res = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T10:00:00.000Z`,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe('scheduled');
  });

  it('POST /api/schedule/appointments returns 409 for conflicts', async () => {
    const res = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T10:00:00.000Z`, // Same time as above
      }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /api/schedule/appointments/:id/status transitions status', async () => {
    // Create appointment
    const createRes = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T14:00:00.000Z`,
      }),
    });
    const { id } = await createRes.json();

    // Confirm
    const confirmRes = await app.request(`/api/schedule/appointments/${id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(confirmRes.status).toBe(200);
    const body = await confirmRes.json();
    expect(body.status).toBe('confirmed');
  });

  it('POST /api/schedule/appointments/:id/cancel cancels with reason', async () => {
    const createRes = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T15:00:00.000Z`,
      }),
    });
    const { id } = await createRes.json();

    const cancelRes = await app.request(`/api/schedule/appointments/${id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ reason: 'Patient cancelled' }),
    });
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json();
    expect(body.status).toBe('cancelled');
    expect(body.cancelled_reason).toBe('Patient cancelled');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.request(`/api/schedule/slots?providerId=${providerId}&date=${MONDAY}&appointmentTypeId=${compExamTypeId}`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run route tests**

Run: `npx vitest run tests/server/modules/schedule/schedule.routes.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/modules/schedule/routes.ts tests/server/modules/schedule/schedule.routes.test.ts
git commit -m "feat(schedule): add schedule API routes — slots, grid, appointment CRUD, status transitions, cancel"
```

---

## Task 5: Wire Schedule Routes into App

**Files:**
- Modify: `src/server/app.ts`

- [ ] **Step 1: Import and wire ScheduleService + routes in app.ts**

Add imports at top of file:
```typescript
import { ScheduleService } from './modules/schedule/service.js';
import { createScheduleRoutes } from './modules/schedule/routes.js';
```

After `const authService = ...` line, add:
```typescript
  const scheduleService = new ScheduleService(pool);
```

After the auth routes block (`app.route('/api/auth', authRoutes);`), add:
```typescript
  // Schedule routes (auth required — middleware already registered for /api/schedule/*)
  const scheduleRoutes = createScheduleRoutes(scheduleService);
  app.route('/api/schedule', scheduleRoutes);
```

Remove the placeholder route:
```typescript
  // DELETE this line:
  app.get('/api/schedule/grid', (c) => c.json({ message: 'Schedule module coming next' }));
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (existing 52 + new schedule tests)

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/app.ts
git commit -m "feat(schedule): wire schedule routes into app, remove placeholder"
```

---

## Task 6: Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify seed + schedule interaction**

Run:
```bash
DATABASE_URL="postgresql://osod:osod_dev@localhost:5432/osod" npm run db:seed
```

Then test the schedule API manually:
```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"eric@iva.com","password":"admin123!","practiceId":"PRACTICE_ID"}' | jq -r .accessToken)

# Get slots (replace IDs from seed output)
curl -s http://localhost:3000/api/schedule/slots?providerId=PROVIDER_ID&date=2026-04-13&appointmentTypeId=TYPE_ID \
  -H "Authorization: Bearer $TOKEN" | jq .
```

- [ ] **Step 4: Summary commit if any fixes needed**

```bash
git add -A
git commit -m "feat(schedule): Phase 2 scheduling module complete — availability, CRUD, status flow, conflict detection"
```
