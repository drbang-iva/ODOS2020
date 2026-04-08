import { z } from 'zod';

export const searchAuditSchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  actorType: z.enum(['human', 'local_agent', 'cloud_agent']).optional(),
  action: z.enum(['create', 'update', 'delete', 'access']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type SearchAuditInput = z.infer<typeof searchAuditSchema>;
