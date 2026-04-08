import { z } from 'zod';

// --- FEE SCHEDULES ---

export const createFeeScheduleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().default(false),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const updateFeeScheduleSchema = createFeeScheduleSchema.partial();

export const feeScheduleItemSchema = z.object({
  cptCode: z.string().min(1),
  modifier: z.string().optional(),
  description: z.string().optional(),
  amountCents: z.number().int().nonnegative(),
});

export const updateFeeScheduleItemSchema = feeScheduleItemSchema.partial().omit({ cptCode: true });

export const bulkFeeScheduleItemsSchema = z.object({
  items: z.array(feeScheduleItemSchema).min(1).max(1000),
  /** When true, items whose (cptCode, modifier) already exists are silently skipped
   * instead of causing a conflict. When false (default), duplicates fail the whole batch. */
  skipExisting: z.boolean().default(false),
});

export type CreateFeeScheduleInput = z.infer<typeof createFeeScheduleSchema>;
export type UpdateFeeScheduleInput = z.infer<typeof updateFeeScheduleSchema>;
export type FeeScheduleItemInput = z.infer<typeof feeScheduleItemSchema>;
export type UpdateFeeScheduleItemInput = z.infer<typeof updateFeeScheduleItemSchema>;
export type BulkFeeScheduleItemsInput = z.infer<typeof bulkFeeScheduleItemsSchema>;

// --- CHARGES ---

export const createChargeSchema = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  providerId: z.string().uuid(),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cptCode: z.string().min(1),
  modifier: z.string().optional(),
  icd10Codes: z.array(z.string()).default([]),
  description: z.string().optional(),
  units: z.number().int().positive().default(1),
  unitAmountCents: z.number().int().nonnegative().optional(), // if omitted, look up from default fee schedule
  feeScheduleId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

export const updateChargeSchema = z.object({
  icd10Codes: z.array(z.string()).optional(),
  description: z.string().optional(),
  units: z.number().int().positive().optional(),
  unitAmountCents: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});

export const voidChargeSchema = z.object({
  reason: z.string().min(1),
});

export const listChargesSchema = z.object({
  patientId: z.string().uuid().optional(),
  appointmentId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  status: z.enum(['pending', 'submitted', 'paid', 'denied', 'voided', 'partial']).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateChargeInput = z.infer<typeof createChargeSchema>;
export type UpdateChargeInput = z.infer<typeof updateChargeSchema>;
export type VoidChargeInput = z.infer<typeof voidChargeSchema>;
export type ListChargesInput = z.infer<typeof listChargesSchema>;

// --- PAYMENTS ---

export const paymentApplicationSchema = z.object({
  chargeId: z.string().uuid(),
  amountCents: z.number().int().positive(),
});

export const createPaymentSchema = z.object({
  patientId: z.string().uuid().optional(), // optional for carrier payments
  paymentType: z.enum(['patient', 'carrier']),
  paymentMethod: z.enum(['cash', 'check', 'credit_card', 'debit_card', 'eft', 'ach', 'era', 'other']),
  amountCents: z.number().int().positive(),
  payerName: z.string().optional(), // required for carrier
  referenceNumber: z.string().optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
  applications: z.array(paymentApplicationSchema).default([]),
});

export const applyPaymentSchema = z.object({
  chargeId: z.string().uuid(),
  amountCents: z.number().int().positive(),
});

export const voidPaymentSchema = z.object({
  reason: z.string().min(1),
});

export const listPaymentsSchema = z.object({
  patientId: z.string().uuid().optional(),
  paymentType: z.enum(['patient', 'carrier']).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type ApplyPaymentInput = z.infer<typeof applyPaymentSchema>;
export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;
export type ListPaymentsInput = z.infer<typeof listPaymentsSchema>;

// --- ADJUSTMENTS ---

export const createAdjustmentSchema = z.object({
  chargeId: z.string().uuid(),
  adjustmentType: z.enum(['contractual', 'writeoff', 'refund', 'discount', 'sliding_scale', 'courtesy', 'other']),
  amountCents: z.number().int(),
  reason: z.string().min(1),
  notes: z.string().optional(),
});

export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
