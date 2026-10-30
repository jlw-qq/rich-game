/**
 * 表现层：关键事件的结果卡（买地、收租、建成地标、破产、交易成交）。
 * describePopup 是纯函数：把事件翻译成卡片内容；drawPopup 负责画。
 */
import { calcRent } from '../../logic/systems/property.js';
import { tradeSideText } from '../ui/format.js';
import { GROUP_HEADERS, PLAYER_COLORS } from './theme.js';
import { LANDMARKS } from './city.js';
import { easeOutBack } from './easing.js';
import { drawLogo } from '../brand.js';

/**
 * 普通对局：结果卡停留时长，期间暂停后续事件。不随播放倍速缩短——倍速只加快掷骰和移动，
 * 关键结果要留出阅读时间；玩家可以点击或按键提前关掉。
 */
export const POPUP_MS = 1200;
/** 观战：不打断流程的小提示条，同样不随倍速缩短 */
export const TOAST_MS = 1500;

/** 地标的中文名，用于“建成某某”的文案 */
export const LANDMARK_NAMES = {
  gate: '城楼',
  tower: '电视塔',
  wall: '古城墙',
  pagoda: '宝塔',
  hall: '名楼',
  bridge: '大桥',
  pavilion: '园林',
  peaks: '石林',
  stupa: '白塔',
  temple: '寺院',
  wheel: '摩天轮',
  skyscraper: '摩天大楼',
};

const yuan = (n) => `¥${n.toLocaleString('zh-CN')}`;

/**
 * @typedef {{
 *   kind: 'buy' | 'rent' | 'landmark' | 'bankrupt' | 'trade' | 'gambleWin' | 'gambleLose',
 *   title: string,
 *   text: string,
 *   tileId: string | null,
 *   group: string | null,
 *   playerIndex: number,
 * }} Popup
 * playerIndex 为这件事的主角（买地的人、收租的人、破产的人），用来给卡片配色。
 */

/**
 * 记住最近一次破产清算的继承人：assetsLiquidated 在 playerBankrupt 之前发出。
 * @returns {(type: string, payload: object, ctx: { state: object, board: object, rules: object }) => Popup | null}
 */
export function createPopupDescriber() {
  let lastHeir = null;

  return function describePopup(type, p, ctx) {
    const { state, board, rules } = ctx;
    const player = (id) => state.players.find((x) => x.id === id);
    const index = (id) => state.players.findIndex((x) => x.id === id);
    const tile = (id) => board.tiles.find((t) => t.id === id);

    switch (type) {
      case 'propertyBought': {
        const t = tile(p.tileId);
        // 规则：其他玩家停在这块地上才付租金（经过不付）
        return {
          kind: 'buy',
          title: `${player(p.playerId).name} 拿下${t.name}！`,
          text: `其他玩家停在这里需付 ${yuan(calcRent(ctx, t.id))}`,
          tileId: t.id,
          group: t.group,
          playerIndex: index(p.playerId),
        };
      }
      case 'paymentMade': {
        if (p.reason?.type !== 'rent' || p.payeeIds.length === 0) return null;
        const t = tile(p.reason.tileId);
        return {
          kind: 'rent',
          title: `${t.name} 收租`,
          text: `${player(p.payerId).name} 付给 ${player(p.payeeIds[0]).name} ${yuan(p.amount)}`,
          tileId: t.id,
          group: t.group,
          playerIndex: index(p.payeeIds[0]),
        };
      }
      case 'propertyUpgraded': {
        if (p.level < rules.maxLevel) return null;
        const t = tile(p.tileId);
        const shape = LANDMARKS[t.id] ?? 'skyscraper';
        return {
          kind: 'landmark',
          title: `${t.name}建成${LANDMARK_NAMES[shape]}！`,
          text: `租金涨到 ${yuan(calcRent(ctx, t.id))}`,
          tileId: t.id,
          group: t.group,
          playerIndex: index(p.playerId),
        };
      }
      case 'gambleRolled': {
        const card = ctx.cards?.find((c) => c.id === p.cardId);
        return {
          kind: p.won ? 'gambleWin' : 'gambleLose',
          title: `${card?.title ?? '城市事件'}：掷出 ${p.total} 点`,
          text: p.won ? `成功！${player(p.playerId).name} 获得 ${yuan(p.amount)}` : `没到 ${p.target} 点，${player(p.playerId).name} 损失 ${yuan(p.amount)}`,
          tileId: null,
          group: null,
          playerIndex: index(p.playerId),
        };
      }
      case 'assetsLiquidated':
        lastHeir = { debtorId: p.debtorId, heirId: p.heirId, count: p.properties.length };
        return null;
      case 'playerBankrupt': {
        const heir = lastHeir?.debtorId === p.playerId ? lastHeir : null;
        lastHeir = null;
        const assets = !heir || heir.count === 0 ? '' : heir.heirId ? `，地产归 ${player(heir.heirId).name}` : '，地产收归银行';
        return {
          kind: 'bankrupt',
          title: `${player(p.playerId).name} 破产了`,
          text: `退出本局${assets}`,
          tileId: null,
          group: null,
          playerIndex: index(p.playerId),
        };
      }
      case 'tradeAccepted': {
        const tr = p.trade;
        return {
          kind: 'trade',
          title: '交易成交',
          text: `${player(tr.fromId).name} 用「${tradeSideText(tr.give, board)}」换来「${tradeSideText(tr.take, board)}」`,
          tileId: null,
          group: null,
          playerIndex: index(tr.fromId),
        };
      }
      default:
        return null;
    }
  };
}

