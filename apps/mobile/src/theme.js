// GM Referral design tokens — members-club gold card on boardroom green.
// One bold element (the gold seam); everything else disciplined.

export const colors = {
  boardroom: '#0B2B26', // app ground
  cardface: '#123832', // raised surfaces
  cardedge: '#1B4A42', // subtle top-light on surfaces
  gold: '#C9A961', // brushed gold: borders, CTAs, active states
  goldbright: '#E8CB8A', // foil gold: balance numerals, seam fill
  ivory: '#F4EFE4', // primary text on dark, QR well
  mist: '#8FA79F', // labels, secondary text, hairlines
  mistFaint: 'rgba(143,167,159,0.25)',
  success: '#7FB069', // Completed chips only
  danger: '#C97361',
  black: '#06201C',
};

export const type = {
  display: 'Fraunces_600SemiBold',
  displayLight: 'Fraunces_400Regular',
  mono: undefined, // set per-platform below
};

import { Platform } from 'react-native';
type.mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const space = (n) => n * 4;

export const radius = { card: 20, control: 12, chip: 999 };

export const hairline = {
  borderBottomWidth: 1,
  borderBottomColor: colors.mistFaint,
};
