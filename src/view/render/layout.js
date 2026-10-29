/**
 * 表现层：棋盘布局。格子先映射到 11×11 网格的外圈，再做等距（2.5D）投影。
 * 起点在最靠近观察者的底角，逆时针绕一圈。
 */

/** 每边的段数（每边 11 格，相邻两边共用角格） */
export const SIDE = 10;
/** 侧面厚度相对格子高度的比例 */
const DEPTH_RATIO = 0.28;

/**
 * 格子下标 → 网格坐标。只支持 4 × SIDE 格的环形棋盘。
 * @param {number} index
 * @returns {{ gx: number, gy: number }}
 */
export function gridOf(index) {
  const side = Math.floor(index / SIDE);
  const k = index % SIDE;
  switch (side) {
    case 0:
      return { gx: SIDE - k, gy: SIDE };
    case 1:
      return { gx: 0, gy: SIDE - k };
    case 2:
      return { gx: k, gy: 0 };
    default:
      return { gx: SIDE, gy: k };
  }
}

/** 四条边各自朝棋盘外侧的网格方向，顺序与 gridOf 的 side 一致 */
const OUTWARD = [
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 0],
];

/**
 * 非角格朝棋盘外侧的网格方向 [dx, dy]；角格返回 null。
 * @param {number} index
 * @returns {[number, number] | null}
 */
export function outwardOf(index) {
  if (index % SIDE === 0) return null;
  return OUTWARD[Math.floor(index / SIDE)];
}

/**
 * 按画布尺寸计算格子大小和原点，让整个棋盘居中且完整可见。
 * @param {number} width CSS 像素
 * @param {number} height CSS 像素
 */
export function computeLayout(width, height) {
  const cells = SIDE + 1;
  // 投影后棋盘宽 cells * tw，高 cells * th + 侧面厚度，th = tw / 2
  const tw = Math.min(width / cells, (height / (cells + DEPTH_RATIO)) * 2) * 0.96;
  const th = tw / 2;
  const depth = th * DEPTH_RATIO;
  const boardHeight = cells * th + depth;
  return {
    width,
    height,
    tw,
    th,
    depth,
    ox: width / 2,
    // 网格 (0, 0) 格子中心的 y
    oy: (height - boardHeight) / 2 + th / 2,
  };
}

/**
 * 网格坐标（可以是小数，用于动画插值）→ 屏幕坐标。
 * @param {{ tw: number, th: number, ox: number, oy: number }} layout
 */
export function project({ tw, th, ox, oy }, gx, gy) {
  return { x: ox + ((gx - gy) * tw) / 2, y: oy + ((gx + gy) * th) / 2 };
}

/** 格子顶面相对格子的缩放，留出缝隙 */
export const TILE_SCALE = 0.94;

/** 网格坐标 → 格子下标（只含外圈 4 × SIDE 格） */
const INDEX_BY_CELL = new Map(Array.from({ length: SIDE * 4 }, (_, i) => [`${gridOf(i).gx},${gridOf(i).gy}`, i]));

/**
 * 屏幕坐标 → 格子下标，即 project 的逆运算。只认格子顶面：
 * 落在格子之间的缝隙、中央区域或棋盘外时返回 null。
 * @param {{ tw: number, th: number, ox: number, oy: number }} layout
 * @param {number} x CSS 像素
 * @param {number} y CSS 像素
 * @returns {number | null}
 */
export function tileAt({ tw, th, ox, oy }, x, y) {
  const a = (2 * (x - ox)) / tw; // gx - gy
  const b = (2 * (y - oy)) / th; // gx + gy
  const gx = (a + b) / 2;
  const gy = (b - a) / 2;
  const cx = Math.round(gx);
  const cy = Math.round(gy);
  const half = TILE_SCALE / 2;
  if (Math.abs(gx - cx) > half || Math.abs(gy - cy) > half) return null;
  return INDEX_BY_CELL.get(`${cx},${cy}`) ?? null;
}
