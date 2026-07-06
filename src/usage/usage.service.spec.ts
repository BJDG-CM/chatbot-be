import { calculateResolutionRate } from './usage.service';

describe('calculateResolutionRate', () => {
  it('returns 0 when no answers were generated', () => {
    expect(calculateResolutionRate(0, 0)).toBe(0);
  });

  it('returns 100 when none of the answers have BAD feedback', () => {
    expect(calculateResolutionRate(5, 0)).toBe(100);
  });

  it('calculates the BAD feedback ratio against all generated answers', () => {
    expect(calculateResolutionRate(3, 1)).toBe(66.67);
  });
});
