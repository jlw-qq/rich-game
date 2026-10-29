/**
 * 表现层：在棋盘上查看任意格子。鼠标悬停临时查看，点击或触屏点选固定查看，
 * 键盘（左右方向键）逐格查看，Esc 取消。只维护“正在看哪一格”，不读写游戏状态。
 */

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
 * }} options pickTile 接收相对画布左上角的 CSS 像素坐标
 */
export function bindBoardPicker({ canvas, selection, pickTile, isProperty, landingIndex, onChange }) {
  const pointAt = (e) => {
    const rect = canvas.getBoundingClientRect();
    return pickTile(e.clientX - rect.left, e.clientY - rect.top);
  };

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
    selection.click(pointAt(e));
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
