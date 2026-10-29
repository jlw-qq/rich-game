/**
 * 表现层：Canvas 2D 绘制 2.5D 棋盘。只读游戏状态，不修改。
 */
import { computeLayout, gridOf, outwardOf, project, tileAt, TILE_SCALE } from './layout.js';
import { BOARD_COLORS, GROUP_COLORS, GROUP_HEADERS, ICON_COLORS, PLAYER_COLORS, STYLE, TILE_COLORS, shade } from './theme.js';
import { drawIcon } from './icons.js';
import { easeOutBack, flash } from './easing.js';
import { cityLots, createCityPainter } from './city.js';
import { drawPopup } from './popup.js';

const FONT = 'system-ui, "Microsoft YaHei", sans-serif';
const CORNER_TYPES = ['start', 'jail', 'parking', 'goToJail'];
/** 顶面半边长（网格单位） */
const HALF = TILE_SCALE / 2;
/** 地产组色带的宽度（网格单位），画在格子朝外的一侧 */
const BAND = 0.2;
/** 中央底板凸点的间距（网格单位）和半径（格宽为单位） */
const STUD_STEP = 1;
const STUD_RADIUS = 0.11;
/** 抵押遮罩的最终不透明度 */
const MORTGAGE_ALPHA = 0.55;
/** 查看中的格子描边颜色（与落点的金色区分） */
const VIEW_COLOR = '#2f6fb3';
/** 落点高亮颜色 */
const HIGHLIGHT_COLOR = '#ff9f1c';
/** 中央广场（放骰子）的网格范围 */
const PLAZA_MIN = 3.4;
const PLAZA_MAX = 6.6;
/** 中央区域的网格范围，与外圈格子的内边对齐 */
const CENTER_MIN = 0.5;
const CENTER_MAX = 9.5;
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
  /** 本帧的格子特效（tileId → { kind, level, t }），由 draw 传入 */
  let effects = new Map();
  /** 本帧地产格的城市名位置 */
  let names = [];
  /** 中央城市：地块位置固定，按棋盘计算一次 */
  let lots = null;
  let city = createCityPainter(ctx, layout, (gx, gy) => project(layout, gx, gy));

  /** 按 CSS 尺寸和设备像素比重设画布分辨率 */
  function resize(width, height) {
    if (!(width > 0 && height > 0)) return;
    dpr = window.devicePixelRatio || 1;
    cssWidth = width;
    cssHeight = height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    layout = computeLayout(width, height);
    city = createCityPainter(ctx, layout, (gx, gy) => project(layout, gx, gy));
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

  function centerPath() {
    polygon(
      [
        [CENTER_MIN, CENTER_MIN],
        [CENTER_MAX, CENTER_MIN],
        [CENTER_MAX, CENTER_MAX],
        [CENTER_MIN, CENTER_MAX],
      ].map(([gx, gy]) => {
        const p = project(layout, gx, gy);
        return [p.x, p.y];
      }),
    );
  }

  /** 中央：底色 + 沿等距方向的细格纹 + 内阴影，看起来比外圈格子低一层 */
  function drawCenter() {
    const { th } = layout;
    centerPath();
    ctx.fillStyle = BOARD_COLORS.center;
    ctx.fill();

    ctx.save();
    centerPath();
    ctx.clip();
    // 积木底板的凸点：每个凸点是一个暗色底 + 偏上的亮面
    const rx = layout.tw * STUD_RADIUS;
    const ry = rx / 2;
    const lift = ry * 0.6;
    for (let gx = CENTER_MIN + STUD_STEP / 2; gx < CENTER_MAX; gx += STUD_STEP) {
      for (let gy = CENTER_MIN + STUD_STEP / 2; gy < CENTER_MAX; gy += STUD_STEP) {
        const p = project(layout, gx, gy);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = BOARD_COLORS.studDark;
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(p.x, p.y - lift, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = BOARD_COLORS.studLight;
        ctx.fill();
      }
    }

    // 内阴影：沿边缘画一圈带模糊的粗描边，裁剪后只剩区域内的部分
    centerPath();
    ctx.shadowColor = 'rgba(20, 40, 10, 0.5)';
    ctx.shadowBlur = th * 0.6;
    ctx.strokeStyle = 'rgba(20, 40, 10, 0.3)';
    ctx.lineWidth = th * 0.25;
    ctx.stroke();
    ctx.restore();

    centerPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 城市中心的广场：浅色石板地，骰子放在这里
    polygon(
      [
        [PLAZA_MIN, PLAZA_MIN],
        [PLAZA_MAX, PLAZA_MIN],
        [PLAZA_MAX, PLAZA_MAX],
        [PLAZA_MIN, PLAZA_MAX],
      ].map(([gx, gy]) => {
        const p = project(layout, gx, gy);
        return [p.x, p.y];
      }),
    );
    ctx.fillStyle = BOARD_COLORS.plaza;
    ctx.fill();
    ctx.strokeStyle = BOARD_COLORS.outline;
    ctx.lineWidth = STYLE.line;
    ctx.stroke();
  }

  /** 城市名补画在建筑之上，带浅色描边，被高楼压住时也能读清 */
  function drawNames() {
    const { tw, th } = layout;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 252, 244, 0.9)';
    ctx.lineWidth = Math.max(2, th * 0.08);
    for (const n of names) {
      ctx.font = `bold ${th * 0.27}px ${FONT}`;
      const w = ctx.measureText(n.text).width;
      if (w > tw * 0.5) ctx.font = `bold ${(th * 0.27 * tw * 0.5) / w}px ${FONT}`;
      ctx.strokeText(n.text, n.x, n.y);
      ctx.fillStyle = BOARD_COLORS.text;
      ctx.fillText(n.text, n.x, n.y);
    }
    ctx.restore();
  }

  /** 标题、骰子、轮数：画在城市建筑之上，不会被楼挡住 */
  function drawCenterLabels(state, dice) {
    const { th } = layout;
    const c = project(layout, 5, 5);
    // 标题写在浅色广场上，用深色字
    ctx.save();
    ctx.fillStyle = BOARD_COLORS.plazaText;
    ctx.font = `bold ${th * 0.6}px ${FONT}`;
    ctx.fillText('大富翁', c.x, c.y - th * 1.2);
    ctx.restore();
    if (dice) drawDice({ x: c.x, y: c.y - th * 0.15 }, dice);
    if (state) {
      ctx.fillStyle = BOARD_COLORS.plazaText;
      ctx.font = `bold ${th * 0.3}px ${FONT}`;
      ctx.fillText(`第 ${state.round} 轮`, c.x, c.y + th * 0.75);
    }
  }

  /** 浮起元素的统一阴影，scale 用于缩小（如文字阴影） */
  function liftShadow(scale = 1) {
    const { th } = layout;
    const s = STYLE.liftShadow;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = th * s.blur * scale;
    ctx.shadowOffsetY = th * s.offsetY * scale;
  }

  /** 查看中的格子：白色细描边 */
  function drawViewOutline(index) {
    const { th } = layout;
    const { gx, gy } = gridOf(index);
    ctx.save();
    topPath(project(layout, gx, gy));
    ctx.strokeStyle = VIEW_COLOR;
    ctx.lineWidth = Math.max(STYLE.emphasisLine, th * 0.06);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  /** 落点高亮：顶面加一圈发光描边 */
  function drawHighlight(index, glow) {
    const { th } = layout;
    const { gx, gy } = gridOf(index);
    const c = project(layout, gx, gy);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, glow));
    topPath(c);
    ctx.fillStyle = 'rgba(255, 224, 102, 0.25)';
    ctx.fill();
    ctx.shadowColor = HIGHLIGHT_COLOR;
    ctx.shadowBlur = th * 0.5;
    ctx.strokeStyle = HIGHLIGHT_COLOR;
    ctx.lineWidth = Math.max(STYLE.emphasisLine, th * 0.09);
    ctx.lineJoin = 'round';
    topPath(c);
    ctx.stroke();
    ctx.restore();
  }

  function drawDice(c, { values, rolling, bounce }) {
    const size = layout.th * 0.8;
    const { lift = 0, scaleX = 1, scaleY = 1 } = bounce ?? {};
    values.forEach((v, k) => {
      const x = c.x + (k === 0 ? -1 : 1) * size * 0.7;
      const y = c.y;
      ctx.save();
      // 以骰子底边中点为原点缩放，压扁时贴着“地面”
      ctx.translate(x, y + size / 2 - lift * size);
      ctx.scale(scaleX, scaleY);
      ctx.translate(-x, -(y + size / 2));
      ctx.beginPath();
      ctx.roundRect(x - size / 2, y - size / 2, size, size, layout.th * STYLE.radius);
      ctx.save();
      liftShadow(0.6);
      ctx.fillStyle = rolling ? '#fff3c4' : '#ffffff';
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = BOARD_COLORS.outline;
      ctx.lineWidth = STYLE.line;
      ctx.stroke();
      ctx.fillStyle = '#222';
      for (const [px, py] of PIPS[v] ?? []) {
        ctx.beginPath();
        ctx.arc(x + px * size * 0.27, y + py * size * 0.27, size * 0.085, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
  }

  /**
   * @param {number} count 画几栋
   * @param {{ index: number, scale: number, drop: number } | null} [anim] 第 index 栋的缩放和下落量（格高为单位）
   */
  function drawHouses(c, count, anim = null) {
    const { th } = layout;
    const w = th * 0.14;
    const h = th * 0.1;
    ctx.fillStyle = count >= 4 ? '#c0392b' : '#2e8b57';
    for (let k = 0; k < count; k++) {
      const x = c.x + (k - (count - 1) / 2) * th * 0.2;
      const y = c.y + th * 0.2;
      const animated = anim?.index === k;
      if (animated && anim.scale <= 0) continue;
      ctx.save();
      if (animated) {
        // 以房子底边为基准缩放，从上方落下
        const base = y + h / 2;
        ctx.translate(x, base - anim.drop * th);
        ctx.scale(anim.scale, anim.scale);
        ctx.translate(-x, -base);
      }
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
      polygon([
        [x - w * 0.65, y - h / 2],
        [x, y - h * 1.3],
        [x + w * 0.65, y - h / 2],
      ]);
      ctx.fill();
      ctx.restore();
    }
  }

  /** 按特效决定房子的画法：升级时最新一栋弹出，卖建筑时被卖的那栋缩小消失 */
  function drawHousesWithEffect(m, level, fx) {
    if (fx?.kind === 'upgrade' && fx.level === level && level > 0) {
      return drawHouses(m, level, { index: level - 1, scale: easeOutBack(fx.t), drop: (1 - fx.t) * 0.15 });
    }
    if (fx?.kind === 'sell' && fx.level === level) {
      return drawHouses(m, level + 1, { index: level, scale: 1 - fx.t, drop: 0 });
    }
    return drawHouses(m, level);
  }

  /** 格子中心 c 加上网格偏移 (u, v) 后的屏幕坐标 */
  function offset(c, u, v) {
    const { tw, th } = layout;
    return [c.x + ((u - v) * tw) / 2, c.y + ((u + v) * th) / 2];
  }

  /** 顶面菱形 */
  function topPath(c) {
    polygon([offset(c, -HALF, -HALF), offset(c, HALF, -HALF), offset(c, HALF, HALF), offset(c, -HALF, HALF)]);
  }

  /** 所有格子的投影，在画格子之前统一画，压在格子下面 */
  function drawShadows(tiles) {
    const { th, depth } = layout;
    ctx.save();
    ctx.shadowColor = BOARD_COLORS.shadow;
    ctx.shadowBlur = th * 0.35;
    ctx.shadowOffsetY = depth + th * 0.08;
    ctx.fillStyle = BOARD_COLORS.shadow;
    for (const tile of tiles) {
      const { gx, gy } = gridOf(tile.index);
      topPath(project(layout, gx, gy));
      ctx.fill();
    }
    ctx.restore();
  }

  /** 朝外一侧的组色带。[dx, dy] 为朝外的网格方向 */
  function bandPath(c, [dx, dy]) {
    const inner = HALF - BAND;
    // along 沿朝外方向，across 沿格子边
    const at = (along, across) => offset(c, dx * along - dy * across, dy * along + dx * across);
    polygon([at(inner, -HALF), at(HALF, -HALF), at(HALF, HALF), at(inner, HALF)]);
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

    // 顶面：自上而下轻微变暗
    topPath(c);
    const grad = ctx.createLinearGradient(c.x, c.y - hh, c.x, c.y + hh);
    grad.addColorStop(0, shade(top, 1.04));
    grad.addColorStop(1, shade(top, 0.93));
    ctx.fillStyle = grad;
    ctx.fill();
    polygon([offset(c, -HALF, HALF), offset(c, -HALF, -HALF), offset(c, HALF, -HALF)]);
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    const inset = 1.5;
    ctx.moveTo(c.x - hw + inset * 2, c.y);
    ctx.lineTo(c.x, c.y - hh + inset);
    ctx.lineTo(c.x + hw - inset * 2, c.y);
    ctx.strokeStyle = BOARD_COLORS.bevel;
    ctx.lineWidth = Math.max(1, th * 0.03);
    ctx.stroke();
    ctx.restore();

    const out = isProperty ? outwardOf(tile.index) : null;
    const fx = isProperty ? effects.get(tile.id) : null;
    if (out) {
      bandPath(c, out);
      ctx.fillStyle = GROUP_COLORS[tile.group];
      ctx.fill();
      if (fx?.kind === 'buy') {
        bandPath(c, out);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.75 * flash(fx.t)})`;
        ctx.fill();
      }
    }

    // 统一描边：顶面轮廓 + 侧面外轮廓
    ctx.strokeStyle = BOARD_COLORS.outline;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    topPath(c);
    ctx.stroke();
    polygon([
      [c.x - hw, c.y],
      [c.x - hw, c.y + depth],
      [c.x, c.y + hh + depth],
      [c.x + hw, c.y + depth],
      [c.x + hw, c.y],
    ]);
    ctx.stroke();

    if (!isProperty) {
      drawSpecialContent(tile, c);
      return;
    }

    // 内容整体往远离色带的方向挪半个色带宽，避免压到色带
    const [mx, my] = out ? offset(c, (-out[0] * BAND) / 2, (-out[1] * BAND) / 2) : [c.x, c.y];
    const m = { x: mx, y: my };
    fitText(tile.name, m.x, m.y - th * 0.08, th * 0.27, tw * 0.5, BOARD_COLORS.text, 'bold');
    // 记下位置：中央的高楼可能挡住后排格子的名字，画完城市后再补一遍
    names.push({ text: tile.name, x: m.x, y: m.y - th * 0.08 });

    if (!prop?.ownerId) {
      fitText(`${tile.price}`, m.x, m.y + th * 0.17, th * 0.2, tw * 0.36, BOARD_COLORS.subText);
      return;
    }
    drawHousesWithEffect(m, prop.level, fx);
    const ownerIndex = state.players.findIndex((p) => p.id === prop.ownerId);
    const dot = fx?.kind === 'buy' ? Math.max(0, easeOutBack(Math.min(1, fx.t * 1.6))) : 1;
    ctx.beginPath();
    ctx.arc(m.x, m.y - th * 0.3, th * 0.08 * dot, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[ownerIndex] ?? '#999';
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 抵押时遮罩逐渐变深，赎回时逐渐褪去
    const shadeLevel = prop.mortgaged ? (fx?.kind === 'mortgage' ? fx.t : 1) : fx?.kind === 'redeem' ? 1 - fx.t : 0;
    if (shadeLevel > 0) {
      topPath(c);
      ctx.fillStyle = `rgba(70, 70, 70, ${MORTGAGE_ALPHA * shadeLevel})`;
      ctx.fill();
      ctx.save();
      ctx.globalAlpha = shadeLevel;
      fitText('抵押', m.x, m.y + th * 0.17, th * 0.22, tw * 0.36, '#fff', 'bold');
      ctx.restore();
    }
  }

  /** 非地产格：图标在上，名字在下；角格的图标和字更大 */
  function drawSpecialContent(tile, c) {
    const { tw, th } = layout;
    const corner = CORNER_TYPES.includes(tile.type);
    const name = tile.type === 'jail' ? '监狱' : tile.name;
    const iconY = c.y - th * (corner ? 0.13 : 0.11);
    const hasIcon = drawIcon(ctx, tile.type, c.x, iconY, th * (corner ? 0.34 : 0.26), ICON_COLORS[tile.type]);
    const y = hasIcon ? c.y + th * (corner ? 0.18 : 0.15) : c.y;
    fitText(name, c.x, y, th * (corner ? 0.25 : 0.2), tw * (corner ? 0.52 : 0.5), BOARD_COLORS.text, corner ? 'bold' : 'normal');
  }

  /**
   * 同一格停了多枚棋子时，棋子会挡住格子名，在格子上方补一个名牌。
   * 只处理已经停稳的棋子（移动中的不算）。
   */
  function drawStackLabels(board, items) {
    const { tw, th } = layout;
    const counts = new Map();
    for (const it of items) {
      if (it.z !== 0 || !Number.isInteger(it.index)) continue;
      counts.set(it.index, (counts.get(it.index) ?? 0) + 1);
    }
    for (const [index, n] of counts) {
      if (n < 2) continue;
      const tile = board.tiles[index];
      const { gx, gy } = gridOf(index);
      const c = project(layout, gx, gy);
      const name = tile.type === 'jail' ? '监狱' : tile.name;
      const size = th * 0.24;
      ctx.font = `bold ${size}px ${FONT}`;
      const w = Math.min(ctx.measureText(name).width + size, tw * 0.9);
      const h = size * 1.5;
      // 立体棋子比原来的圆片高，名牌放到后排棋子的头顶之上
      const y = c.y - th * 1.05;
      ctx.beginPath();
      ctx.roundRect(c.x - w / 2, y - h / 2, w, h, h / 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
      ctx.strokeStyle = BOARD_COLORS.outline;
      ctx.lineWidth = STYLE.line;
      ctx.stroke();
      fitText(name, c.x, y, size, w - size * 0.6, BOARD_COLORS.text, 'bold');
    }
  }

  /**
   * 立体小兵棋子：底座 + 收腰的身体 + 圆头，座位号写在头上。
   * (x, y) 为落在格子上的点，z 为跳起高度（格高为单位），r 为基准半径。
   */
  function drawPawn(x, y, z, r, color, seat, current) {
    const { th } = layout;
    const lift = z * th;
    const outline = '#2b1d10';

    // 地面上的影子，不随跳起移动，跳得越高越小
    const shrink = 1 / (1 + z * 2);
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.05 * shrink, r * 0.5 * shrink, 0, 0, Math.PI * 2);
    ctx.fillStyle = BOARD_COLORS.shadow;
    ctx.fill();

    const by = y - lift;
    const dark = shade(color, 0.72);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = outline;
    ctx.lineJoin = 'round';

    // 底座：扁圆柱
    ctx.beginPath();
    ctx.ellipse(x, by - r * 0.12, r * 0.95, r * 0.42, 0, 0, Math.PI);
    ctx.lineTo(x - r * 0.95, by - r * 0.32);
    ctx.ellipse(x, by - r * 0.32, r * 0.95, r * 0.42, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x, by - r * 0.32, r * 0.95, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.stroke();

    // 身体：上窄下宽的梯形，左亮右暗
    const top = by - r * 1.5;
    polygon([
      [x - r * 0.62, by - r * 0.34],
      [x - r * 0.3, top],
      [x + r * 0.3, top],
      [x + r * 0.62, by - r * 0.34],
    ]);
    const body = ctx.createLinearGradient(x - r * 0.62, 0, x + r * 0.62, 0);
    body.addColorStop(0, shade(color, 1.12));
    body.addColorStop(1, dark);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.stroke();

    // 头：圆，座位号写在上面（颜色之外的第二种区分方式，名字首字可能相同，如“小红”“小蓝”）
    const hr = r * 0.78;
    const hy = top - hr * 0.7;
    if (current) {
      ctx.beginPath();
      ctx.arc(x, hy, hr + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = outline;
      ctx.lineWidth = 1.2;
    }
    ctx.beginPath();
    ctx.arc(x, hy, hr, 0, Math.PI * 2);
    const head = ctx.createRadialGradient(x - hr * 0.35, hy - hr * 0.4, hr * 0.1, x, hy, hr);
    head.addColorStop(0, shade(color, 1.25));
    head.addColorStop(1, color);
    ctx.fillStyle = head;
    ctx.fill();
    ctx.stroke();
    fitText(String(seat), x, hy + hr * 0.04, hr * 1.25, hr * 1.5, '#1b1b1b', 'bold');
  }

  function drawTokens(state, tokens, currentPlayerId, board) {
    const { tw, th } = layout;
    const r = th * 0.17;
    const items = state.players
      .map((p, i) => ({ p, i, tok: tokens.get(p.id) }))
      .filter(({ p, tok }) => !p.bankrupt && tok)
      .map(({ p, i, tok }) => {
        const base = project(layout, tok.gx, tok.gy);
        const [sx, sy] = TOKEN_SLOTS[i % TOKEN_SLOTS.length];
        // 停稳时记下所在格子，用于同格名牌
        const index = Number.isInteger(tok.gx) && Number.isInteger(tok.gy) ? board.tiles.findIndex((t) => {
          const g = gridOf(t.index);
          return g.gx === tok.gx && g.gy === tok.gy;
        }) : null;
        return { p, i, z: tok.z, index: index >= 0 ? index : null, x: base.x + sx * tw, y: base.y + sy * th };
      })
      .sort((a, b) => a.y - b.y);

    for (const { p, i, x, y, z } of items) {
      drawPawn(x, y, z, r, PLAYER_COLORS[i], i + 1, p.id === currentPlayerId);
    }
    drawStackLabels(board, items);
  }

  function drawFloater({ text, color, gx, gy, rise, alpha, scale = 1 }) {
    const { th } = layout;
    const p = project(layout, gx, gy);
    const y = p.y - th * 0.6 - rise * th;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `bold ${th * 0.34 * scale}px ${FONT}`;
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
   *   focus?: { index: number, glow: number } | null,
   *   effects?: Map<string, { kind: string, level?: number, t: number }>,
   *   viewing?: number | null,
   *   maxLevel?: number,
   *   popup?: { data: object, t: number, toast: boolean } | null,
   *   reducedMotion?: boolean,
   *   view?: { scale: number, ox: number, oy: number },
   * }} scene focus 为落点高亮；effects 为格子特效；viewing 为玩家正在查看的格子；
   *   maxLevel 为地产最高等级（满级时中央显示地标）
   */
  function draw({
    board,
    state = null,
    tokens = null,
    dice = null,
    floaters = [],
    currentPlayerId = null,
    focus = null,
    effects: tileEffects = new Map(),
    viewing = null,
    maxLevel = 4,
    view = { scale: 1, ox: 0, oy: 0 },
    popup = null,
    reducedMotion = false,
  }) {
    effects = tileEffects;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    // 缩放与平移：之后所有绘制都在棋盘坐标里进行
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    drawCenter();
    // 从远到近画，近处格子的侧面盖住远处
    const depthOf = (t) => {
      const { gx, gy } = gridOf(t.index);
      return gx + gy;
    };
    const ordered = [...board.tiles].sort((a, b) => depthOf(a) - depthOf(b));
    drawShadows(ordered);
    // 外圈格子和中央城市地块合在一起按远近画，楼房和格子互相遮挡才正确
    lots ??= cityLots(board);
    const scene = [
      ...ordered.map((tile) => ({ depth: depthOf(tile), draw: () => drawTile(tile, state) })),
      ...(state ? lots.map((lot) => ({ depth: lot.gx + lot.gy, draw: () => city.drawLot(lot, state, maxLevel, effects) })) : []),
    ].sort((a, b) => a.depth - b.depth);
    names = [];
    for (const item of scene) item.draw();
    drawNames();
    if (focus && focus.glow > 0) drawHighlight(focus.index, focus.glow);
    if (viewing !== null) drawViewOutline(viewing);
    drawCenterLabels(state, dice);
    if (state && tokens) drawTokens(state, tokens, currentPlayerId, board);
    for (const f of floaters) drawFloater(f);

    // 结果卡在屏幕坐标里画，不随棋盘缩放，字号固定
    if (popup) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPopup(ctx, { width: cssWidth, height: cssHeight }, popup.data, { ...popup, reducedMotion }, (shape, x, y, owner, size) => {
        const th = size / 1.1;
        createCityPainter(ctx, { tw: th * 2, th }, () => ({ x, y })).drawShape(shape, x, y, owner);
      });
    }
  }

  return {
    resize,
    draw,
    /** 棋盘坐标（未缩放时的 CSS 像素）落在哪个格子顶面上，没有则为 null */
    pickTile: (x, y) => tileAt(layout, x, y),
    /** 网格坐标 → 棋盘坐标，用于镜头跟随棋子 */
    boardPoint: (gx, gy) => project(layout, gx, gy),
    /** 当前格高（CSS 像素），用来判断棋盘上的文字是否太小 */
    get cellHeight() {
      return layout.th;
    },
  };
}
