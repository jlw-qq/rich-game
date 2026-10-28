/**
 * 表现层：Canvas 2D 绘制 2.5D 棋盘。只读游戏状态，不修改。
 */
import { computeLayout, gridOf, project } from './layout.js';
import { GROUP_COLORS, PLAYER_COLORS, TILE_COLORS, shade } from './theme.js';

const FONT = 'system-ui, "Microsoft YaHei", sans-serif';
const CORNER_TYPES = ['start', 'jail', 'parking', 'goToJail'];
/** 格子顶面相对格子的缩放，留出缝隙 */
const TILE_SCALE = 0.94;
/**
 * 同一格内各玩家棋子的偏移（x 以格宽为单位，y 以格高为单位）。
 * 棋子半径 0.17 格高，格宽 = 2 格高，任意两个位置的中心距都 ≥ 0.36 格高，5 人同格也不重叠。
 */
const TOKEN_SLOTS = [
  [-0.2, 0],
  [0.2, 0],
  [0, -0.36],
  [0, 0.36],
  [0, 0],
];
const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createBoardRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let cssWidth = canvas.width;
  let cssHeight = canvas.height;
  let layout = computeLayout(cssWidth, cssHeight);

  /** 按 CSS 尺寸和设备像素比重设画布分辨率 */
  function resize(width, height) {
    if (!(width > 0 && height > 0)) return;
    dpr = window.devicePixelRatio || 1;
    cssWidth = width;
    cssHeight = height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    layout = computeLayout(width, height);
  }

  function polygon(points) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }

  /** 写一行居中文字，超出 maxWidth 时缩小字号 */
  function fitText(text, x, y, size, maxWidth, color, weight = 'normal') {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const w = ctx.measureText(text).width;
    if (w > maxWidth) ctx.font = `${weight} ${(size * maxWidth) / w}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function drawCenter(state, dice) {
    const { th } = layout;
    const corners = [
      [0.5, 0.5],
      [9.5, 0.5],
      [9.5, 9.5],
      [0.5, 9.5],
    ].map(([gx, gy]) => project(layout, gx, gy));
    polygon(corners.map((p) => [p.x, p.y]));
    ctx.fillStyle = '#2c5e47';
    ctx.fill();

    const c = project(layout, 5, 5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = `bold ${th * 0.9}px ${FONT}`;
    ctx.fillText('大富翁', c.x, c.y - th * 1.5);
    if (dice) drawDice(c, dice);
    if (state) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.font = `${th * 0.34}px ${FONT}`;
      ctx.fillText(`第 ${state.round} 轮`, c.x, c.y + th * 1.2);
    }
  }

  function drawDice(c, { values, rolling }) {
    const size = layout.th * 0.8;
    values.forEach((v, k) => {
      const x = c.x + (k === 0 ? -1 : 1) * size * 0.7;
      const y = c.y;
      ctx.beginPath();
      ctx.roundRect(x - size / 2, y - size / 2, size, size, size * 0.18);
      ctx.fillStyle = rolling ? '#fff3c4' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#222';
      for (const [px, py] of PIPS[v] ?? []) {
        ctx.beginPath();
        ctx.arc(x + px * size * 0.27, y + py * size * 0.27, size * 0.085, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function drawHouses(c, level) {
    const { th } = layout;
    const w = th * 0.14;
    const h = th * 0.1;
    ctx.fillStyle = level >= 4 ? '#c0392b' : '#2e8b57';
    for (let k = 0; k < level; k++) {
      const x = c.x + (k - (level - 1) / 2) * th * 0.2;
      const y = c.y + th * 0.2;
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
      polygon([
        [x - w * 0.65, y - h / 2],
        [x, y - h * 1.3],
        [x + w * 0.65, y - h / 2],
      ]);
      ctx.fill();
    }
  }

  function drawTile(tile, state) {
    const { tw, th, depth } = layout;
    const { gx, gy } = gridOf(tile.index);
    const c = project(layout, gx, gy);
    const hw = (tw / 2) * TILE_SCALE;
    const hh = (th / 2) * TILE_SCALE;
    const isProperty = tile.type === 'property';
    const prop = isProperty ? state?.properties[tile.id] : null;
    const top = TILE_COLORS[isProperty ? 'property' : tile.type];
    const side = isProperty ? GROUP_COLORS[tile.group] : top;

    // 两个侧面，做出厚度
    polygon([
      [c.x - hw, c.y],
      [c.x, c.y + hh],
      [c.x, c.y + hh + depth],
      [c.x - hw, c.y + depth],
    ]);
    ctx.fillStyle = shade(side, 0.75);
    ctx.fill();
    polygon([
      [c.x, c.y + hh],
      [c.x + hw, c.y],
      [c.x + hw, c.y + depth],
      [c.x, c.y + hh + depth],
    ]);
    ctx.fillStyle = shade(side, 0.55);
    ctx.fill();

    // 顶面
    polygon([
      [c.x, c.y - hh],
      [c.x + hw, c.y],
      [c.x, c.y + hh],
      [c.x - hw, c.y],
    ]);
    ctx.fillStyle = top;
    ctx.fill();
    ctx.strokeStyle = isProperty ? GROUP_COLORS[tile.group] : 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = isProperty ? Math.max(2, th * 0.08) : 1;
    ctx.stroke();

    const corner = CORNER_TYPES.includes(tile.type);
    const name = tile.type === 'jail' ? '监狱' : tile.name;
    fitText(name, c.x, c.y - (isProperty ? th * 0.08 : 0), th * (corner ? 0.32 : 0.27), tw * 0.56, '#222', corner ? 'bold' : 'normal');

    if (!isProperty) return;
    if (!prop?.ownerId) {
      fitText(`${tile.price}`, c.x, c.y + th * 0.18, th * 0.2, tw * 0.4, '#555');
      return;
    }
    drawHouses(c, prop.level);
    const ownerIndex = state.players.findIndex((p) => p.id === prop.ownerId);
    ctx.beginPath();
    ctx.arc(c.x, c.y - th * 0.33, th * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[ownerIndex] ?? '#999';
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (prop.mortgaged) {
      polygon([
        [c.x, c.y - hh],
        [c.x + hw, c.y],
        [c.x, c.y + hh],
        [c.x - hw, c.y],
      ]);
      ctx.fillStyle = 'rgba(70, 70, 70, 0.55)';
      ctx.fill();
      fitText('抵押', c.x, c.y + th * 0.18, th * 0.22, tw * 0.4, '#fff', 'bold');
    }
  }

  function drawTokens(state, tokens, currentPlayerId) {
    const { tw, th } = layout;
    const r = th * 0.17;
    const items = state.players
      .map((p, i) => ({ p, i, tok: tokens.get(p.id) }))
      .filter(({ p, tok }) => !p.bankrupt && tok)
      .map(({ p, i, tok }) => {
        const base = project(layout, tok.gx, tok.gy);
        const [sx, sy] = TOKEN_SLOTS[i % TOKEN_SLOTS.length];
        return { p, i, z: tok.z, x: base.x + sx * tw, y: base.y + sy * th };
      })
      .sort((a, b) => a.y - b.y);

    for (const { p, i, x, y, z } of items) {
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fill();

      const cy = y - r * 0.7 - z * th;
      if (p.id === currentPlayerId) {
        ctx.beginPath();
        ctx.arc(x, cy, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_COLORS[i];
      ctx.fill();
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 座位号，颜色之外的第二种区分方式（名字首字可能相同，如“小红”“小蓝”）
      fitText(String(i + 1), x, cy, r * 1.2, r * 1.6, '#1b1b1b', 'bold');
    }
  }

  function drawFloater({ text, color, gx, gy, rise, alpha }) {
    const { th } = layout;
    const p = project(layout, gx, gy);
    const y = p.y - th * 0.6 - rise * th;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `bold ${th * 0.34}px ${FONT}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.strokeText(text, p.x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, y);
    ctx.globalAlpha = 1;
  }

  /**
   * @param {{
   *   board: { tiles: readonly object[] },
   *   state?: object | null,
   *   tokens?: Map<string, { gx: number, gy: number, z: number }> | null,
   *   dice?: { values: number[], rolling: boolean } | null,
   *   floaters?: object[],
   *   currentPlayerId?: string | null,
   * }} scene
   */
  function draw({ board, state = null, tokens = null, dice = null, floaters = [], currentPlayerId = null }) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    drawCenter(state, dice);
    // 从远到近画，近处格子的侧面盖住远处
    const depthOf = (t) => {
      const { gx, gy } = gridOf(t.index);
      return gx + gy;
    };
    for (const tile of [...board.tiles].sort((a, b) => depthOf(a) - depthOf(b))) drawTile(tile, state);
    if (state && tokens) drawTokens(state, tokens, currentPlayerId);
    for (const f of floaters) drawFloater(f);
  }

  return { resize, draw };
}
