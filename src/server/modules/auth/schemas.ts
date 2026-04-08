import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  practiceId: z.string().uuid(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  roleIds: z.array(z.string().uuid()).default([]),
  isProvider: z.boolean().default(false),
  serviceLineIds: z.array(z.string().uuid()).default([]),
});

export const createAgentKeySchema = z.object({
  name: z.string().min(1),
  modelType: z.enum(['local', 'cloud']),
  scopes: z.array(z.string()).min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type CreateAgentKeyInput = z.infer<typeof createAgentKeySchema>;
