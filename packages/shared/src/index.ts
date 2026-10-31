// Schemas shared by the API and the web app. One definition, one source of truth.
import { z } from 'zod';

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['up', 'down']),
  githubConfigured: z.boolean(),
});
export type Health = z.infer<typeof HealthSchema>;

export const MeSchema = z.object({
  id: z.string().uuid(),
  githubLogin: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  emails: z.array(z.object({ email: z.string(), verified: z.boolean(), primary: z.boolean() })),
  github: z.object({
    installationId: z.number().int().nullable(),
    installUrl: z.string().url().nullable(),
  }),
});
export type Me = z.infer<typeof MeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
