/**
 * 表现层：Canvas 2D 绘制 2.5D 棋盘。只读游戏状态，不修改。
 */
import { computeLayout, gridOf, outwardOf, project, tileAt, TILE_SCALE } from './layout.js';
import { BOARD_COLORS, GROUP_COLORS, GROUP_HEADERS, ICON_COLORS, PLAYER_COLORS, STYLE, TILE_COLORS, shade } from './theme.js';
import { drawIcon } from './icons.js';
import { easeOutBack, flash } from './easing.js';

const FONT = 'system-ui, "Microsoft YaHei", sans-serif';
const CORNER_TYPES = ['start', 'jail', 'parking', 'goToJail'];
/** 顶面半边长（网格单位） */
const HALF = TILE_SCALE / 2;
/** 地产组色带的宽度（网格单位），画在格子朝外的一侧 */
const BAND = 0.2;
/** 中央纹理的格距（网格单位）和透明度 */
const TEXTURE_STEP = 0.5;
const TEXTURE_ALPHA = 0.06;
/** 抵押遮罩的最终不透明度 */
const MORTGAGE_ALPHA = 0.55;
/** 查看中的格子描边颜色（与落点的金色区分） */
const VIEW_COLOR = '#ffffff';
/** 落点高亮颜色 */
const HIGHLIGHT_COLOR = '#ffe066';
/** 地产卡片尺寸：宽以格宽为单位，各行高以格高为单位 */
const CARD_WIDTH = 3;
const CARD_HEADER = 0.6;
const CARD_ROW = 0.58;
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
  function drawCenter(state, dice) {
    const { th } = layout;
    centerPath();
    ctx.fillStyle = BOARD_COLORS.center;
    ctx.fill();

    ctx.save();
    centerPath();
    ctx.clip();
    ctx.strokeStyle = `rgba(255, 255, 255, ${TEXTURE_ALPHA})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = CENTER_MIN + TEXTURE_STEP; g < CENTER_MAX; g += TEXTURE_STEP) {
      const a = project(layout, g, CENTER_MIN);
      const b = project(layout, g, CENTER_MAX);
      const c = project(layout, CENTER_MIN, g);
      const d = project(layout, CENTER_MAX, g);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();

    // 内阴影：沿边缘画一圈带模糊的粗描边，裁剪后只剩区域内的部分
    centerPath();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = th * 0.6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = th * 0.25;
    ctx.stroke();
    ctx.restore();

    centerPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const c = project(layout, 5, 5);
    ctx.save();
    liftShadow(0.5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.font = `bold ${th * 0.9}px ${FONT}`;
    ctx.fillText('大富翁', c.x, c.y - th * 2.6);
    ctx.restore();
    if (dice) drawDice({ x: c.x, y: c.y - th * 1.3 }, dice);
    if (state) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.font = `${th * 0.34}px ${FONT}`;
      ctx.fillText(`第 ${state.round} 轮`, c.x, c.y - th * 0.45);
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

  /** 左对齐或右对齐写一行字，超出 maxWidth 时缩小字号 */
  function alignedText(text, x, y, size, maxWidth, color, align, weight = 'normal') {
    ctx.save();
    ctx.textAlign = align;
    fitText(text, x, y, size, maxWidth, color, weight);
    ctx.restore();
  }

  /**
   * 地产卡片，画在中央区域下半部分，不挡格子。
   * @param {import('./tileCard.js').TileCard} card
   */
  function drawCard(card, label, compact) {
    const { tw, th } = layout;
    const c = project(layout, 5, 5);
    const w = CARD_WIDTH * tw;
    // 紧凑模式（小画布）只画标题栏，详细信息在侧栏
    const h = (compact ? CARD_HEADER : CARD_HEADER + CARD_ROW * 3 + 0.12) * th;
    const left = c.x - w / 2;
    const top = c.y + th * 0.15;
    const pad = tw * 0.12;
    const radius = th * STYLE.radius;
    const header = GROUP_HEADERS[card.group];

    ctx.save();
    liftShadow();
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, radius);
    ctx.fillStyle = TILE_COLORS.property;
    ctx.fill();
    ctx.restore();

    // 组色标题栏
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, radius);
    ctx.clip();
    ctx.fillStyle = header.bg;
    ctx.fillRect(left, top, w, CARD_HEADER * th);
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, radius);
    ctx.strokeStyle = BOARD_COLORS.outline;
    ctx.lineWidth = STYLE.line;
    ctx.stroke();

    const size = th * 0.27;
    const half = w / 2 - pad * 1.5;
    const headerText = header.text;
    fitText(card.name, c.x, top + (CARD_HEADER * th) / 2, th * 0.36, w * 0.56, headerText, 'bold');
    if (label) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      alignedText(label, left + w - pad, top + (CARD_HEADER * th) / 2, th * 0.22, w * 0.18, headerText, 'right');
      ctx.restore();
    }
    if (compact) return;

    const row = (k) => top + (CARD_HEADER + CARD_ROW * (k + 0.5)) * th;
    const num = (n) => `¥${n.toLocaleString('zh-CN')}`;
    const xl = left + pad;
    const xr = left + w - pad;

    // 第 1 行：售价 | 租金
    alignedText(`售价 ${num(card.price)}`, xl, row(0), size, half, BOARD_COLORS.text, 'left');
    const rentText = card.mortgaged ? '已抵押，免租' : `${card.owner ? '租金' : '空地租金'} ${num(card.rent)}`;
    alignedText(rentText, xr, row(0), size, half, card.mortgaged ? '#a33b3b' : BOARD_COLORS.text, 'right', 'bold');

    // 第 2 行：所有者 | 整组翻倍
    if (card.owner) {
      const r = th * 0.1;
      ctx.beginPath();
      ctx.arc(xl + r, row(1), r, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_COLORS[card.owner.index] ?? '#999';
      ctx.fill();
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1;
      ctx.stroke();
      alignedText(card.owner.name, xl + r * 2.8, row(1), size, half - r * 2.8, BOARD_COLORS.text, 'left');
    } else {
      alignedText('无主 · 可购买', xl, row(1), size, half, BOARD_COLORS.subText, 'left');
    }
    if (card.groupBonus) alignedText('整组租金 ×2', xr, row(1), size, half, '#2f7d4a', 'right', 'bold');

    // 第 3 行：建筑等级（实心为已建）| 下一级租金
    const hs = th * 0.2;
    for (let k = 0; k < card.maxLevel; k++) {
      const x = xl + hs / 2 + k * hs * 1.35;
      const y = row(2);
      polygon([
        [x - hs / 2, y + hs / 2],
        [x - hs / 2, y - hs * 0.05],
        [x, y - hs / 2],
        [x + hs / 2, y - hs * 0.05],
        [x + hs / 2, y + hs / 2],
      ]);
      if (k < card.level) {
        ctx.fillStyle = card.level >= card.maxLevel ? '#c0392b' : '#2e8b57';
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    const nextText = card.nextRent === null ? '已满级' : `下一级 ${num(card.nextRent)}`;
    alignedText(nextText, xr, row(2), size, half, BOARD_COLORS.subText, 'right');
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
   *   card?: import('./tileCard.js').TileCard | null,
   *   effects?: Map<string, { kind: string, level?: number, t: number }>,
   *   viewing?: number | null,
   *   cardLabel?: string | null,
   *   compactCard?: boolean,
   * }} scene focus 为落点高亮；card 为中央显示的地产卡片，cardLabel 为卡片角标；
   *   effects 为格子特效；viewing 为玩家正在查看的格子
   */
  function draw({
    board,
    state = null,
    tokens = null,
    dice = null,
    floaters = [],
    currentPlayerId = null,
    focus = null,
    card = null,
    effects: tileEffects = new Map(),
    viewing = null,
    cardLabel = null,
    compactCard = false,
  }) {
    effects = tileEffects;
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
    const ordered = [...board.tiles].sort((a, b) => depthOf(a) - depthOf(b));
    drawShadows(ordered);
    for (const tile of ordered) drawTile(tile, state);
    if (focus && focus.glow > 0) drawHighlight(focus.index, focus.glow);
    if (viewing !== null) drawViewOutline(viewing);
    if (card) drawCard(card, cardLabel, compactCard);
    if (state && tokens) drawTokens(state, tokens, currentPlayerId);
    for (const f of floaters) drawFloater(f);
  }

  return {
    resize,
    draw,
    /** 画布上的点（CSS 像素）落在哪个格子顶面上，没有则为 null */
    pickTile: (x, y) => tileAt(layout, x, y),
  };
}
