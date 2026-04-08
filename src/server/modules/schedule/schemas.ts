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

export const listPatientAppointmentsSchema = z.object({
  status: z
    .enum(['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'])
    .optional(),
  providerId: z.string().uuid().optional(),
  /** Filter: only appointments on or after this date (YYYY-MM-DD) */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Filter: only appointments on or before this date (YYYY-MM-DD) */
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 'upcoming' = only future (not including today); 'past' = only before today; omitted = all */
  window: z.enum(['upcoming', 'past']).optional(),
  /** Default excludes cancelled appointments. Set to true to include them. */
  includeCancelled: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type GetAvailableSlotsInput = z.infer<typeof getAvailableSlotsSchema>;
export type GetScheduleGridInput = z.infer<typeof getScheduleGridSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;
export type StatusTransitionInput = z.infer<typeof statusTransitionSchema>;
export type ListPatientAppointmentsInput = z.infer<typeof listPatientAppointmentsSchema>;
