/**
 * 表现层：非地产格的图标。全部用 Canvas 路径绘制（不依赖图片），任意缩放都清晰。
 * 图标画在屏幕平面上（不做等距变形），保证小尺寸下也容易辨认。
 * 每个函数以 (x, y) 为中心、s 为边长画一个图标。
 */

const FONT = 'system-ui, "Microsoft YaHei", sans-serif';

/** 圆形底 + 居中字符（机会“?”、税“¥”、停车“P”共用） */
function glyph(ctx, x, y, s, color, char, round = true) {
  ctx.beginPath();
  if (round) ctx.arc(x, y, s / 2, 0, Math.PI * 2);
  else ctx.roundRect(x - s / 2, y - s / 2, s, s, s * 0.2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${s * 0.72}px ${FONT}`;
  // 中文字体的数字与符号普遍偏上，略微下移视觉居中
  ctx.fillText(char, x, y + s * 0.04);
}

/** 起点：向前的粗箭头 */
function start(ctx, x, y, s, color) {
  const w = s * 0.55;
  const h = s * 0.5;
  ctx.beginPath();
  ctx.moveTo(x - w, y - h * 0.32);
  ctx.lineTo(x + w * 0.1, y - h * 0.32);
  ctx.lineTo(x + w * 0.1, y - h);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w * 0.1, y + h);
  ctx.lineTo(x + w * 0.1, y + h * 0.32);
  ctx.lineTo(x - w, y + h * 0.32);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** 监狱：方框加三根铁栏 */
function jail(ctx, x, y, s, color) {
  const w = s * 0.8;
  const h = s * 0.8;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.1);
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, s * 0.08);
  for (const k of [-1, 0, 1]) {
    ctx.moveTo(x + (k * w) / 4, y - h / 2);
    ctx.lineTo(x + (k * w) / 4, y + h / 2);
  }
  ctx.stroke();
}

/** 入狱：手铐（两个铐环斜向下垂，中间一节链环相连） */
function handcuffs(ctx, x, y, s, color) {
  const r = s * 0.2;
  const dx = s * 0.32;
  const cy = y + s * 0.12;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.1);
  ctx.beginPath();
  ctx.arc(x - dx, cy, r, 0, Math.PI * 2);
  ctx.moveTo(x + dx + r, cy);
  ctx.arc(x + dx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  // 铐环顶部的锁扣
  for (const k of [-1, 1]) {
    ctx.fillRect(x + k * dx - s * 0.07, cy - r - s * 0.12, s * 0.14, s * 0.12);
  }
  // 链条：两侧短杆 + 中间一节链环
  ctx.lineWidth = Math.max(1, s * 0.07);
  ctx.beginPath();
  ctx.moveTo(x - dx + s * 0.04, cy - r - s * 0.12);
  ctx.lineTo(x - s * 0.1, y - s * 0.3);
  ctx.moveTo(x + dx - s * 0.04, cy - r - s * 0.12);
  ctx.lineTo(x + s * 0.1, y - s * 0.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x, y - s * 0.3, s * 0.1, s * 0.06, 0, 0, Math.PI * 2);
  ctx.stroke();
}

/** 命运：五角星 */
function star(ctx, x, y, s, color) {
  const outer = s * 0.52;
  const inner = outer * 0.45;
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const px = x + r * Math.cos(a);
    const py = y + s * 0.04 + r * Math.sin(a);
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

const ICONS = {
  start,
  jail,
  goToJail: handcuffs,
  fate: star,
  chance: (ctx, x, y, s, color) => glyph(ctx, x, y, s, color, '?'),
  tax: (ctx, x, y, s, color) => glyph(ctx, x, y, s, color, '¥'),
  parking: (ctx, x, y, s, color) => glyph(ctx, x, y, s, color, 'P', false),
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} type 格子类型
 * @returns {boolean} 是否有该类型的图标
 */
export function drawIcon(ctx, type, x, y, s, color) {
  const fn = ICONS[type];
  if (!fn) return false;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  fn(ctx, x, y, s, color);
  ctx.restore();
  return true;
}

export const ICON_TYPES = Object.keys(ICONS);
