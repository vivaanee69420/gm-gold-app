// The Notice slab and the empty space it leaves behind have to be the same height, or the
// primary button under it jumps the moment an error appears — on the sign-in screen, the first
// thing anyone sees. The component's comment claimed this was handled while the spacer only
// reserved margin, so the button moved the full slab height (~39px) on the first error.
//
// Asserted as an invariant between the two styles rather than as a magic number, so changing
// the slab's padding or its line height without moving the spacer fails here.
import { describe, expect, it } from 'vitest';
import { StyleSheet } from 'react-native';
import { uiStyles } from '../src/components/ui';

// flatten() rather than reading the objects directly: StyleSheet.create is free to return
// opaque registered ids, and flatten is the public way back to the values.
const flat = (style) => StyleSheet.flatten(style);

describe('Notice reserves its own height when empty', () => {
  it('spacer height equals the filled slab height', () => {
    const slab = flat(uiStyles.notice);
    const text = flat(uiStyles.noticeText);
    const spacer = flat(uiStyles.noticeSpacer);

    const filledHeight = slab.paddingVertical * 2 + text.lineHeight;

    expect(spacer.height, 'the empty state must reserve the slab height, not just its margin')
      .toBe(filledHeight);
  });

  it('spacer keeps the same bottom margin as the slab', () => {
    // Height alone is not enough: the gap between the notice and the button has to survive
    // the swap too, or the button moves by the margin instead of by the slab.
    expect(flat(uiStyles.noticeSpacer).marginBottom).toBe(flat(uiStyles.notice).marginBottom);
  });

  it('reserves a real height, not zero', () => {
    // Guards the degenerate pass: if both sides resolved to undefined this suite would be
    // comparing nothing to nothing and would stay green through the original bug.
    expect(flat(uiStyles.noticeSpacer).height).toBeGreaterThan(0);
  });
});
