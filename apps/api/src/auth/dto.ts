import { z } from 'zod';

/**
 * Request shapes, validated at the boundary so no handler receives an unknown
 * shape. Zod rather than class-validator: the same schemas can be shared with
 * the Next.js client for identical client-side messages, which class-validator
 * decorators cannot do.
 */

// Reserved words that would collide with routes or impersonate the platform.
const RESERVED = new Set([
  'admin', 'snapx', 'support', 'help', 'api', 'root', 'system',
  'me', 'settings', 'login', 'signup', 'official', 'staff',
]);

export const usernameSchema = z.string()
  .trim().toLowerCase()
  .min(3, 'Usernames need at least 3 characters')
  .max(24, 'Usernames can be at most 24 characters')
  .regex(/^[a-z0-9_.]+$/, 'Use letters, numbers, underscore and full stop only')
  .refine(v => !RESERVED.has(v), 'That username is reserved')
  .refine(v => !/^[._]|[._]$/.test(v), 'Cannot start or end with . or _');

/* Length over composition rules. Forcing a symbol and a digit reliably produces
   "Password1!" — measurably weaker than a long passphrase. */
export const passwordSchema = z.string()
  .min(10, 'Use at least 10 characters — a short phrase works well')
  .max(200, 'That is longer than we can hash safely');

export const registerSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1, 'What should we call you?').max(40),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(320).optional(),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +923001234567').optional(),
  password: passwordSchema,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
}).refine(v => v.email || v.phone, {
  message: 'Enter an email address or a phone number',
  path: ['email'],
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your username, email or phone'),
  password: z.string().min(1, 'Enter your password'),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;

/* ---- password reset (spec §5) ---- */

export const resetRequestSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your username, email or phone'),
});

export const resetVerifySchema = z.object({
  identifier: z.string().trim().min(1),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const resetCompleteSchema = z.object({
  identifier: z.string().trim().min(1),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  password: passwordSchema,
});

export type ResetRequestDto = z.infer<typeof resetRequestSchema>;
export type ResetVerifyDto = z.infer<typeof resetVerifySchema>;
export type ResetCompleteDto = z.infer<typeof resetCompleteSchema>;
