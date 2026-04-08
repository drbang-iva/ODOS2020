import { z } from 'zod';

// --- PRACTICE SETTINGS ---

export const updatePracticeSchema = z.object({
  name: z.string().min(1).optional(),
  scheduleBlockMinutes: z.number().int().refine((v) => [10, 15, 20, 30].includes(v), {
    message: 'Must be 10, 15, 20, or 30',
  }).optional(),
  timezone: z.string().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
});

export type UpdatePracticeInput = z.infer<typeof updatePracticeSchema>;

// --- SERVICE LINES ---

export const createServiceLineSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
  sortOrder: z.number().int().default(0),
});

export const updateServiceLineSchema = createServiceLineSchema.partial();

export type CreateServiceLineInput = z.infer<typeof createServiceLineSchema>;
export type UpdateServiceLineInput = z.infer<typeof updateServiceLineSchema>;

// --- USER ADMIN ---

export const updateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
  isProvider: z.boolean().optional(),
  serviceLineIds: z.array(z.string().uuid()).optional(),
});

export const assignRoleSchema = z.object({
  roleId: z.string().uuid(),
  serviceLineId: z.string().uuid().optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

// --- ROLES ---

export const createRoleSchema = z.object({
  name: z.string().min(1),
  permissionSet: z.array(z.string()).default([]),
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  permissionSet: z.array(z.string()).optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
