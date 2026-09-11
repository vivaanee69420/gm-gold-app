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
  'treatment_started',
  'treatment_completed',
  'lost',
];

// A referral is created at 'new' the moment the friend submits the form — which happens when
// they pick a practice, BEFORE they have booked anything. Dentally is the authority on whether
// an appointment exists, so a referral waits at 'new', off the pipeline board, until the sync
// (dentally/syncService.js processBookedPage) matches it and moves it to 'booked'. That is the
// point it becomes real work for a practice, and it is where it joins the board.
//
// 'contacted' sits behind 'booked' on the ladder, so nothing can ever be in it once leads enter
// at 'booked'. It stays in REFERRAL_STATUSES because the API's transition rules and every
// historical row still reference it — it is simply not a column any more.
//
// The cost of this, worth knowing: processBookedPage matches on EXACT phone equality or
// lowercased email. A friend who books with a different number than they gave, or whose phone
// was mistyped, never matches and so never reaches the board. They are not lost — they are
// listed under "Waiting on booking" on Operations, which exists precisely so that population
// is visible rather than silently dropped.
export const PRE_BOARD_STATUSES = ['new', 'contacted'];

/** The stages the pipeline board draws as columns. */
export const BOARD_STAGES = REFERRAL_STATUSES.filter((s) => !PRE_BOARD_STATUSES.includes(s));

/** True for a referral still waiting on Dentally to confirm an appointment. */
export const isWaitingOnBooking = (status) => PRE_BOARD_STATUSES.includes(status);

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

// Phone is captured here, not at sign-in: Supabase Auth owns identity by EMAIL now, but
// phone is still the key that matches a patient to their Dentally record (FR-05), so every
// account has to provide one before the referrer role means anything.
export const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  phone: phoneSchema,
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

// ---- admin accounts (email + password, two roles: admin | manager) ----
// The 256-character ceiling is a cost bound, not a policy: passwords are hashed with scrypt,
// whose work scales with the input, so an unbounded field lets one request burn arbitrary CPU
// on an unauthenticated route.
export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(256),
});

export const adminPasswordSchema = z.string().min(10).max(256);

export const adminCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: adminPasswordSchema,
  role: z.enum(['admin', 'manager']),
  practiceId: z.string().uuid().optional(),
});

// The screens an owner can hand to a manager, one key per dashboard page. An admin is never
// filtered by this list — they own every screen. Managers are, and the API enforces it on the
// routes behind each page (ROUTE_PAGE in apps/api/src/middleware/auth.js), so revoking a tab
// closes the data behind it too, not just the link to it.
export const MANAGER_PAGES = ['pipeline', 'patients', 'payouts'];

export const managerPagesSchema = z.array(z.enum(MANAGER_PAGES)).max(MANAGER_PAGES.length);

// The person behind a team login. Both fields clear with an empty string, and neither is
// identity — email is, and it is not editable from the team screen.
export const adminProfileSchema = z.object({
  name: z.string().trim().max(80).transform((v) => (v === '' ? null : v)),
  phone: z.string().trim().max(32).transform((v) => (v === '' ? null : v)),
});

// A note the desk leaves on a referral. Trimmed, because a note of three spaces is a note
// nobody meant to leave.
export const referralNoteSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

// What was agreed, filled in as the practice learns it. Every field clears with an empty
// value — that is how you take back a wrong entry, so none of them may fail validation here.
// The requirement is enforced at the move that pays (updateStatus), not at the keystroke.
// What a referrer can be paid, in pennies. The practice manager picks one per referral
// (2026-09-11, replacing FR-15's reward rules) because different treatments are worth wildly
// different amounts and a single rule could not express it.
//
// Enforced HERE rather than as a database CHECK: this list is a business decision that will
// change, and a constraint would make each change a migration. The database's floor is only
// `commission_pennies > 0`.
export const COMMISSION_TIERS_PENNIES = [2000, 5000, 10000, 20000, 25000];

export const treatmentDetailsSchema = z.object({
  treatmentName: z.string().trim().max(120).transform((v) => (v === '' ? null : v)),
  doctorName: z.string().trim().max(120).transform((v) => (v === '' ? null : v)),
  // Pennies, like every other amount in this codebase — never pounds as a float.
  // NOTE this is the value of the TREATMENT, not the commission. They are different numbers
  // and confusing them pays a referrer the price of a veneer case.
  treatmentValuePennies: z
    .union([z.number().int().min(0).max(100_000_000), z.null()])
    .default(null),
  // The commission itself. Only the tiers above, so a typo cannot invent a payout.
  commissionPennies: z
    .union([z.number().int(), z.null()])
    .default(null)
    .refine((v) => v === null || COMMISSION_TIERS_PENNIES.includes(v), {
      message: 'commission_not_a_tier',
    }),
});

/** The four facts a commission credit needs. Missing any of them blocks the paying move. */
export function missingTreatmentDetails(referral) {
  const missing = [];
  if (!referral?.treatment_name) missing.push('treatment');
  if (!referral?.doctor_name) missing.push('dentist');
  if (referral?.treatment_value_pennies === null || referral?.treatment_value_pennies === undefined) {
    missing.push('value');
  }
  // Without this there is no amount to pay: commission no longer falls back to a rule, so an
  // unpriced referral must not reach either crediting stage.
  if (referral?.commission_pennies === null || referral?.commission_pennies === undefined) {
    missing.push('commission');
  }
  return missing;
}
