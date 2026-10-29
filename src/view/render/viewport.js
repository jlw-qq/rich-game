/**
 * 表现层：棋盘的缩放与平移（只影响绘制，不碰游戏状态）。
 * 变换：屏幕坐标 = 棋盘坐标 × scale + (ox, oy)，坐标都是画布内的 CSS 像素。
 * scale = 1 时显示全图；平移有边界，不能把棋盘拖出画布。
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 3;
/** 点按放大时的倍数 */
export const TAP_ZOOM = 2.5;
/** 放大、缩小的过渡时长 */
export const ZOOM_MS = 300;
/** 跟随棋子时每帧向目标靠近的比例 */
const FOLLOW_RATE = 0.18;

const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const easeOut = (t) => 1 - (1 - t) ** 3;

/**
 * @param {number} [width] 画布 CSS 宽
 * @param {number} [height] 画布 CSS 高
 */
export function createViewport(width = 1, height = 1) {
  let w = width;
  let h = height;
  /** 当前显示的变换 */
  let view = { scale: 1, ox: 0, oy: 0 };
  /** 过渡动画：{ from, to, start }，没有时为 null */
  let anim = null;

  /** 限制平移范围：放大后的棋盘始终盖满画布 */
  function clamp({ scale, ox, oy }) {
    const s = clampScale(scale);
    return {
      scale: s,
      ox: Math.min(0, Math.max(w * (1 - s), ox)),
      oy: Math.min(0, Math.max(h * (1 - s), oy)),
    };
  }

  /** 以屏幕点 (x, y) 为中心缩放到 scale：该点下的棋盘位置保持不动 */
  function scaledAt(from, x, y, scale) {
    const s = clampScale(scale);
    const k = s / from.scale;
    return clamp({ scale: s, ox: x - (x - from.ox) * k, oy: y - (y - from.oy) * k });
  }

  /** 让棋盘坐标 (bx, by) 出现在画布中心 */
  function centeredOn(scale, bx, by) {
    return clamp({ scale, ox: w / 2 - bx * scale, oy: h / 2 - by * scale });
  }

  function animateTo(target, now) {
    anim = { from: { ...view }, to: target, start: now };
  }

  return {
    get view() {
      return view;
    },
    get zoomed() {
      return view.scale > MIN_SCALE + 1e-6 || (anim !== null && anim.to.scale > MIN_SCALE);
    },
    /**
     * 画布尺寸变化时调用：尺寸真的变了才回到全图。
     * ResizeObserver 在尺寸不变时也可能回调，不能因此打断玩家的放大查看。
     */
    resize(width, height) {
      if (width === w && height === h) return;
      w = width;
      h = height;
      view = { scale: 1, ox: 0, oy: 0 };
      anim = null;
    },
    /** 屏幕坐标 → 棋盘坐标 */
    toBoard(x, y) {
      return { x: (x - view.ox) / view.scale, y: (y - view.oy) / view.scale };
    },
    /** 点按放大：以屏幕点为中心，平滑放大到 TAP_ZOOM */
    zoomInAt(x, y, now) {
      const b = this.toBoard(x, y);
      animateTo(centeredOn(TAP_ZOOM, b.x, b.y), now);
    },
    /** 平滑回到全图 */
    reset(now) {
      animateTo({ scale: 1, ox: 0, oy: 0 }, now);
    },
    /** 拖动平移（屏幕像素） */
    pan(dx, dy) {
      anim = null;
      view = clamp({ ...view, ox: view.ox + dx, oy: view.oy + dy });
    },
    /** 捏合缩放：以屏幕点为中心，乘以 factor */
    pinch(x, y, factor) {
      anim = null;
      view = scaledAt(view, x, y, view.scale * factor);
    },
    /** 放大状态下让镜头逐帧靠近棋盘坐标 (bx, by)；返回是否还需要下一帧 */
    follow(bx, by) {
      if (anim || view.scale <= MIN_SCALE) return false;
      const target = centeredOn(view.scale, bx, by);
      const dx = target.ox - view.ox;
      const dy = target.oy - view.oy;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return false;
      view = clamp({ ...view, ox: view.ox + dx * FOLLOW_RATE, oy: view.oy + dy * FOLLOW_RATE });
      return true;
    },
    /** 推进过渡动画；返回是否还需要下一帧 */
    tick(now) {
      if (!anim) return false;
      const t = Math.min(1, (now - anim.start) / ZOOM_MS);
      const e = easeOut(t);
      const { from, to } = anim;
      view = {
        scale: from.scale + (to.scale - from.scale) * e,
        ox: from.ox + (to.ox - from.ox) * e,
        oy: from.oy + (to.oy - from.oy) * e,
      };
      if (t >= 1) {
        view = to;
        anim = null;
      }
      return anim !== null;
    },
  };
}
