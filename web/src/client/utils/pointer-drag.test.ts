// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { endsADrag, touchEndsADrag } from './pointer-drag';

const pointer = (type: string, x: number, y: number, pointerId = 7) =>
  new PointerEvent(type, { pointerId, clientX: x, clientY: y, bubbles: true });

describe('endsADrag', () => {
  it('tells the end of a scroll from a tap', () => {
    document.dispatchEvent(pointer('pointerdown', 250, 456));
    expect(endsADrag(pointer('pointerup', 250, 200))).toBe(true);
    document.dispatchEvent(pointer('pointerdown', 250, 456));
    expect(endsADrag(pointer('pointerup', 253, 459))).toBe(false);
  });

  it('treats a pointer it never saw go down as a tap', () => {
    expect(endsADrag(pointer('pointerup', 10, 10, 99))).toBe(false);
  });

  it('tells the end of a scroll from a tap for a touchend', () => {
    const touch = (x: number, y: number) =>
      ({ identifier: 3, clientX: x, clientY: y }) as unknown as Touch;
    const event = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as TouchEvent;
      Object.defineProperty(e, 'changedTouches', { value: [touch(x, y)] });
      return e;
    };
    document.dispatchEvent(event('touchstart', 40, 600));
    expect(touchEndsADrag(event('touchend', 40, 300))).toBe(true);
    document.dispatchEvent(event('touchstart', 40, 600));
    expect(touchEndsADrag(event('touchend', 42, 603))).toBe(false);
  });
});
