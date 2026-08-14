// Money is ALWAYS integer pennies (NFR-06). No floats anywhere near a wallet.

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function assertPennies(value, label = 'amount') {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of pennies, got ${value}`);
  }
  return value;
}

/** 6000 -> "£60.00" */
export function formatPennies(pennies) {
  assertPennies(pennies);
  return gbp.format(pennies / 100);
}

/** Sum with integer guarantees. */
export function addPennies(...amounts) {
  return amounts.reduce((total, a) => total + assertPennies(a), 0);
}

/** "20" | "20.50" | "£20.50" -> 2050, or null for anything lossy/invalid. */
export function parseGBPToPennies(input) {
  if (typeof input === 'number') {
    const p = Math.round(input * 100);
    return Number.isSafeInteger(p) && Math.abs(input * 100 - p) < 1e-6 ? p : null;
  }
  if (typeof input !== 'string') return null;
  const m = input.replace(/[£,\s]/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const pounds = Number(m[1]);
  const pence = Number((m[2] ?? '0').padEnd(2, '0'));
  return pounds * 100 + pence;
}
