// Referral codes (FR-07): canonical form is 8 chars from an unambiguous alphabet,
// stored WITHOUT separators. Display groups as XXXX-XXXX; the hyphen never persists.

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_LENGTH = 8;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Strip separators/lowercase typed by humans -> canonical form, or null if invalid. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(s) ? s : null;
}

/** "GMRF7K2X" -> "GMRF-7K2X" for display only. */
export function formatCode(canonical) {
  if (typeof canonical !== 'string' || canonical.length !== CODE_LENGTH) return canonical ?? '';
  return `${canonical.slice(0, 4)}-${canonical.slice(4)}`;
}

/** Generate a canonical code. Pass a custom rng for deterministic tests. */
export function generateCode(rng = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return out;
}
