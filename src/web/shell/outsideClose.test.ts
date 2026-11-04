import { describe, expect, it } from 'vitest';
import { isOutside } from './outsideClose';

describe('closing a pop-up by clicking outside it', () => {
  const box = { left: 100, right: 500, top: 50, bottom: 400 };
  it('is outside only beyond the edges', () => {
    expect(isOutside(box, 99, 200)).toBe(true);
    expect(isOutside(box, 501, 200)).toBe(true);
    expect(isOutside(box, 300, 49)).toBe(true);
    expect(isOutside(box, 300, 401)).toBe(true);
    expect(isOutside(box, 100, 50)).toBe(false);
    expect(isOutside(box, 300, 200)).toBe(false);
  });
});
