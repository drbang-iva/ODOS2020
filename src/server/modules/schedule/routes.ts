import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { ScheduleService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { ActorContext } from '../../events/builder.js';
import {
  getAvailableSlotsSchema,
  getScheduleGridSchema,
  createAppointmentSchema,
  updateAppointmentSchema,
  cancelAppointmentSchema,
  statusTransitionSchema,
  listPatientAppointmentsSchema,
} from './schemas.js';

function actorFrom(auth: AuthContext): ActorContext {
  return {
    userId: auth.userId,
    practiceId: auth.practiceId,
    actorType: auth.actorType,
  };
}

export function createScheduleRoutes(scheduleService: ScheduleService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /slots?providerId=&date=&appointmentTypeId=
  routes.get('/slots', zValidator('query', getAvailableSlotsSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:read')) {
      return c.json({ error: 'appointments:read permission required' }, 403);
    }
    const { providerId, date, appointmentTypeId } = c.req.valid('query');
    try {
      const slots = await scheduleService.getAvailableSlots(
        auth.practiceId,
        providerId,
        date,
        appointmentTypeId,
      );
      return c.json({ slots });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('not found')) return c.json({ error: message }, 404);
      throw err;
    }
  });

  // GET /grid?providerId=&date=
  routes.get('/grid', zValidator('query', getScheduleGridSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:read')) {
      return c.json({ error: 'appointments:read permission required' }, 403);
    }
    const { providerId, date } = c.req.valid('query');
    try {
      const grid = await scheduleService.getScheduleGrid(auth.practiceId, providerId, date);
      return c.json(grid);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('not found')) return c.json({ error: message }, 404);
      throw err;
    }
  });

  // GET /patients/:patientId/appointments — full appointment history with filters
  routes.get(
    '/patients/:patientId/appointments',
    zValidator('query', listPatientAppointmentsSchema),
    async (c) => {
      const auth = c.get('auth');
      if (!auth.permissions.includes('appointments:read')) {
        return c.json({ error: 'appointments:read permission required' }, 403);
      }
      const result = await scheduleService.listAppointmentsForPatient(
        auth.practiceId,
        c.req.param('patientId'),
        c.req.valid('query'),
      );
      return c.json(result);
    },
  );

  // GET /patients/:patientId/next-appointment — single upcoming appointment or null
  routes.get('/patients/:patientId/next-appointment', async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:read')) {
      return c.json({ error: 'appointments:read permission required' }, 403);
    }
    const appt = await scheduleService.getNextAppointmentForPatient(
      auth.practiceId,
      c.req.param('patientId'),
    );
    return c.json({ appointment: appt });
  });

  // POST /appointments
  routes.post('/appointments', zValidator('json', createAppointmentSchema), async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:write')) {
      return c.json({ error: 'appointments:write permission required' }, 403);
    }
    const input = c.req.valid('json');
    try {
      const appt = await scheduleService.createAppointment(auth.practiceId, actorFrom(auth), input);
      return c.json(appt, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('conflicts')) return c.json({ error: message }, 409);
      if (message.includes('not found')) return c.json({ error: message }, 404);
      throw err;
    }
  });

  // GET /appointments/:id
  routes.get('/appointments/:id', async (c) => {
    const auth = c.get('auth');
    if (!auth.permissions.includes('appointments:read')) {
      return c.json({ error: 'appointments:read permission required' }, 403);
    }
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
      const appt = await scheduleService.updateAppointment(auth.practiceId, c.req.param('id'), input, actorFrom(auth));
      return c.json(appt);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('conflicts')) return c.json({ error: message }, 409);
      if (message.includes('not found')) return c.json({ error: message }, 404);
      if (message.includes('Cannot update')) return c.json({ error: message }, 400);
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
      const appt = await scheduleService.cancelAppointment(auth.practiceId, c.req.param('id'), reason, actorFrom(auth));
      return c.json(appt);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('not found')) return c.json({ error: message }, 404);
      if (message.includes('already cancelled') || message.includes('Cannot cancel')) {
        return c.json({ error: message }, 400);
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
      const appt = await scheduleService.transitionStatus(auth.practiceId, c.req.param('id'), status, actorFrom(auth));
      return c.json(appt);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('not found')) return c.json({ error: message }, 404);
      if (message.includes('Cannot transition')) return c.json({ error: message }, 400);
      throw err;
    }
  });

  return routes;
}
