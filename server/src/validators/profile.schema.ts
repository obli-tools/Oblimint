import { z } from 'zod';

const userPreferencesSchema = z.object({
  toastEnabled:    z.boolean().optional(),
  toastPosition:   z.enum(['top-center', 'bottom-right']).optional(),
  sidebarFloating: z.boolean().optional(),
  // Keep in sync with AppTheme (shared/src/types.ts).
  preferredTheme:  z.enum(['obli-operator', 'obli-daylight', 'obli-dim', 'modern', 'neon']).optional(),
  anonymousMode:   z.boolean().optional(),
}).passthrough().nullable().optional();

export const updateProfileSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  preferences: userPreferencesSchema,
  email: z.string().email().max(255).nullable().optional(),
  preferredLanguage: z.string().max(10).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(128),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
