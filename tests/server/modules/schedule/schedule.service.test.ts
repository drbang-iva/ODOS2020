import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { ScheduleService } from '../../../../src/server/modules/schedule/service.js';
import { InProcessEventBus } from '../../../../src/server/events/bus.js';
import type { ActorContext } from '../../../../src/server/events/builder.js';
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
  let actor: ActorContext;

  // 2026-04-13 is a Monday
  const MONDAY = '2026-04-13';
  const SUNDAY = '2026-04-12';

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    const bus = new InProcessEventBus();
    service = new ScheduleService(pool, bus);

    const practice = await pool.query(
      `INSERT INTO practices (name, schedule_block_minutes, timezone)
       VALUES ('Test Practice', 15, 'America/Chicago') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const sl = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color)
       VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
      [practiceId],
    );
    eyecareSlId = sl.rows[0].id;

    const provider = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider, service_line_ids)
       VALUES ($1, 'doc@test.com', 'hash', 'Dr. Test', true, $2) RETURNING id`,
      [practiceId, [eyecareSlId]],
    );
    providerId = provider.rows[0].id;
    actor = { userId: providerId, practiceId, actorType: 'human' };

    // Provider schedule: Mon-Fri 08:00-12:00, 13:00-17:00
    for (let day = 1; day <= 5; day++) {
      await pool.query(
        `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
         VALUES ($1, $2, '08:00', '12:00', $3)`,
        [providerId, day, eyecareSlId],
      );
      await pool.query(
        `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
         VALUES ($1, $2, '13:00', '17:00', $3)`,
        [providerId, day, eyecareSlId],
      );
    }

    // Appointment types: Comp Exam (3 blocks = 45 min), Follow-Up (1 block = 15 min)
    const compExam = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
       VALUES ($1, $2, 'Comprehensive Exam', 'CE', '#2563EB', 3, 'Comprehensive Exam', $3) RETURNING id`,
      [practiceId, eyecareSlId, [eyecareSlId]],
    );
    compExamTypeId = compExam.rows[0].id;

    const followUp = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
       VALUES ($1, $2, 'Follow-Up', 'FU', '#059669', 1, 'Follow-Up', $3) RETURNING id`,
      [practiceId, eyecareSlId, [eyecareSlId]],
    );
    followUpTypeId = followUp.rows[0].id;

    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Jane', 'Doe', '1990-01-01', 'F', '555-0001', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = patient.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('getAvailableSlots', () => {
    it('returns slots for an open day with 15-min follow-up', async () => {
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      // 8:00-12:00 = 16 slots + 13:00-17:00 = 16 slots = 32
      expect(slots.length).toBe(32);
      expect(slots[0].durationBlocks).toBe(1);
    });

    it('returns fewer slots for longer appointment types', async () => {
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, compExamTypeId);
      // 3-block appt = 45 min. Morning 8:00-12:00 = 240 min. Last start at 11:15 → 14 slots
      // Same for afternoon → 28 total
      expect(slots.length).toBe(28);
      expect(slots[0].durationBlocks).toBe(3);
    });

    it('removes slots that conflict with existing appointments', async () => {
      // Book 9:00 AM comp exam (9:00-9:45)
      await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      const slotTimes = slots.map((s) => s.startTime);

      // 9:00, 9:15, 9:30 should be gone (covered by 3-block appt)
      expect(slotTimes.some((t) => t.endsWith('T09:00:00.000Z'))).toBe(false);
      expect(slotTimes.some((t) => t.endsWith('T09:15:00.000Z'))).toBe(false);
      expect(slotTimes.some((t) => t.endsWith('T09:30:00.000Z'))).toBe(false);

      // 8:45 and 9:45 should be available
      expect(slotTimes.some((t) => t.endsWith('T08:45:00.000Z'))).toBe(true);
      expect(slotTimes.some((t) => t.endsWith('T09:45:00.000Z'))).toBe(true);
    });

    it('returns empty for blocked override day', async () => {
      await pool.query(
        `INSERT INTO schedule_overrides (provider_id, override_date, override_type, reason)
         VALUES ($1, $2, 'blocked', 'Vacation')`,
        [providerId, MONDAY],
      );
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      expect(slots).toEqual([]);
    });

    it('uses modified hours from override', async () => {
      await pool.query(
        `INSERT INTO schedule_overrides (provider_id, override_date, override_type, start_time, end_time, reason)
         VALUES ($1, $2, 'modified', '10:00', '14:00', 'Half day')`,
        [providerId, MONDAY],
      );
      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      // 10:00-14:00 = 4 hours = 16 slots of 15 min
      expect(slots.length).toBe(16);
    });

    it('returns empty for Sunday (no schedule)', async () => {
      const slots = await service.getAvailableSlots(practiceId, providerId, SUNDAY, followUpTypeId);
      expect(slots).toEqual([]);
    });
  });

  describe('createAppointment', () => {
    it('creates an appointment with correct fields and status=scheduled', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
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
      await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      await expect(
        service.createAppointment(practiceId, actor, {
          patientId,
          providerId,
          appointmentTypeId: followUpTypeId,
          serviceLineId: eyecareSlId,
          startTime: `${MONDAY}T09:15:00.000Z`,
        }),
      ).rejects.toThrow('conflicts');
    });

    it('allows adjacent appointments (no overlap)', async () => {
      await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`, // 9:00-9:45
      });

      const appt = await service.createAppointment(practiceId, actor, {
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
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const cancelled = await service.cancelAppointment(practiceId, appt.id, 'Patient requested', actor);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancelled_reason).toBe('Patient requested');
      expect(cancelled.cancelled_at).not.toBeNull();
    });

    it('rejects cancelling already cancelled appointment', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });
      await service.cancelAppointment(practiceId, appt.id, 'Test', actor);

      await expect(
        service.cancelAppointment(practiceId, appt.id, 'Again', actor),
      ).rejects.toThrow('already cancelled');
    });

    it('frees the slot after cancellation', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      await service.cancelAppointment(practiceId, appt.id, 'Changed mind', actor);

      const slots = await service.getAvailableSlots(practiceId, providerId, MONDAY, followUpTypeId);
      expect(slots.some((s) => s.startTime.endsWith('T09:00:00.000Z'))).toBe(true);
    });
  });

  describe('transitionStatus', () => {
    it('follows valid chain: scheduled → confirmed → checked_in → in_progress → completed', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const confirmed = await service.transitionStatus(practiceId, appt.id, 'confirmed', actor);
      expect(confirmed.status).toBe('confirmed');

      const checkedIn = await service.transitionStatus(practiceId, appt.id, 'checked_in', actor);
      expect(checkedIn.status).toBe('checked_in');
      expect(checkedIn.checked_in_at).not.toBeNull();

      const inProgress = await service.transitionStatus(practiceId, appt.id, 'in_progress', actor);
      expect(inProgress.status).toBe('in_progress');

      const completed = await service.transitionStatus(practiceId, appt.id, 'completed', actor);
      expect(completed.status).toBe('completed');
    });

    it('rejects invalid transitions', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      await expect(service.transitionStatus(practiceId, appt.id, 'completed', actor)).rejects.toThrow('Cannot transition');
      await expect(service.transitionStatus(practiceId, appt.id, 'in_progress', actor)).rejects.toThrow('Cannot transition');
    });

    it('allows no_show from scheduled', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const noShow = await service.transitionStatus(practiceId, appt.id, 'no_show', actor);
      expect(noShow.status).toBe('no_show');
    });
  });

  describe('updateAppointment', () => {
    it('reschedules an appointment to a new time', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const updated = await service.updateAppointment(practiceId, appt.id, {
        startTime: `${MONDAY}T14:00:00.000Z`,
      }, actor);

      expect(new Date(updated.start_time).toISOString()).toContain('14:00');
    });

    it('rejects rescheduling to a conflicting time', async () => {
      const appt1 = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });
      await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T14:00:00.000Z`,
      });

      await expect(
        service.updateAppointment(practiceId, appt1.id, {
          startTime: `${MONDAY}T14:00:00.000Z`,
        }, actor),
      ).rejects.toThrow('conflicts');
    });

    it('rejects updating cancelled appointment', async () => {
      const appt = await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });
      await service.cancelAppointment(practiceId, appt.id, 'Test', actor);

      await expect(
        service.updateAppointment(practiceId, appt.id, { notes: 'update' }, actor),
      ).rejects.toThrow('Cannot update cancelled');
    });
  });

  describe('getScheduleGrid', () => {
    it('returns time slots with appointments mapped', async () => {
      await service.createAppointment(practiceId, actor, {
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });

      const grid = await service.getScheduleGrid(practiceId, providerId, MONDAY);
      expect(grid.slots.length).toBeGreaterThan(0);
      expect(grid.workingHours).toHaveLength(2);

      const nineAm = grid.slots.find((s) => s.time.endsWith('T09:00:00.000Z'));
      expect(nineAm?.appointment).not.toBeNull();
      expect(nineAm?.appointment?.patient_id).toBe(patientId);

      const eightAm = grid.slots.find((s) => s.time.endsWith('T08:00:00.000Z'));
      expect(eightAm?.appointment).toBeNull();
    });
  });

  describe('domain events', () => {
    it('emits appointment.scheduled on create + appointment.status_changed on status transition', async () => {
      const { createAuditHandler } = await import(
        '../../../../src/server/events/handlers/audit.handler.js'
      );
      const bus = new InProcessEventBus();
      bus.on('*', createAuditHandler(pool));
      const svc = new ScheduleService(pool, bus);

      const appt = await svc.createAppointment(practiceId, actor, {
        patientId, providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T09:00:00.000Z`,
      });
      await svc.transitionStatus(practiceId, appt.id, 'confirmed', actor);

      const events = await pool.query(
        `SELECT metadata, previous_state, new_state FROM audit_events
         WHERE entity_type = 'appointment' AND entity_id = $1
         ORDER BY created_at ASC`,
        [appt.id],
      );
      expect(events.rows).toHaveLength(2);
      expect(events.rows[0].metadata.eventType).toBe('appointment.scheduled');
      expect(events.rows[0].new_state.status).toBe('scheduled');
      expect(events.rows[1].metadata.eventType).toBe('appointment.status_changed');
      expect(events.rows[1].previous_state.status).toBe('scheduled');
      expect(events.rows[1].new_state.status).toBe('confirmed');
    });

    it('emits appointment.cancelled with the reason in payload', async () => {
      const { createAuditHandler } = await import(
        '../../../../src/server/events/handlers/audit.handler.js'
      );
      const bus = new InProcessEventBus();
      bus.on('*', createAuditHandler(pool));
      const svc = new ScheduleService(pool, bus);

      const appt = await svc.createAppointment(practiceId, actor, {
        patientId, providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T10:00:00.000Z`,
      });
      await svc.cancelAppointment(practiceId, appt.id, 'Patient rescheduled', actor);

      const events = await pool.query(
        `SELECT metadata FROM audit_events
         WHERE entity_id = $1 AND metadata->>'eventType' = 'appointment.cancelled'`,
        [appt.id],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].metadata.payload.reason).toBe('Patient rescheduled');
    });
  });
});
