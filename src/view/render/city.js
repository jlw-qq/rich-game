/**
 * 表现层：棋盘中央的城市微缩景观。每块地产在中央有一块地，正对外圈的格子：
 * 无主是空地，买下后插上地主的旗，升级后楼房长高，满级变成这座城市的地标。
 * 只读游戏状态，不修改。位置、建筑规格是纯函数，绘制函数只负责画。
 */
import { gridOf, outwardOf } from './layout.js';
import { GROUP_COLORS, PLAYER_COLORS, shade } from './theme.js';
import { easeOutBack } from './easing.js';

/**
 * 中央地块离外圈格子的距离（网格单位）。再大会让角落附近相邻两边的地块重叠（见 city.test.js）。
 */
export const LOT_INSET = 2.2;
/** 地块半边长（网格单位） */
const LOT_HALF = 0.38;
/** 1–3 级楼房高度（格高为单位）；4 级为地标 */
export const LEVEL_HEIGHTS = [0, 0.26, 0.46, 0.66];

/**
 * 满级地标的造型。12 种简化造型，按城市分配；没有列出的城市用摩天楼。
 * 造型只是示意，不追求还原。
 */
export const LANDMARKS = {
  beijing: 'gate', // 城楼
  shanghai: 'tower', // 电视塔
  xian: 'wall', // 城墙
  nanjing: 'wall',
  hangzhou: 'pagoda', // 雷峰塔
  taiyuan: 'pagoda',
  wuhan: 'hall', // 黄鹤楼
  nanchang: 'hall', // 滕王阁
  chongqing: 'bridge',
  lanzhou: 'bridge', // 中山桥
  suzhou: 'pavilion', // 园林
  guiyang: 'pavilion', // 甲秀楼
  kunming: 'peaks', // 石林
  huhehaote: 'stupa', // 白塔
  yinchuan: 'stupa',
  xining: 'temple', // 塔尔寺
  tianjin: 'wheel', // 天津之眼
};
export const LANDMARK_KINDS = ['gate', 'tower', 'wall', 'pagoda', 'hall', 'bridge', 'pavilion', 'peaks', 'stupa', 'temple', 'wheel', 'skyscraper'];

/**
 * 中央地块：每块地产一块，位置在格子朝内 LOT_INSET 处。按远近排序，方便从远到近绘制。
 * @param {{ tiles: readonly object[] }} board
 * @returns {{ tileId: string, index: number, group: string, gx: number, gy: number }[]}
 */
export function cityLots(board) {
  return board.tiles
    .filter((t) => t.type === 'property')
    .map((t) => {
      const { gx, gy } = gridOf(t.index);
      const [dx, dy] = outwardOf(t.index);
      return { tileId: t.id, index: t.index, group: t.group, gx: gx - dx * LOT_INSET, gy: gy - dy * LOT_INSET };
    })
    .sort((a, b) => a.gx + a.gy - (b.gx + b.gy));
}

/**
 * 某块地中央要画什么。
 * @param {{ ownerId: string | null, level: number, mortgaged: boolean }} prop
 * @param {number} maxLevel
 * @param {string} tileId
 * @returns {{ kind: 'empty' } | { kind: 'flag' } | { kind: 'block', height: number } | { kind: 'landmark', shape: string }}
 */
export function buildingSpec(prop, maxLevel, tileId) {
  if (!prop.ownerId) return { kind: 'empty' };
  if (prop.level <= 0) return { kind: 'flag' };
  if (prop.level >= maxLevel) return { kind: 'landmark', shape: LANDMARKS[tileId] ?? 'skyscraper' };
  return { kind: 'block', height: LEVEL_HEIGHTS[prop.level] };
}

/**
 * 地产变化时的生长进度：返回高度倍数（0–约 1.1）。没有特效时为 1。
 * @param {{ kind: string, level?: number, t: number } | undefined} fx
 */
export function growth(fx) {
  if (!fx) return 1;
  if (fx.kind === 'buy' || fx.kind === 'upgrade') return Math.max(0, easeOutBack(fx.t));
  return 1;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ tw: number, th: number }} layout
 * @param {(gx: number, gy: number) => { x: number, y: number }} project
 */
