// The web-only stylesheet is a single string injected into <head>, and CSS has a rule that
// makes that risky: if ANY selector in a comma-separated list fails to parse, the browser
// throws away the whole rule. `::-webkit-inputmode-spin-button` does not exist, so the valid
// `::-webkit-outer-spin-button` reset sitting beside it was being dropped too and the number
// spinners stayed on the code field.
//
// jsdom's CSS parser discards invalid rules exactly as a browser does, so reading the rules
// back off the injected sheet tests the real failure rather than the text of the file.
import { describe, expect, it, beforeAll } from 'vitest';
import { installWebStyles } from '../src/lib/webStyles';

const sheetFor = (id) => [...document.styleSheets].find((s) => s.ownerNode?.id === id);

let selectors;

beforeAll(() => {
  installWebStyles();
  const sheet = sheetFor('gmref-web-styles');
  expect(sheet, 'installWebStyles must inject a stylesheet under jsdom').toBeDefined();
  selectors = [...sheet.cssRules].map((rule) => rule.selectorText).filter(Boolean);
});

describe('installWebStyles', () => {
  it('keeps the spin-button reset — every selector in it must parse', () => {
    const spinRule = selectors.find((s) => s.includes('spin-button'));
    expect(spinRule, 'the whole rule is dropped if one selector is invalid').toBeDefined();
    expect(spinRule).toContain('-webkit-outer-spin-button');
    expect(spinRule).toContain('-webkit-inner-spin-button');
  });

  it('names no pseudo-element that does not exist', () => {
    // The specific typo that caused this, kept by name so it cannot come back unnoticed.
    expect(selectors.join(' ')).not.toContain('inputmode-spin-button');
  });

  it('still installs the autofill and focus-ring overrides', () => {
    // The rest of the sheet is the reason it exists at all — a regression that dropped these
    // would give Chrome's olive autofill slab and a doubled focus ring back.
    expect(selectors.some((s) => s.includes('autofill'))).toBe(true);
    expect(selectors.some((s) => s.includes(':focus'))).toBe(true);
  });

  it('is safe to call twice', () => {
    installWebStyles();
    const matching = [...document.querySelectorAll('#gmref-web-styles')];
    expect(matching).toHaveLength(1);
  });
});
