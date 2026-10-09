import type { z } from 'zod';
import { AppError } from '../../middleware/errorHandler';

/**
 * Parses a request body inside a handler, AFTER the access check (an
 * invisible object is a 404 whatever the body). 400 with the same message
 * shape as middleware/validate.
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.errors.map((e) => `${e.path.length ? e.path.join('.') : '<root>'}: ${e.message}`);
    throw new AppError(400, `Validation failed — ${issues.join('; ')}`, 'validation', r.error.flatten().fieldErrors);
  }
  return r.data as z.infer<S>;
}
