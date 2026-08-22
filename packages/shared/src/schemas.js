// Zod schemas shared by the API (validation boundary) and both front ends (NFR-07).
import { z } from 'zod';
import { normalizePhone } from './phone.js';
import { normalizeCode } from './referral-code.js';

export const TREATMENT_INTERESTS = ['implants', 'aligners', 'veneers', 'bonding', 'not_sure'];

export const REFERRAL_STATUSES = [
  'new',
  'contacted',
  'booked',
  'attended',
  'treatment_agreed',
  'treatment_completed',
  'lost',
];

/** Free-typed phone -> E.164, failing validation when not normalizable. */
export const phoneSchema = z
  .string()
  .transform((v, ctx) => {
    const e164 = normalizePhone(v);
    if (!e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_phone' });
      return z.NEVER;
    }
    return e164;
  });

/** Free-typed referral code -> canonical 8-char form. */
export const referralCodeSchema = z
  .string()
  .transform((v, ctx) => {
    const code = normalizeCode(v);
    if (!code) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_code' });
      return z.NEVER;
    }
    return code;
  });

export const otpSendSchema = z.object({
  phone: phoneSchema,
  channel: z.enum(['whatsapp', 'sms']).optional(),
});

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/, 'invalid_otp'),
});

export const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  notifyOptIn: z.boolean(),
});

export const roleSchema = z.object({
  role: z.enum(['referrer', 'referred']),
});

export const referralSubmitSchema = z.object({
  code: referralCodeSchema,
  fullName: z.string().trim().min(2).max(120),
  // Booking-first flow: contact details instead of an interest question. Email and
  // phone are required in the app's form; optional here so staff entry stays possible.
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().min(5).max(20).optional(),
  treatmentInterest: z.enum(TREATMENT_INTERESTS).default('not_sure'),
  preferredPracticeId: z.string().uuid(),
  consent: z.literal(true),
  consentVersion: z.string().min(1),
});

export const statusUpdateSchema = z.object({
  status: z.enum(REFERRAL_STATUSES),
  lostReason: z.string().trim().min(2).optional(),
});

export const payoutRequestSchema = z.object({
  practiceId: z.string().uuid(),
});