/**
 * 结果卡的缩放与透明度：开头回弹放大，结尾淡出。
 * @param {number} t 进度 0–1
 * @param {boolean} reducedMotion 减少动态效果时不缩放，只在结尾淡出
 */
export function popupMotion(t, reducedMotion = false) {
  const alpha = t > 0.8 ? Math.max(0, (1 - t) / 0.2) : 1;
  if (reducedMotion) return { scale: 1, alpha };
  const scale = t < 0.25 ? 0.6 + 0.4 * easeOutBack(t / 0.25) : 1;
  return { scale, alpha };
}

const FONT = 'system-ui, "Microsoft YaHei", sans-serif';

/**
 * 画结果卡。坐标为画布 CSS 像素，不随棋盘缩放，字号固定，小屏也能读清。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width: number, height: number }} canvas
 * @param {Popup} popup
 * @param {{ t: number, toast: boolean, reducedMotion: boolean }} progress toast 为观战模式的小提示条
 * @param {(shape: string, x: number, y: number, owner: string, size: number) => void} drawLandmark 画城市插画
 */
export function drawPopup(ctx, { width, height }, popup, { t, toast, reducedMotion }, drawLandmark) {
  const accent = popup.group ? GROUP_HEADERS[popup.group] : { bg: PLAYER_COLORS[popup.playerIndex] ?? '#6b5a48', text: '#1b1b1b' };
  const owner = PLAYER_COLORS[popup.playerIndex] ?? '#999';
  const { scale, alpha } = popupMotion(t, reducedMotion);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (toast) {
    // 观战模式：棋盘上方的一条小提示，不遮挡城市
    const w = Math.min(width - 24, 420);
    const h = 34;
    const x = (width - w) / 2;
    const y = 10;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(251, 246, 234, 0.95)';
    ctx.shadowColor = 'rgba(60, 35, 10, 0.35)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.arc(x + h / 2, y + h / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle = accent.bg;
    ctx.fill();
    fitLine(ctx, `${popup.title}  ${popup.text}`, width / 2 + 8, y + h / 2, 14, w - h - 16, '#2b2118', 'bold');
    ctx.restore();
    return;
  }

  const w = Math.min(width * 0.62, 380);
  const art = popup.tileId ? Math.min(110, height * 0.28) : 0;
  const h = art + 112;
  const cx = width / 2;
  const cy = height / 2;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  const left = -w / 2;
  const top = -h / 2;

  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 14);
  ctx.fillStyle = '#fbf6ea';
  ctx.shadowColor = 'rgba(60, 35, 10, 0.45)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(60, 40, 20, 0.45)';
  ctx.stroke();

  // 上半部分：组色底 + 城市插画
  if (art > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, top, w, art, [14, 14, 0, 0]);
    ctx.clip();
    ctx.fillStyle = accent.bg;
    ctx.fillRect(left, top, w, art);
    const shape = LANDMARKS[popup.tileId] ?? 'skyscraper';
    drawLandmark(shape, 0, top + art * 0.86, owner, art * 0.62);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.roundRect(left, top, w, 10, [14, 14, 0, 0]);
    ctx.fillStyle = accent.bg;
    ctx.fill();
  }

  // 金币：买地、收租、建成地标时从卡片中间往上撒
  if (!reducedMotion && ['buy', 'rent', 'landmark', 'gambleWin'].includes(popup.kind) && t < 0.7) {
    for (let k = 0; k < 7; k++) {
      const a = -Math.PI / 2 + (k - 3) * 0.32;
      const d = (t / 0.7) * (60 + (k % 3) * 18);
      const x = Math.cos(a) * d;
      const y = top + art + Math.sin(a) * d + (t / 0.7) ** 2 * 40;
      // 飞行的前三分之二保持不透明，最后一段才淡出（半透明的黄色叠在组色上会发灰）
      ctx.globalAlpha = alpha * Math.min(1, (1 - t / 0.7) * 3);
      // 翻转的金币：侧面时也保留一定厚度，不会缩成一条暗线
      const ry = 7 * (0.35 + 0.65 * Math.abs(Math.cos(t * 14 + k)));
      ctx.beginPath();
      ctx.ellipse(x, y, 7, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffc928';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#c98a00';
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x - 2, y - ry * 0.3, 2.2, ry * 0.3, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
  }

  // 左上角的游戏标志，让结果卡带上这款游戏的记号
  drawLogo(ctx, left + 22, top + 22, 30);

  const textTop = top + (art || 10);
  fitLine(ctx, popup.title, 0, textTop + 32, 20, w - 28, '#2b2118', 'bold');
  fitLine(ctx, popup.text, 0, textTop + 64, 15, w - 28, '#5e4d3b', 'normal');
  fitLine(ctx, '点击或按任意键继续', 0, textTop + 90, 12, w - 28, '#6b5a48', 'normal');
  ctx.restore();
}

/** 写一行居中文字，超出 maxWidth 时缩小字号 */
function fitLine(ctx, text, x, y, size, maxWidth, color, weight) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxWidth) ctx.font = `${weight} ${Math.max(10, (size * maxWidth) / w)}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
