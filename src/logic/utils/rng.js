/**
 * 可设种子的伪随机数生成器（mulberry32）。
 * 逻辑层所有随机都必须走这里，保证单测与回放可复现。
 */

/**
 * @param {number} seed 32 位整数种子
 * @returns {{ next: () => number, int: (min: number, max: number) => number, getState: () => number }}
 */
export function createRng(seed) {
  let state = seed >>> 0;

  /** 返回 [0, 1) 的浮点数 */
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回闭区间 [min, max] 的整数 */
  function int(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new RangeError(`rng.int 参数非法: [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  }

  /** 当前内部状态，用于存档后恢复随机序列 */
  function getState() {
    return state;
  }

  return { next, int, getState };
}
