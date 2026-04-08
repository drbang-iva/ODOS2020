import { z } from 'zod';

// --- TREATMENT LIBRARY ---

export const createLibraryItemSchema = z.object({
  standardName: z.string().min(1),
  category: z.string().min(1),
  subcategory: z.string().optional(),
  typicalDurationMinutes: z.number().int().positive(),
  cptCodes: z.array(z.string()).default([]),
  equipmentTags: z.array(z.string()).default([]),
  providerScope: z.array(z.string()).default([]),
  serviceLines: z.array(z.string()).default([]),
  bodyAreaModifiersAvailable: z.boolean().default(false),
  consentRequired: z.boolean().default(false),
  isBillable: z.boolean().default(true),
  defaultColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
});

export const updateLibraryItemSchema = createLibraryItemSchema.partial();

export const bulkLibraryItemsSchema = z.object({
  items: z.array(createLibraryItemSchema).min(1).max(1000),
});

export type CreateLibraryItemInput = z.infer<typeof createLibraryItemSchema>;
export type UpdateLibraryItemInput = z.infer<typeof updateLibraryItemSchema>;
export type BulkLibraryItemsInput = z.infer<typeof bulkLibraryItemsSchema>;

// --- BODY AREA MODIFIERS ---

export const createBodyAreaSchema = z.object({
  name: z.string().min(1),
  shortCode: z.string().min(1).max(10),
  durationAdjustmentMinutes: z.number().int().default(0),
  additionalEquipmentTags: z.array(z.string()).default([]),
  additionalConsent: z.boolean().default(false),
});

export const updateBodyAreaSchema = createBodyAreaSchema.partial();

export type CreateBodyAreaInput = z.infer<typeof createBodyAreaSchema>;
export type UpdateBodyAreaInput = z.infer<typeof updateBodyAreaSchema>;

// --- APPOINTMENT TYPES ---

export const createAppointmentTypeSchema = z.object({
  serviceLineId: z.string().uuid(),
  name: z.string().min(1),
  shortName: z.string().min(1),
  displayName: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
  durationBlocks: z.number().int().positive(),
  defaultReason: z.string().optional(),
  sortOrder: z.number().int().default(0),
  libraryId: z.string().uuid().optional(),
  serviceLineIds: z.array(z.string().uuid()).default([]),
  bodyAreaModifierIds: z.array(z.string().uuid()).default([]),
  equipmentTags: z.array(z.string()).default([]),
  providerScope: z.array(z.string()).default([]),
  isCustom: z.boolean().default(false),
  priceCents: z.number().int().nonnegative().optional(),
  cptCodes: z.array(z.string()).default([]),
  requiresConsultation: z.boolean().default(false),
  seriesEnabled: z.boolean().default(false),
  seriesCount: z.number().int().positive().optional(),
  onlineBookable: z.boolean().default(false),
  photoRequired: z.boolean().default(false),
});

export const updateAppointmentTypeSchema = createAppointmentTypeSchema.partial().omit({ serviceLineId: true });

export const cloneFromLibrarySchema = z.object({
  libraryId: z.string().uuid(),
  serviceLineId: z.string().uuid(),
  displayName: z.string().optional(), // override library standard_name
  shortName: z.string().min(1),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  durationBlocks: z.number().int().positive(),
  bodyAreaModifierIds: z.array(z.string().uuid()).default([]),
  priceCents: z.number().int().nonnegative().optional(),
});

export type CreateAppointmentTypeInput = z.infer<typeof createAppointmentTypeSchema>;
export type UpdateAppointmentTypeInput = z.infer<typeof updateAppointmentTypeSchema>;
export type CloneFromLibraryInput = z.infer<typeof cloneFromLibrarySchema>;
