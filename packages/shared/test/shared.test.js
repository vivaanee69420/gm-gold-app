import { describe, it, expect } from 'vitest';
import { normalizePhone, isUkMobile, isE164 } from '../src/phone.js';
import {
  normalizeCode, formatCode, generateCode,
  CODE_ALPHABET, CODE_LENGTH, SUFFIX_LENGTH, NAME_MAX_LENGTH,
} from '../src/referral-code.js';
import { formatPennies, addPennies, parseGBPToPennies, assertPennies } from '../src/money.js';
import { referralSubmitSchema, profileSchema, phoneSchema, adminLoginSchema, adminCreateSchema } from '../src/schemas.js';

describe('phone normalization', () => {
  it('normalizes UK domestic formats to E.164', () => {
    expect(normalizePhone('07700 900123')).toBe('+447700900123');
    expect(normalizePhone('07700-900-123')).toBe('+447700900123');
    expect(normalizePhone('0044 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('+44 (0)7700 900123')).toBe('+447700900123');
    expect(normalizePhone('+447700900123')).toBe('+447700900123');
  });
  it('passes through valid international numbers', () => {
    expect(normalizePhone('+33 6 12 34 56 78')).toBe('+33612345678');
  });
  it('rejects garbage', () => {
    expect(normalizePhone('hello')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('+0447700900123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
  it('classifies UK mobiles', () => {
    expect(isUkMobile('+447700900123')).toBe(true);
    expect(isUkMobile('+442071112222')).toBe(false);
    expect(isE164('+447700900123')).toBe(true);
  });
});

describe('referral codes', () => {
  it('normalizes hyphens, spaces, lowercase', () => {
    expect(normalizeCode('sarah-7k2x')).toBe('SARAH7K2X');
    expect(normalizeCode(' SARAH 7K2X ')).toBe('SARAH7K2X');
  });

  it('accepts the range of lengths a name can produce', () => {
    expect(normalizeCode('JO7K2X')).toBe('JO7K2X');              // short name
    expect(normalizeCode('CHRISTO7K2X')).toBe('CHRISTO7K2X');    // truncated long name
    expect(normalizeCode('GMRF7K2X')).toBe('GMRF7K2X');          // an old all-random code
  });

  it('rejects shapes no code can have', () => {
    expect(normalizeCode('7K2X')).toBeNull();                    // suffix with no name
    expect(normalizeCode('CHRISTOPHER7K2X')).toBeNull();         // longer than name+suffix allows
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode(null)).toBeNull();
  });

  it('no longer rejects the ambiguous letters, because names contain them', () => {
    // OLIVIA alone has O, L and I — the three the suffix alphabet excludes. The shape check
    // cannot police them any more; whether a code EXISTS is the API's answer (404), and that
    // was always the only real authority.
    expect(normalizeCode('OLIVIA7K2X')).toBe('OLIVIA7K2X');
  });

  it('formats for display, old codes included', () => {
    expect(formatCode('SARAH7K2X')).toBe('SARAH-7K2X');
    expect(formatCode('GMRF7K2X')).toBe('GMRF-7K2X');
    expect(formatCode('JO7K2X')).toBe('JO-7K2X');
    // Nothing sensible to split: return it rather than inventing a hyphen.
    expect(formatCode('7K2X')).toBe('7K2X');
    expect(formatCode(null)).toBe('');
  });

  it('builds a code from the first name plus a random suffix', () => {
    const code = generateCode('Sarah');
    expect(code.startsWith('SARAH')).toBe(true);
    expect(code).toHaveLength('SARAH'.length + SUFFIX_LENGTH);
    expect(normalizeCode(code)).toBe(code);
    // Only the suffix has to come from the unambiguous alphabet.
    for (const ch of code.slice(-SUFFIX_LENGTH)) expect(CODE_ALPHABET.includes(ch)).toBe(true);
  });

  it('truncates a long name so the code still fits a gold card', () => {
    const code = generateCode('Christopher');
    expect(code.startsWith('CHRISTO')).toBe(true);
    expect(code.length).toBeLessThanOrEqual(NAME_MAX_LENGTH + SUFFIX_LENGTH);
  });

  it('strips anything that is not a letter out of the name', () => {
    expect(generateCode("O'Brien").startsWith('OBRIEN')).toBe(true);
    expect(generateCode('Anne-Marie').startsWith('ANNEMARI')).toBe(true); // and truncated at 8
    expect(generateCode('José').startsWith('JOS')).toBe(true);            // accent dropped
  });

  it('falls back to an all-random code when no letters survive', () => {
    // An empty profile, or a name in a script leaving no A-Z. A working code beats refusing
    // someone a referral code over the spelling of their name.
    for (const name of ['', '  ', '123', '???', undefined]) {
      const code = generateCode(name);
      expect(normalizeCode(code)).toBe(code);
      expect(code).toHaveLength(CODE_LENGTH);
      for (const ch of code) expect(CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });

  it('varies the suffix so two people with the same name differ', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(generateCode('Sarah'));
    expect(seen.size).toBeGreaterThan(150); // collisions are handled by a retry, not by luck
  });

  it('takes a deterministic rng for tests', () => {
    expect(generateCode('Sarah', { rng: () => 0 })).toBe(`SARAH${CODE_ALPHABET[0].repeat(SUFFIX_LENGTH)}`);
  });

  it('round-trips every generated code through normalize', () => {
    for (const name of ['Sarah', 'Jo', 'Christopher', 'Olivia', '']) {
      for (let i = 0; i < 50; i += 1) {
        const code = generateCode(name);
        expect(normalizeCode(code), `${name} -> ${code}`).toBe(code);
      }
    }
  });
});

describe('money', () => {
  it('formats pennies as GBP', () => {
    expect(formatPennies(6000)).toBe('£60.00');
    expect(formatPennies(2050)).toBe('£20.50');
    expect(formatPennies(0)).toBe('£0.00');
  });
  it('adds with integer guarantees', () => {
    expect(addPennies(2000, 2000, 500)).toBe(4500);
    expect(() => addPennies(20.5)).toThrow(TypeError);
  });
  it('parses typed amounts', () => {
    expect(parseGBPToPennies('20')).toBe(2000);
    expect(parseGBPToPennies('£20.50')).toBe(2050);
    expect(parseGBPToPennies('20.5')).toBe(2050);
    expect(parseGBPToPennies('nope')).toBeNull();
  });
  it('rejects float pennies', () => {
    expect(() => assertPennies(10.5)).toThrow(TypeError);
  });
});

describe('schemas', () => {
  it('accepts a valid referral submission and normalizes the code', () => {
    const parsed = referralSubmitSchema.parse({
      code: 'gmrf-7k2x',
      fullName: 'Jane Smith',
      treatmentInterest: 'implants',
      preferredPracticeId: '5f4c2b1a-0000-4000-8000-000000000001',
      consent: true,
      consentVersion: 'v1',
    });
    expect(parsed.code).toBe('GMRF7K2X');
  });
  it('rejects consent=false', () => {
    expect(() =>
      referralSubmitSchema.parse({
        code: 'GMRF7K2X',
        fullName: 'Jane Smith',
        treatmentInterest: 'implants',
        preferredPracticeId: '5f4c2b1a-0000-4000-8000-000000000001',
        consent: false,
        consentVersion: 'v1',
      }),
    ).toThrow();
  });
  // otpSendSchema / otpVerifySchema are gone: Supabase Auth owns login codes now, so there
  // is no OTP payload of ours left to validate. The phone normalization those tests really
  // cared about moved to profileSchema, which is where a phone number now enters the system.
  it('normalizes a free-typed phone to E.164', () => {
    expect(phoneSchema.parse('07700 900123')).toBe('+447700900123');
  });

  it('profileSchema requires a phone and normalizes it', () => {
    const parsed = profileSchema.parse({
      firstName: 'Sarah', lastName: 'Lewis', phone: '07700 900123', notifyOptIn: true,
    });
    expect(parsed.phone).toBe('+447700900123');
    // Phone is the Dentally matching key (FR-05), so an account without one cannot be
    // verified as a referrer. Making it optional here would let that fail silently later.
    expect(() => profileSchema.parse({
      firstName: 'Sarah', lastName: 'Lewis', notifyOptIn: true,
    })).toThrow();
    expect(() => profileSchema.parse({
      firstName: 'Sarah', lastName: 'Lewis', phone: 'not-a-phone', notifyOptIn: true,
    })).toThrow();
  });
});

describe('admin schemas', () => {
  it('accepts a valid login and normalizes the email', () => {
    const parsed = adminLoginSchema.parse({ email: '  Admin@GMDental.co.uk  ', password: 'anything' });
    expect(parsed.email).toBe('admin@gmdental.co.uk');
  });
  it('rejects an invalid email', () => {
    expect(() => adminLoginSchema.parse({ email: 'not-an-email', password: 'anything' })).toThrow();
  });
  it('accepts a valid admin creation payload', () => {
    const parsed = adminCreateSchema.parse({
      email: 'manager@gmdental.co.uk',
      password: 'correct-horse-battery',
      role: 'manager',
      practiceId: '5f4c2b1a-0000-4000-8000-000000000001',
    });
    expect(parsed.role).toBe('manager');
  });
  it('rejects a 9-character password', () => {
    expect(() =>
      adminCreateSchema.parse({ email: 'a@gmdental.co.uk', password: '123456789', role: 'admin' }),
    ).toThrow();
  });
  // Passwords are hashed with scrypt, whose cost scales with the input — an unbounded field
  // lets one request burn arbitrary CPU on the login path. 256 is far past any real password.
  it('accepts a 256-character password but rejects a longer one', () => {
    const max = 'a'.repeat(256);
    const tooLong = 'a'.repeat(257);
    expect(adminLoginSchema.parse({ email: 'a@gmdental.co.uk', password: max }).password).toBe(max);
    expect(() => adminLoginSchema.parse({ email: 'a@gmdental.co.uk', password: tooLong })).toThrow();
    expect(adminCreateSchema.parse({ email: 'a@gmdental.co.uk', password: max, role: 'admin' }).password).toBe(max);
    expect(() => adminCreateSchema.parse({ email: 'a@gmdental.co.uk', password: tooLong, role: 'admin' })).toThrow();
  });

  it('rejects an unknown role', () => {
    expect(() =>
      adminCreateSchema.parse({ email: 'a@gmdental.co.uk', password: 'correct-horse-battery', role: 'owner' }),
    ).toThrow();
  });
});
