import { describe, it, expect } from 'vitest';
import { createRng } from '../../../src/logic/utils/rng.js';

describe('createRng', () => {
  it('相同种子产生相同序列', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('next 落在 [0, 1)', () => {
    const rng = createRng(1);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int(1, 6) 不越界且六个面都能出现', () => {
    const rng = createRng(7);
    const seen = new Set();
    for (let i = 0; i < 10000; i++) {
      const v = rng.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('int 对非法区间抛错', () => {
    const rng = createRng(1);
    expect(() => rng.int(6, 1)).toThrow(RangeError);
    expect(() => rng.int(1.5, 6)).toThrow(RangeError);
  });

  it('可通过 getState 恢复序列', () => {
    const rng = createRng(99);
    rng.next();
    const resumed = createRng(rng.getState());
    expect(resumed.next()).toBe(rng.next());
  });
});
