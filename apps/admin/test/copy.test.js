import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/copy.js';

describe('errorMessage', () => {
  it('maps known API error codes to front-desk language', () => {
    expect(errorMessage('invalid_transition')).toBe(
      "That status move isn't allowed from where the referral is now.",
    );
    expect(errorMessage('payout_not_open')).toBe('This payout request is no longer open.');
    expect(errorMessage('unauthorized')).toBe('Your session ended — sign in again.');
    expect(errorMessage('amount_required')).toBe('Type the cash amount handed over before marking paid.');
    expect(errorMessage('amount_mismatch')).toBe(
      "That amount doesn't match the request — check the cash and try again.",
    );
  });

  it('passes unknown codes through unchanged', () => {
    expect(errorMessage('something_else')).toBe('something_else');
  });

  it('maps admin auth and team management error codes to front-desk language', () => {
    expect(errorMessage('invalid_credentials')).toBe('Email or password is wrong.');
    expect(errorMessage('rate_limited')).toBe('Too many attempts — wait 15 minutes and try again.');
    expect(errorMessage('email_taken')).toBe('An account with that email already exists.');
    expect(errorMessage('weak_password')).toBe('Passwords need at least 10 characters.');
    expect(errorMessage('practice_required')).toBe('A manager needs exactly one practice.');
    expect(errorMessage('cannot_deactivate_self')).toBe("You can't deactivate your own account.");
    expect(errorMessage('last_admin')).toBe('There must be at least one active admin.');
    expect(errorMessage('wrong_password')).toBe('Your current password is wrong.');
  });
});
