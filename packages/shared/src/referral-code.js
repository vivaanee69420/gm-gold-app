// Referral codes (FR-07): the referrer's first name plus a short random suffix, stored
// WITHOUT separators. Display inserts one hyphen before the suffix: SARAH-7K2X.
//
// The name is there because the code is said out loud and typed by a friend — "use
// SARAH-7K2X" is rememberable in a way "GMRF-7K2X" is not, and it tells the friend whose
// code they are entering before they commit to it.
//
// A code is FROZEN once issued. Only pickRole (userService.js) ever inserts one, and
// saveProfile never touches it, so a referrer who later edits their first name keeps the
// original code — which is the point: cards, QR codes and texts already shared keep working.
// The name in a code is a snapshot of when it was issued, not a live view of the profile.

// Unambiguous: no 0/O, no 1/I/L. Used for the random SUFFIX only. It cannot apply to the whole
// code any more, because names contain exactly the letters it excludes (OLIVIA has all three).
// The suffix is where a misread actually happens — a name is self-correcting, "7K2X" is not.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Random characters after the name. 4 from a 31-char alphabet is ~920k suffixes per name. */
export const SUFFIX_LENGTH = 4;

/** Longest name fragment kept. CHRISTOPHER -> CHRISTO, so the gold card's serial still fits. */
export const NAME_MAX_LENGTH = 8;

/** Length of a code issued to a referrer with no usable first name (see generateCode). */
export const CODE_LENGTH = 8;

// Deliberately looser than the old `exactly 8 chars of CODE_ALPHABET`: a name may contain any
// letter, and its length varies. This checks the SHAPE only — whether a code exists is the
// API's answer (invalid_code, 404), which is the sole authority either way.
const CODE_MIN_LENGTH = 1 + SUFFIX_LENGTH;
const CODE_MAX_LENGTH = NAME_MAX_LENGTH + SUFFIX_LENGTH;
const CODE_RE = new RegExp(`^[A-Z0-9]{${CODE_MIN_LENGTH},${CODE_MAX_LENGTH}}$`);

/** Strip separators/lowercase typed by humans -> canonical form, or null if the shape is wrong. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(s) ? s : null;
}

/** "SARAH7K2X" -> "SARAH-7K2X" for display only. Old 8-char codes still split correctly. */
export function formatCode(canonical) {
  if (typeof canonical !== 'string' || canonical.length <= SUFFIX_LENGTH) return canonical ?? '';
  const split = canonical.length - SUFFIX_LENGTH;
  return `${canonical.slice(0, split)}-${canonical.slice(split)}`;
}

/** A-Z only, uppercased, truncated. Returns '' when nothing usable survives. */
function nameFragment(firstName) {
  if (typeof firstName !== 'string') return '';
  return firstName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, NAME_MAX_LENGTH);
}

function randomFrom(alphabet, length, rng) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

/**
 * Generate a canonical code for a referrer.
 *
 * Falls back to an all-random code when the first name yields nothing usable — an empty
 * profile, or a name in a script that leaves no A-Z behind. That is a working code rather
 * than a failure, because the alternative is refusing someone a referral code over the
 * spelling of their name.
 *
 * @param firstName the referrer's first name; anything unusable is ignored
 * @param rng pass a deterministic generator in tests
 */
export function generateCode(firstName = '', { rng = Math.random } = {}) {
  const name = nameFragment(firstName);
  if (!name) return randomFrom(CODE_ALPHABET, CODE_LENGTH, rng);
  return `${name}${randomFrom(CODE_ALPHABET, SUFFIX_LENGTH, rng)}`;
}
