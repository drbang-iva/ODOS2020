import { z } from 'zod';

// --- EQUIPMENT ---

const deviceCategory = z.enum([
  'oct',
  'visual_field',
  'autorefractor',
  'phoropter',
  'tonometer',
  'retinal_camera',
  'topographer',
  'lensometer',
  'meibographer',
  'specialty',
  'aesthetics',
]);

const integrationType = z.enum(['dicom', 'folder_watch', 'serial', 'manual']);

export const createEquipmentSchema = z.object({
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  model: z.string().min(1),
  deviceCategory,
  integrationType,
  connectionConfig: z.record(z.unknown()).default({}),
  location: z.string().optional(),
  dataTypes: z.array(z.string()).default([]),
  parserId: z.string().optional(),
});

export const updateEquipmentSchema = createEquipmentSchema.partial();

export const listEquipmentSchema = z.object({
  deviceCategory: deviceCategory.optional(),
  integrationType: integrationType.optional(),
  includeInactive: z.coerce.boolean().default(false),
});

export type CreateEquipmentInput = z.infer<typeof createEquipmentSchema>;
export type UpdateEquipmentInput = z.infer<typeof updateEquipmentSchema>;
export type ListEquipmentInput = z.infer<typeof listEquipmentSchema>;

// --- DEVICE READINGS ---

export const listReadingsSchema = z.object({
  patientId: z.string().uuid().optional(),
  equipmentId: z.string().uuid().optional(),
  readingType: z.string().optional(),
  needsReview: z.coerce.boolean().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createReadingSchema = z.object({
  equipmentId: z.string().uuid(),
  patientId: z.string().uuid().optional(),
  matchedBy: z.enum(['mwl', 'room_assignment', 'manual', 'ai_match']).optional(),
  readingType: z.string().min(1),
  structuredData: z.record(z.unknown()).default({}),
  rawDataRef: z.string().optional(),
  sourceType: z.enum(['dicom', 'folder_watch', 'serial', 'manual', 'ai_extraction']),
  confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().default(false),
  capturedAt: z.string().datetime(),
});

export const reviewReadingSchema = z.object({
  patientId: z.string().uuid().optional(),
  structuredData: z.record(z.unknown()).optional(),
});

export type ListReadingsInput = z.infer<typeof listReadingsSchema>;
export type CreateReadingInput = z.infer<typeof createReadingSchema>;
export type ReviewReadingInput = z.infer<typeof reviewReadingSchema>;