export function createCityPainter(ctx, layout, project) {
  const { tw, th } = layout;
  /** 网格偏移 (u, v) → 屏幕偏移 */
  const off = (u, v) => [((u - v) * tw) / 2, ((u + v) * th) / 2];

  function poly(points) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }

  function fillStroke(color) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.stroke();
  }

  /**
   * 等距长方体。(x, y) 为底面中心，a、b 为沿 gx、gy 的半边长（网格单位），h 为高（像素），z 为离地高度（像素）。
   */
  function box(x, y, a, b, h, color, z = 0) {
    const pt = (u, v, lift) => {
      const [dx, dy] = off(u, v);
      return [x + dx, y + dy - z - lift];
    };
    const N = (l) => pt(-a, -b, l);
    const E = (l) => pt(a, -b, l);
    const S = (l) => pt(a, b, l);
    const W = (l) => pt(-a, b, l);
    poly([W(0), S(0), S(h), W(h)]);
    fillStroke(shade(color, 0.82));
    poly([S(0), E(0), E(h), S(h)]);
    fillStroke(shade(color, 0.64));
    poly([N(h), E(h), S(h), W(h)]);
    fillStroke(color);
    return y - z - h;
  }

  /** 四坡屋顶：底边为 a×b，尖顶高 rh */
  function hipRoof(x, y, a, b, rh, color) {
    const p = (u, v) => {
      const [dx, dy] = off(u, v);
      return [x + dx, y + dy];
    };
    const top = [x, y - rh];
    poly([p(-a, b), p(a, b), top]);
    fillStroke(shade(color, 0.85));
    poly([p(a, b), p(a, -b), top]);
    fillStroke(shade(color, 0.68));
  }

  /** 楼房：每层一道窗带，屋顶涂地主颜色 */
  function block(x, y, h, owner) {
    const a = 0.24;
    const topY = box(x, y, a, a, h, '#efe6d2');
    // 窗带：在两个侧面上画横线
    ctx.save();
    ctx.strokeStyle = 'rgba(60, 80, 110, 0.55)';
    ctx.lineWidth = Math.max(1, th * 0.025);
    for (let k = th * 0.12; k < h - th * 0.04; k += th * 0.14) {
      const [wl, wly] = off(-a, a);
      const [sl, sly] = off(a, a);
      const [el, ely] = off(a, -a);
      ctx.beginPath();
      ctx.moveTo(x + wl * 0.8, y + wly * 0.8 - k + th * 0.02);
      ctx.lineTo(x + sl * 0.9, y + sly * 0.9 - k);
      ctx.lineTo(x + el * 0.8, y + ely * 0.8 - k + th * 0.02);
      ctx.stroke();
    }
    ctx.restore();
    box(x, topY, a * 1.05, a * 1.05, th * 0.05, owner);
  }

  /** 旗：旗杆 + 地主颜色的旗面 */
  function flag(x, y, scale, owner) {
    const h = th * 0.5 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - h);
    ctx.strokeStyle = '#3b2a1a';
    ctx.lineWidth = Math.max(1, th * 0.03);
    ctx.stroke();
    if (scale <= 0.05) return;
    poly([
      [x, y - h],
      [x + tw * 0.14 * scale, y - h + th * 0.07 * scale],
      [x, y - h + th * 0.16 * scale],
    ]);
    ctx.fillStyle = owner;
    ctx.fill();
    ctx.strokeStyle = '#3b2a1a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** 12 种地标，(x, y) 为地块中心，s 为生长倍数 */
  const LANDMARK_PAINTERS = {
    gate(x, y, s, owner) {
      let t = box(x, y, 0.34, 0.2, th * 0.26 * s, '#b5432f');
      t = box(x, t, 0.4, 0.26, th * 0.04, '#d9a21b');
      t = box(x, t, 0.26, 0.14, th * 0.16 * s, '#b5432f');
      hipRoof(x, t, 0.34, 0.2, th * 0.2 * s, owner);
    },
    tower(x, y, s) {
      const h = th * 0.78 * s;
      box(x, y, 0.06, 0.06, h, '#b8b1a5');
      for (const [k, r] of [[0.32, 0.13], [0.7, 0.09]]) {
        ctx.beginPath();
        ctx.arc(x, y - h * k, th * r * s, 0, Math.PI * 2);
        fillStroke('#d660a8');
      }
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x, y - h - th * 0.18 * s);
      ctx.stroke();
    },
    wall(x, y, s, owner) {
      const t = box(x, y, 0.38, 0.12, th * 0.24 * s, '#9a8f80');
      for (const u of [-0.3, -0.1, 0.1, 0.3]) box(x + off(u, 0)[0], t + off(u, 0)[1], 0.05, 0.1, th * 0.05, '#9a8f80');
      const g = box(x, t, 0.12, 0.1, th * 0.14 * s, '#b5432f');
      hipRoof(x, g, 0.16, 0.13, th * 0.12 * s, owner);
    },
    pagoda(x, y, s, owner) {
      let t = y;
      for (let k = 0; k < 5; k++) {
        const a = 0.26 - k * 0.035;
        t = box(x, t, a, a, th * 0.1 * s, '#d8c7a3');
        t = box(x, t, a + 0.07, a + 0.07, th * 0.03, '#6b4a2b');
      }
      hipRoof(x, t, 0.12, 0.12, th * 0.18 * s, owner);
    },
    hall(x, y, s, owner) {
      let t = box(x, y, 0.32, 0.32, th * 0.08, '#cfc3a8');
      for (let k = 0; k < 3; k++) {
        const a = 0.24 - k * 0.05;
        t = box(x, t, a, a, th * 0.13 * s, '#c0392b');
        t = box(x, t, a + 0.1, a + 0.1, th * 0.035, '#d9a21b');
      }
      hipRoof(x, t, 0.14, 0.14, th * 0.16 * s, owner);
    },
    bridge(x, y, s, owner) {
      const h = th * 0.5 * s;
      for (const u of [-0.26, 0.26]) {
        const [dx, dy] = off(u, 0);
        box(x + dx, y + dy, 0.05, 0.06, h, '#8a8f99');
      }
      box(x, y, 0.4, 0.07, th * 0.05, owner, th * 0.18 * s);
      ctx.beginPath();
      for (const u of [-0.26, 0.26]) {
        const [dx, dy] = off(u, 0);
        ctx.moveTo(x + dx, y + dy - h);
        ctx.lineTo(x + dx - Math.sign(u) * tw * 0.12, y + dy - th * 0.2 * s);
        ctx.moveTo(x + dx, y + dy - h);
        ctx.lineTo(x, y - th * 0.22 * s);
      }
      ctx.stroke();
    },
    pavilion(x, y, s, owner) {
      ctx.beginPath();
      ctx.ellipse(x, y, tw * 0.3, th * 0.3, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#7fb3d5';
      ctx.fill();
      const h = th * 0.24 * s;
      for (const [u, v] of [[-0.14, -0.14], [0.14, -0.14], [0.14, 0.14], [-0.14, 0.14]]) {
        const [dx, dy] = off(u, v);
        box(x + dx, y + dy, 0.02, 0.02, h, '#6b4a2b');
      }
      box(x, y, 0.24, 0.24, th * 0.04, '#3f5a3a', h);
      hipRoof(x, y - h - th * 0.04, 0.24, 0.24, th * 0.2 * s, owner);
    },
    peaks(x, y, s) {
      for (const [u, v, h] of [[-0.18, 0.05, 0.55], [0.12, -0.12, 0.8], [0.2, 0.18, 0.45]]) {
        const [dx, dy] = off(u, v);
        const bx = x + dx;
        const by = y + dy;
        poly([[bx - tw * 0.1, by], [bx - tw * 0.02, by - th * h * s], [bx + tw * 0.03, by - th * h * s * 0.9], [bx + tw * 0.1, by]]);
        fillStroke('#9c958a');
      }
    },
    stupa(x, y, s, owner) {
      const t = box(x, y, 0.26, 0.26, th * 0.16 * s, '#e9e4d8');
      ctx.beginPath();
      ctx.ellipse(x, t - th * 0.12 * s, tw * 0.16, th * 0.2 * s, 0, Math.PI, 0);
      ctx.lineTo(x + tw * 0.16, t);
      ctx.lineTo(x - tw * 0.16, t);
      ctx.closePath();
      fillStroke('#f6f2e8');
      const top = t - th * 0.32 * s;
      poly([[x - tw * 0.035, top + th * 0.04], [x, top - th * 0.3 * s], [x + tw * 0.035, top + th * 0.04]]);
      fillStroke(owner);
    },
    temple(x, y, s, owner) {
      let t = box(x, y, 0.36, 0.3, th * 0.18 * s, '#f1ece2');
      t = box(x, t, 0.26, 0.22, th * 0.16 * s, '#f1ece2');
      t = box(x, t, 0.26, 0.22, th * 0.06 * s, '#9b2f2f');
      hipRoof(x, t, 0.14, 0.12, th * 0.14 * s, owner);
    },
    wheel(x, y, s, owner) {
      const r = th * 0.42 * s;
      const cy = y - r - th * 0.08;
      box(x, y, 0.3, 0.08, th * 0.06, '#8a8f99');
      ctx.beginPath();
      ctx.moveTo(x - tw * 0.08, y);
      ctx.lineTo(x, cy);
      ctx.lineTo(x + tw * 0.08, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x, cy, r * 0.9, r, 0, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, th * 0.04);
      ctx.strokeStyle = '#5e6a78';
      ctx.stroke();
      ctx.lineWidth = 1;
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(x, cy);
        ctx.lineTo(x + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r, th * 0.035, 0, Math.PI * 2);
        ctx.fillStyle = owner;
        ctx.fill();
      }
      ctx.strokeStyle = '#3b2a1a';
    },
    skyscraper(x, y, s, owner) {
      let t = box(x, y, 0.2, 0.2, th * 0.55 * s, '#8fb3cf');
      t = box(x, t, 0.14, 0.14, th * 0.18 * s, '#7fa3bf');
      box(x, t, 0.15, 0.15, th * 0.04, owner);
      ctx.beginPath();
      ctx.moveTo(x, t - th * 0.04);
      ctx.lineTo(x, t - th * 0.24 * s);
      ctx.stroke();
    },
  };

  /**
   * 画一块地和上面的建筑。由渲染器和外圈格子一起按远近排序后调用，保证遮挡关系正确。
   * @param {ReturnType<typeof cityLots>[number]} lot
   * @param {{ properties: object, players: object[] }} state
   * @param {number} maxLevel
   * @param {Map<string, { kind: string, level?: number, t: number }>} effects
   */
  function drawLot(lot, state, maxLevel, effects) {
    ctx.save();
    ctx.lineJoin = 'round';
    {
      const prop = state.properties[lot.tileId];
      const { x, y } = project(lot.gx, lot.gy);
      const fx = effects.get(lot.tileId);
      const spec = buildingSpec(prop, maxLevel, lot.tileId);
      const ownerIndex = state.players.findIndex((p) => p.id === prop.ownerId);
      const owner = PLAYER_COLORS[ownerIndex] ?? '#999';

      // 地块底座：组色薄板；无主时半透明，像一块待售空地
      ctx.globalAlpha = spec.kind === 'empty' ? 0.45 : 1;
      ctx.strokeStyle = 'rgba(60, 40, 20, 0.5)';
      ctx.lineWidth = 1;
      box(x, y, LOT_HALF, LOT_HALF, th * 0.05, shade(GROUP_COLORS[lot.group], 1.1));
      ctx.globalAlpha = 1;
      if (spec.kind === 'empty') {
        ctx.restore();
        return;
      }

      // 抵押：建筑变灰；抵押、赎回时渐变
      const grey = prop.mortgaged ? (fx?.kind === 'mortgage' ? fx.t : 1) : fx?.kind === 'redeem' ? 1 - fx.t : 0;
      ctx.save();
      if (grey > 0) {
        ctx.filter = `grayscale(${grey}) opacity(${1 - grey * 0.35})`;
      }
      ctx.strokeStyle = 'rgba(40, 28, 15, 0.6)';
      ctx.lineWidth = 1;
      const baseY = y - th * 0.05;
      const g = growth(fx);
      if (spec.kind === 'flag') {
        flag(x, baseY, g, owner);
      } else if (spec.kind === 'block') {
        // 升级：从上一级的高度长到这一级；卖建筑：从上一级缩到这一级
        let h = spec.height;
        if (fx?.kind === 'upgrade') h = LEVEL_HEIGHTS[prop.level - 1] + (spec.height - LEVEL_HEIGHTS[prop.level - 1]) * g;
        if (fx?.kind === 'sell') h = LEVEL_HEIGHTS[prop.level + 1] ?? spec.height;
        if (fx?.kind === 'sell') h = h + (spec.height - h) * fx.t;
        block(x, baseY, Math.max(th * 0.04, h * th), owner);
      } else {
        LANDMARK_PAINTERS[spec.shape](x, baseY, fx?.kind === 'upgrade' ? g : 1, owner);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /** 在 (x, y) 处单独画一个地标，用于结果卡插画 */
  function drawShape(shape, x, y, owner) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(40, 28, 15, 0.6)';
    ctx.lineWidth = 1;
    box(x, y, LOT_HALF * 1.3, LOT_HALF * 1.3, th * 0.06, '#e9dfc9');
    LANDMARK_PAINTERS[shape](x, y - th * 0.06, 1, owner);
    ctx.restore();
  }

  return { drawLot, drawShape, landmarkKinds: Object.keys(LANDMARK_PAINTERS) };
}
