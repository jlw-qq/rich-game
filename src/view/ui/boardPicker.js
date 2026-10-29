/**
 * 表现层：在棋盘上查看任意格子。鼠标悬停临时查看，点击或触屏点选固定查看，
 * 键盘（左右方向键）逐格查看，Esc 取消。只维护“正在看哪一格”，不读写游戏状态。
 * 小画布的触屏设备上还可以放大：第一次点按放大，单指拖动平移，双指捏合缩放。
 */

/** 手指移动超过该距离（CSS 像素）算拖动，不再当作点按 */
const DRAG_THRESHOLD = 8;

/**
 * 选择状态，不依赖 DOM。
 * 显示优先级：悬停 > 固定选中 > 最近落点。
 * @param {number} tileCount 格子总数，方向键在首尾之间循环
 */
export function createSelection(tileCount) {
  let hover = null;
  let pinned = null;

  return {
    /** @param {number | null} index 指针下的格子，离开棋盘为 null */
    setHover(index) {
      hover = index;
    },
    /** 点选：点同一格或空白处取消固定，点其他格改为固定该格 */
    click(index) {
      pinned = index === null || index === pinned ? null : index;
    },
    clear() {
      pinned = null;
    },
    /** 方向键：从当前查看的格子（没有时从 from）前进或后退一格，并固定 */
    step(delta, from = 0) {
      const base = pinned ?? hover ?? from;
      pinned = (((base + delta) % tileCount) + tileCount) % tileCount;
      return pinned;
    },
    get hover() {
      return hover;
    },
    get pinned() {
      return pinned;
    },
    /**
     * 当前要显示卡片的格子。
     * @param {number | null} landing 最近落点
     * @returns {{ index: number, source: 'hover' | 'pinned' | 'landing' } | null}
     */
    current(landing) {
      if (hover !== null) return { index: hover, source: 'hover' };
      if (pinned !== null) return { index: pinned, source: 'pinned' };
      if (landing !== null && landing !== undefined) return { index: landing, source: 'landing' };
      return null;
    },
  };
}

/**
 * 把鼠标、触屏和键盘事件绑定到画布。
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   selection: ReturnType<typeof createSelection>,
 *   pickTile: (x: number, y: number) => number | null,
 *   isProperty: (index: number) => boolean,
 *   landingIndex: () => number | null,
 *   onChange: () => void,
 *   zoom?: {
 *     viewport: ReturnType<typeof import('../render/viewport.js').createViewport>,
 *     enabled: () => boolean,
 *   },
 * }} options pickTile 接收相对画布左上角的 CSS 像素坐标（已扣除缩放平移）；
 *   zoom.enabled 为 false 时不响应放大手势
 */
export function bindBoardPicker({ canvas, selection, pickTile, isProperty, landingIndex, onChange, zoom = null }) {
  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const pointAt = (e) => {
    const { x, y } = local(e);
    return pickTile(x, y);
  };

  /** 进行中的触点：pointerId → 最近位置 */
  const touches = new Map();
  let travelled = 0;
  let pinchDistance = 0;
  /** 本次手势拖动或捏合过，结束后的 click 不当作点按 */
  let gestured = false;
  let lastPointerType = 'mouse';
  const zoomActive = () => zoom !== null && zoom.enabled();
  const distance = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);

  canvas.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    if (e.pointerType === 'mouse' || !zoomActive()) return;
    touches.set(e.pointerId, local(e));
    if (touches.size === 1) {
      travelled = 0;
      gestured = false;
    }
    if (touches.size === 2) pinchDistance = distance([...touches.values()]);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    const prev = touches.get(e.pointerId);
    const next = local(e);
    touches.set(e.pointerId, next);
    if (touches.size === 1 && zoom.viewport.zoomed) {
      travelled += Math.hypot(next.x - prev.x, next.y - prev.y);
      if (travelled > DRAG_THRESHOLD) {
        gestured = true;
        zoom.viewport.pan(next.x - prev.x, next.y - prev.y);
        onChange();
      }
    } else if (touches.size === 2) {
      const pts = [...touches.values()];
      const d = distance(pts);
      if (pinchDistance > 0 && d > 0) {
        zoom.viewport.pinch((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, d / pinchDistance);
        gestured = true;
        onChange();
      }
      pinchDistance = d;
    }
  });
  const endTouch = (e) => touches.delete(e.pointerId);
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', endTouch);

  function setHover(index) {
    if (index === selection.hover) return;
    selection.setHover(index);
    canvas.style.cursor = index !== null && isProperty(index) ? 'pointer' : '';
    onChange();
  }

  // 触屏没有悬停，只处理点选
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') setHover(pointAt(e));
  });
  canvas.addEventListener('pointerleave', () => setHover(null));
  canvas.addEventListener('click', (e) => {
    if (gestured) {
      gestured = false;
      return;
    }
    const index = pointAt(e);
    // 触屏第一次点按：先放大到点按位置，同时选中该格
    if (lastPointerType !== 'mouse' && zoomActive() && !zoom.viewport.zoomed) {
      const { x, y } = local(e);
      zoom.viewport.zoomInAt(x, y, performance.now());
      if (index !== null) selection.click(index);
    } else {
      selection.click(index);
    }
    onChange();
  });
  canvas.addEventListener('keydown', (e) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (delta) {
      e.preventDefault();
      selection.step(delta, landingIndex() ?? 0);
      onChange();
    } else if (e.key === 'Escape' && selection.pinned !== null) {
      e.preventDefault();
      selection.clear();
      onChange();
    }
  });
}
