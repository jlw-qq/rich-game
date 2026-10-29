/**
 * 表现层：动画曲线。输入 t ∈ [0, 1]，都是纯函数。
 */

/** 三次缓入缓出：起步慢、中段快、收尾慢，t = 0.5 时正好走一半 */
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 回弹放大：从 0 长到略超过 1，再回到 1 */
export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

/** 闪两下：两个亮度峰值，首尾为 0 */
export const flash = (t) => Math.sin(Math.PI * 2 * t) ** 2 * (1 - t * 0.4);

/** 飘字缩放：前 15% 放大到 1.25，到 35% 回到 1，之后保持 */
export function popScale(t) {
  if (t < 0.15) return 1 + 0.25 * (t / 0.15);
  if (t < 0.35) return 1.25 - 0.25 * ((t - 0.15) / 0.2);
  return 1;
}

/**
 * 骰子落定的弹跳：三次逐渐减弱的小跳，触地时压扁。结束时归位。
 * @returns {{ lift: number, scaleX: number, scaleY: number }} lift 以骰子边长为单位
 */
export function diceBounce(t) {
  if (t >= 1) return { lift: 0, scaleX: 1, scaleY: 1 };
  const hump = Math.abs(Math.sin(Math.PI * 3 * t));
  const decay = (1 - t) ** 2;
  const scaleY = 1 - 0.12 * (1 - t) * (1 - hump);
  return { lift: hump * decay * 0.25, scaleX: 2 - scaleY, scaleY };
}
