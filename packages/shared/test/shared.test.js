import { describe, it, expect } from 'vitest';
import { normalizePhone, isUkMobile, isE164 } from '../src/phone.js';
import { normalizeCode, formatCode, generateCode, CODE_ALPHABET } from '../src/referral-code.js';
import { formatPennies, addPennies, parseGBPToPennies, assertPennies } from '../src/money.js';
import { referralSubmitSchema, otpVerifySchema, phoneSchema, adminLoginSchema, adminCreateSchema } from '../src/schemas.js';

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
    expect(normalizeCode('gmrf-7k2x')).toBe('GMRF7K2X');
    expect(normalizeCode(' GMRF 7K2X ')).toBe('GMRF7K2X');
  });
  it('rejects ambiguous characters and wrong lengths', () => {
    expect(normalizeCode('GMRF7K2')).toBeNull(); // 7 chars
    expect(normalizeCode('GMRF7K20')).toBeNull(); // 0 not in alphabet
    expect(normalizeCode('GMRF7KIL')).toBeNull(); // I and L not in alphabet
  });
  it('formats for display', () => {
    expect(formatCode('GMRF7K2X')).toBe('GMRF-7K2X');
  });
  it('generates valid canonical codes', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();
      expect(normalizeCode(code)).toBe(code);
      for (const ch of code) expect(CODE_ALPHABET.includes(ch)).toBe(true);
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
  it('validates OTP shape and normalizes phones', () => {
    expect(otpVerifySchema.parse({ phone: '07700 900123', code: '123456' }).phone).toBe('+447700900123');
    expect(() => otpVerifySchema.parse({ phone: '07700 900123', code: '12345' })).toThrow();
    expect(phoneSchema.parse('07700 900123')).toBe('+447700900123');
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
