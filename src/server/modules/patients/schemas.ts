import { z } from 'zod';

// --- PATIENT ---

export const createPatientSchema = z.object({
  firstName: z.string().min(1),
  middleName: z.string().optional(),
  lastName: z.string().min(1),
  preferredName: z.string().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  sex: z.enum(['M', 'F', 'X']),
  email: z.string().email().optional(),
  phonePrimary: z.string().min(1),
  phoneSecondary: z.string().optional(),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().length(2),
  zip: z.string().min(1),
  ssnEncrypted: z.string().optional(),
  employer: z.string().optional(),
  occupation: z.string().optional(),
  hobbies: z.array(z.string()).default([]),
  referringProvider: z.string().optional(),
  referringProviderNpi: z.string().optional(),
  preferredPharmacy: z.string().optional(),
  preferredPharmacyNpi: z.string().optional(),
  preferredLanguage: z.string().default('en'),
  communicationPref: z.enum(['email', 'phone', 'text', 'mail']).default('phone'),
  race: z.string().optional(),
  ethnicity: z.string().optional(),
});

export const updatePatientSchema = createPatientSchema.partial();

export const searchPatientsSchema = z.object({
  q: z.string().optional(), // free text search
  name: z.string().optional(),
  phone: z.string().optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
export type SearchPatientsInput = z.infer<typeof searchPatientsSchema>;

// --- INSURANCE ---

export const createInsuranceSchema = z.object({
  priority: z.number().int().min(1).max(3),
  planType: z.enum(['medical', 'vision']),
  payerName: z.string().min(1),
  payerId: z.string().optional(),
  memberId: z.string().min(1),
  groupNumber: z.string().optional(),
  subscriberName: z.string().optional(),
  subscriberDob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  subscriberRelationship: z.enum(['self', 'spouse', 'child', 'other']).default('self'),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  copayCents: z.number().int().nonnegative().optional(),
});

export const updateInsuranceSchema = createInsuranceSchema.partial();

export type CreateInsuranceInput = z.infer<typeof createInsuranceSchema>;
export type UpdateInsuranceInput = z.infer<typeof updateInsuranceSchema>;

// --- RESPONSIBLE PARTY ---

export const createResponsiblePartySchema = z.object({
  responsiblePartyPatientId: z.string().uuid().optional(),
  relationship: z.enum(['parent', 'legal_guardian', 'spouse', 'self', 'other']),
  isFinancialResponsible: z.boolean().default(false),
  isConsentAuthority: z.boolean().default(false),
  isInsuranceSubscriber: z.boolean().default(false),
  insuranceSubscriberId: z.string().optional(),
  isPrimary: z.boolean().default(false),
  courtOrderNotes: z.string().optional(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type CreateResponsiblePartyInput = z.infer<typeof createResponsiblePartySchema>;

// --- ALERT ---

export const createAlertSchema = z.object({
  alertType: z.enum(['allergy', 'balance', 'clinical', 'scheduling', 'custom']),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string().min(1),
});

export const resolveAlertSchema = z.object({
  resolved: z.boolean(),
});

export type CreateAlertInput = z.infer<typeof createAlertSchema>;
export type ResolveAlertInput = z.infer<typeof resolveAlertSchema>;
