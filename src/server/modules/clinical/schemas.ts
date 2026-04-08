import { z } from 'zod';

/**
 * Clinical encounter schemas — SHELL ONLY.
 * Exam field structure (HPI, vitals, refraction, slit lamp, IOP, assessment,
 * plan, etc.) is intentionally NOT included yet. Eric will red-pen each
 * section before it lands.
 */

export const createEncounterSchema = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  providerId: z.string().uuid(),
  /** Optional protocol link (Ortho-K fitting, dry eye chain, VT progression, etc.) */
  protocolId: z.string().uuid().optional(),
});

export const listEncountersSchema = z.object({
  patientId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  status: z.enum(['draft', 'signed']).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateEncounterInput = z.infer<typeof createEncounterSchema>;
export type ListEncountersInput = z.infer<typeof listEncountersSchema>;
