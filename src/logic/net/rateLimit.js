/**
 * 逻辑层：令牌桶限流。每条消息取一个令牌，令牌按固定速度补充，桶满为止。
 * 时间由调用方传入，便于测试。
 */

/**
 * @param {{ capacity: number, perSecond: number, now: () => number }} options now 返回毫秒
 */
export function createRateLimiter({ capacity, perSecond, now }) {
  let tokens = capacity;
  let last = now();
  return {
    /** @returns {boolean} 还有令牌时取走一个并返回 true */
    take() {
      const t = now();
      // 系统时间被往回调时（如 NTP 校时）不扣令牌
      tokens = Math.min(capacity, tokens + (Math.max(0, t - last) / 1000) * perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
