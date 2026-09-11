// Web-only CSS that react-native-web's StyleSheet cannot express.
//
// Three things, all invisible on native:
//
// 1. THE OLIVE INPUT. Chrome paints autofilled fields with its own background and ignores
//    inline styles, so a remembered email turned our dark card-face field into a flat olive
//    slab with the label floating over it. It reads as a rendering bug, and on a sign-in
//    screen — the first thing anyone sees — it makes the whole app look broken. There is no
//    property that disables it; the accepted trick is to cover the field with a 1000px inset
//    shadow in our own colour and paint the glyphs with -webkit-text-fill-color. The absurd
//    transition delay stops the yellow flash on focus, which Chrome re-applies.
//
// 2. FOCUS RINGS. We draw our own gold ring on focus (see components/ui.js), so the browser's
//    default outline would double up. Removing it is only safe BECAUSE ours replaces it —
//    onFocus fires for keyboard tabbing too, so keyboard users still see where they are.
//
// 3. THE GROUND. Without an explicit background on html/body the browser paints white behind
//    the app: a white flash before hydration, and white rubber-band overscroll.
import { Platform } from 'react-native';
import { colors } from '../theme';

const CSS = `
  html, body, #root {
    background-color: ${colors.boardroom};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Chrome/Safari autofill — see note 1 above. */
  input:-webkit-autofill,
  input:-webkit-autofill:hover,
  input:-webkit-autofill:focus,
  input:-webkit-autofill:active {
    -webkit-text-fill-color: ${colors.ivory} !important;
    caret-color: ${colors.ivory};
    -webkit-box-shadow: 0 0 0 1000px ${colors.cardface} inset !important;
    box-shadow: 0 0 0 1000px ${colors.cardface} inset !important;
    transition: background-color 600000s 0s, color 600000s 0s;
  }

  /* We render our own focus ring. */
  input:focus, input:focus-visible, textarea:focus, [role="button"]:focus {
    outline: none;
  }

  /* The 6-digit code field: centred, tracked out like the serial on the card.
     Both spinner pseudo-elements have to be named explicitly. There is no
     ::-webkit-inputmode-spin-button — that typo made the whole selector list invalid, and CSS
     drops an entire rule when any selector in it fails to parse, so the valid outer-spin-button
     reset went with it and the spinners stayed. */
  input[inputmode="numeric"]::-webkit-outer-spin-button,
  input[inputmode="numeric"]::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`;

/** Inject once. Safe to call on every platform and more than once. */
export function installWebStyles() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  if (document.getElementById('gmref-web-styles')) return;
  const el = document.createElement('style');
  el.id = 'gmref-web-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}
