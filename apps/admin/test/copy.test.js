import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/copy.js';

describe('errorMessage', () => {
  it('maps known API error codes to front-desk language', () => {
    expect(errorMessage('invalid_transition')).toBe(
      "That status move isn't allowed from where the referral is now.",
    );
    expect(errorMessage('payout_not_open')).toBe('This payout request is no longer open.');
    expect(errorMessage('unauthorized')).toBe('Your session ended — sign in again.');
  });

  it('passes unknown codes through unchanged', () => {
    expect(errorMessage('something_else')).toBe('something_else');
  });
});
