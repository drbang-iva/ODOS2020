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
