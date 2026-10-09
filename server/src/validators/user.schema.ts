import { z } from 'zod';

const username = z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, numbers, _, ., -')
  // og_ is reserved for accounts provisioned by Obligate.
  .refine((u) => !u.toLowerCase().startsWith('og_'), 'The og_ prefix is reserved for SSO accounts');

export const createUserSchema = z.object({
  username,
  password: z.string().min(12).max(128),
  displayName: z.string().max(128).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  role: z.enum(['admin', 'user']).optional(),
  kind: z.enum(['staff', 'client']).optional(),
}).refine((d) => !(d.kind === 'client' && d.role === 'admin'), {
  message: 'A client account cannot be an administrator', path: ['role'],
});

export const updateUserSchema = z.object({
  username: username.optional(),
  displayName: z.string().max(128).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  role: z.enum(['admin', 'user']).optional(),
  isActive: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  password: z.string().min(12).max(128),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
